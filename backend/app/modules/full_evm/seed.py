# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Demo seed for the earned-value baseline and its measurements.

The module shipped without a seeder, so ``/full-evm`` opened on "this project
has no baseline" on every install. Two steps of the cost-control walkthrough
land on that screen - the one where the plan is frozen and the one where the
forecast is read - so an empty baseline table takes out the beginning and the
end of the story at once.

What a reader sees afterwards, per demo project: one approved baseline with an
eighteen-month cumulative planned-value curve, and six monthly measurements
ending with the month in progress, each carrying the full metric set with the
forecast derived rather than asserted.

Three things are deliberate.

The metrics are computed by the module's own ``compute_metrics`` rather than
written out here. A seeder that hand-writes a CPI can write one that does not
follow from its own EV and AC, and a demo whose arithmetic does not close is
worse than a demo with no numbers in it.

The budget, the packages and the monthly profile come from
``app.core.demo_commercial``, the same place the reconciliation register reads.
The actual cost recorded here is the identical sum the reconciliation shows as
cost to date, because a viewer walks from one screen to the other and the two
have to be the same job.

Validation is left as the engine found it: ``pending``, with no findings and no
score. Stamping a baseline "passed" without running the rule set would be
inventing an approval, which is the same class of defect as an auto-applied
suggestion.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.demo_commercial import (
    CURRENT_INDEX,
    HEADS,
    MONTH_WEIGHTS,
    actual_progress,
    bill_total,
    budget_share_total,
    completion,
    is_demo_project,
    month_end,
    planned_progress,
    shift_month,
)
from app.modules.full_evm.metrics import compute_metrics, quantize_money
from app.modules.full_evm.models import EVMBaseline, EVMBaselinePeriod, EVMMeasure

logger = logging.getLogger(__name__)

# Marker written on every row this seeder creates.
_SEED_MARK = "full-evm-demo"

# The months a measurement is taken for: the half-year up to and including the
# month in progress. Six points is enough for a trend line to have a shape and
# short enough that the newest figure is still the one a reader looks at.
_MEASURE_INDICES: tuple[int, ...] = (6, 7, 8, 9, 10, 11)

# The forecast formula the demo asks for. "cpi" is the one a commercial
# manager defends in a meeting - it says the rest of the job will cost what the
# job so far has cost - and it is the only one that makes the overrun visible
# in the outturn rather than only in the variance column.
_EAC_METHOD = "cpi"

_BASELINE_NAME_DE = "Basisplan Ausführung"
_BASELINE_NAME_EN = "Execution baseline"

_BASELINE_NOTE_DE = (
    "Eingefrorener Soll-Stand der Ausführungsplanung. Die Plankurve ist kumuliert "
    "und folgt dem Mittelabfluss der Bauzeit; Fortschritt und Ist-Kosten werden "
    "monatlich gegen diesen Stand gemessen."
)
_BASELINE_NOTE_EN = (
    "Frozen construction budget. The curve is cumulative and follows the spend "
    "profile of the build programme; progress and actual cost are measured "
    "against it month by month."
)


def _period_label(day: date) -> str:
    """The curve's own name for a month, e.g. ``2026-M05``."""
    return f"{day.year:04d}-M{day.month:02d}"


def _money(value: Decimal) -> Decimal:
    """Round an observation to the cent before anything is derived from it.

    The metric engine quantizes each figure it returns, but it derives the
    variances from the raw inputs, so ``sv`` is the rounded difference while
    ``ev`` and ``pv`` are two separately rounded numbers. Feed it thirds of a
    cent and the stored ``sv`` misses the stored ``ev - pv`` by a cent, which
    is a register that visibly does not add up. Rounding on the way in costs
    nothing - a measurement is taken in money, not in fractions of a cent - and
    it makes every identity on the row hold exactly.

    ``quantize_money`` answers ``None`` only for ``None``, which never reaches
    here; the fallback exists so the return type stays a plain ``Decimal``.
    """
    rounded = quantize_money(value)
    return Decimal("0") if rounded is None else rounded


def _budgeted_cost(contract_value: Decimal) -> Decimal:
    """Budget at completion: the cost side of the priced bill.

    The bill is what the job sells for; the budget is what it was priced to
    cost. Using the bill itself as the budget would report every job as
    finishing under budget by exactly its own margin.
    """
    return _money(contract_value * budget_share_total())


def _earned_and_actual(contract_value: Decimal, overall: Decimal) -> tuple[Decimal, Decimal]:
    """Earned value and actual cost at a point in the job.

    Earned value is the budgeted cost of the packages completed so far; actual
    cost is what those same packages have really cost, which is the budgeted
    figure carrying each package's own overrun. Summed package by package with
    the same expression the reconciliation uses for cost to date, so the two
    screens report the same money rather than two estimates of it.
    """
    earned = Decimal("0")
    actual = Decimal("0")
    for head in HEADS:
        done = completion(head, overall)
        budgeted = contract_value * head.budget_share() * done
        earned += budgeted
        actual += budgeted * head.drift
    return _money(earned), _money(actual)


def _build_baseline(
    *,
    project_id: uuid.UUID,
    contract_value: Decimal,
    currency: str,
    owner_id: uuid.UUID | None,
    german: bool,
    today: date,
) -> tuple[EVMBaseline, list[EVMBaselinePeriod]]:
    """The approved baseline and its cumulative planned-value curve."""
    bac = _budgeted_cost(contract_value)
    start = shift_month(today, -CURRENT_INDEX)
    finish = month_end(shift_month(today, len(MONTH_WEIGHTS) - 1 - CURRENT_INDEX))

    baseline = EVMBaseline(
        id=uuid.uuid4(),
        project_id=project_id,
        name=_BASELINE_NAME_DE if german else _BASELINE_NAME_EN,
        description=_BASELINE_NOTE_DE if german else _BASELINE_NOTE_EN,
        # Exactly one approved baseline per project. Moving a previous one to
        # "superseded" is the service's job, and this seeder writes rows past
        # the service, so it must never create the second row that would need
        # superseding.
        status="approved",
        bac=bac,
        currency=currency,
        minor_units=2,
        start_date=start,
        finish_date=finish,
        approved_by=owner_id,
        approved_at=datetime.now(UTC),
        metadata_={"seed": _SEED_MARK},
    )

    periods: list[EVMBaselinePeriod] = []
    for index in range(len(MONTH_WEIGHTS)):
        month = shift_month(today, index - CURRENT_INDEX)
        # Cumulative, not the amount planned within the month. The module's own
        # monotonicity rule exists because writing the per-period amount into
        # this column is the commonest way to get a curve wrong.
        periods.append(
            EVMBaselinePeriod(
                id=uuid.uuid4(),
                baseline_id=baseline.id,
                ordinal=index,
                period_end=month_end(month),
                label=_period_label(month),
                planned_value=_money(bac * planned_progress(index)),
                planned_quantity=None,
            )
        )
    return baseline, periods


def _build_measures(
    *,
    baseline: EVMBaseline,
    project_id: uuid.UUID,
    contract_value: Decimal,
    currency: str,
    today: date,
) -> list[EVMMeasure]:
    """One measurement per month, with every derived figure computed, not stated."""
    bac = _budgeted_cost(contract_value)
    measures: list[EVMMeasure] = []

    for index in _MEASURE_INDICES:
        month = shift_month(today, index - CURRENT_INDEX)
        earned, actual = _earned_and_actual(contract_value, actual_progress(index))
        metrics = compute_metrics(
            bac=bac,
            pv=_money(bac * planned_progress(index)),
            ev=earned,
            ac=actual,
            method=_EAC_METHOD,
        )
        measure = EVMMeasure(
            id=uuid.uuid4(),
            baseline_id=baseline.id,
            project_id=project_id,
            data_date=month_end(month),
            source="manual",
            currency=currency,
            bac=metrics.bac,
            pv=metrics.pv,
            ev=metrics.ev,
            ac=metrics.ac,
            sv=metrics.sv,
            cv=metrics.cv,
            spi=metrics.spi,
            cpi=metrics.cpi,
            percent_complete=metrics.percent_complete,
            percent_spent=metrics.percent_spent,
            eac_method=metrics.eac_method_requested,
            eac_method_effective=metrics.eac_method_effective,
            eac=metrics.eac,
            etc_=metrics.etc,
            vac=metrics.vac,
            tcpi_bac=metrics.tcpi_bac,
            tcpi_eac=metrics.tcpi_eac,
            eac_variants={name: None if value is None else str(value) for name, value in metrics.eac_variants.items()},
            metadata_={"seed": _SEED_MARK},
        )
        measures.append(measure)
    return measures


async def _seed_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    currency: str,
    owner_id: uuid.UUID | None,
    *,
    german: bool,
    today: date,
) -> dict[str, int]:
    """Write one project's baseline, or nothing when it has no priced bill."""
    counts = {"projects": 0, "baselines": 0, "periods": 0, "measures": 0}

    contract_value = await bill_total(session, project_id)
    if contract_value <= 0:
        logger.debug("EVM demo seed skipped for project=%s: no priced bill", project_id)
        return counts

    baseline, periods = _build_baseline(
        project_id=project_id,
        contract_value=contract_value,
        currency=currency,
        owner_id=owner_id,
        german=german,
        today=today,
    )
    measures = _build_measures(
        baseline=baseline,
        project_id=project_id,
        contract_value=contract_value,
        currency=currency,
        today=today,
    )

    session.add(baseline)
    await session.flush()
    session.add_all(periods)
    session.add_all(measures)
    await session.flush()

    counts["projects"] = 1
    counts["baselines"] = 1
    counts["periods"] = len(periods)
    counts["measures"] = len(measures)
    return counts


async def seed_full_evm_demo(
    session: AsyncSession,
    project_ids: Iterable[uuid.UUID],
    *,
    today: date | None = None,
) -> dict[str, int]:
    """Populate the earned-value baseline and measurements for the demo projects.

    Args:
        session: Async DB session. The caller commits.
        project_ids: Projects to consider - every one of them, never a first
            few. A project is seeded only when it belongs to the demo estate,
            carries a currency and a priced bill, and holds no baseline yet.
        today: The day the register is struck against. Defaults to the real
            date; a test passes a fixed one so the periods are predictable.

    Returns:
        Dict with per-entity insert counts across every project seeded.
    """
    totals = {"projects": 0, "baselines": 0, "periods": 0, "measures": 0}
    ids = list(project_ids)
    if not ids:
        return totals

    from app.modules.projects.models import Project

    anchor = today or date.today()

    rows = (
        await session.execute(
            select(Project.id, Project.currency, Project.locale, Project.owner_id, Project.metadata_).where(
                Project.id.in_(ids)
            ),
        )
    ).all()
    known = {
        pid: (str(ccy or "").strip().upper()[:3], str(loc or ""), owner, meta) for pid, ccy, loc, owner, meta in rows
    }

    # Projects that already hold a baseline. Per project rather than a
    # table-wide count: a user who freezes one plan must not stop the seed
    # reaching the projects that are still empty.
    seeded = set(
        (await session.execute(select(EVMBaseline.project_id).where(EVMBaseline.project_id.in_(ids)).distinct()))
        .scalars()
        .all()
    )

    for project_id in ids:
        found = known.get(project_id)
        if found is None:
            continue
        currency, locale, owner_id, metadata = found
        if project_id in seeded or not is_demo_project(metadata):
            continue
        # No silent currency. The baseline's own column calls the code a label
        # and assumes nothing; a seeder that fills it in with a guess is where
        # the assumption would enter.
        if not currency:
            logger.debug("EVM demo seed skipped for project=%s: no currency", project_id)
            continue
        try:
            # A SAVEPOINT per project: on PostgreSQL a failed statement aborts
            # the whole transaction, so without one a single bad project takes
            # every later project down with it.
            async with session.begin_nested():
                counts = await _seed_project(
                    session,
                    project_id,
                    currency,
                    owner_id,
                    german=locale.lower().startswith("de"),
                    today=anchor,
                )
        except Exception:
            logger.warning("EVM demo seed skipped for project=%s (non-fatal)", project_id, exc_info=True)
            continue
        for key, value in counts.items():
            totals[key] += value
    return totals


__all__ = ["seed_full_evm_demo"]
