# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Demo seed for the cost-value reconciliation register.

The module shipped without any seeder at all, so ``/projects/:id/cvr`` opened
on three empty states in a row on every install, including the reference
project. Nothing on that screen is computed on read - the reports, the cashflow
curve and the payment applications are all stored rows - so an empty database
means an empty screen rather than a screen that fills itself in.

What a reader sees afterwards, per demo project: three consecutive closed
months plus the month in progress, each reconciling six cost heads, so the
margin can be read moving rather than as a single figure with nothing to
compare it to. Under that, an eighteen-month cashflow curve running from
eleven months back to six months ahead, and the interim payment applications
raised against the closed months, one of them still awaiting certification.

The job itself - what it is made of, how its money is spent, which package is
overrunning - is not decided here. It comes from ``app.core.demo_commercial``,
which the earned-value seeder reads too, because a viewer walks from this
screen straight to that one and takes them for two views of one job.

The register is scaled from the project's own priced bill rather than from a
number invented here: that is the figure the cost-model screen totals and the
one a viewer will cross-check. A project with no priced bill is skipped rather
than given a made-up contract value.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.demo_commercial import (
    CURRENT_INDEX,
    HEADS,
    MONTH_WEIGHTS,
    actual_progress,
    bill_total,
    completion,
    forecast_margin,
    is_demo_project,
    shift_month,
)
from app.modules.cvr.compute import net_of_retention, q2
from app.modules.cvr.models import CashflowPoint, CvrLine, CvrReport, PaymentApplication

logger = logging.getLogger(__name__)

# Marker written on every row this seeder creates. The guard reads reports
# only - a project whose CVR register has been opened at all is left alone.
_SEED_MARK = "cvr-demo"

# Retention withheld from an interim application. Five per cent is the
# customary Sicherheitseinbehalt on a German building contract and the
# commonest figure elsewhere too, so it needs no per-region table.
_RETENTION_RATE = Decimal("0.05")

# Cost incurred and not yet invoiced, as a share of cost to date. A CVR with
# no accruals column in use is a CVR that has not been struck properly.
_ACCRUAL_RATE = Decimal("0.04")

# The months a CVR is struck for: the three closed ones and the one running.
# Only the running month is a draft.
_REPORT_INDICES: tuple[int, ...] = (8, 9, 10, 11)

_MONTHS_DE = (
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
)
_MONTHS_EN = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

# Where each application has got to. The oldest is money in the bank, the
# newest is still with the client, so the register shows the lifecycle rather
# than one status repeated four times.
_APPLICATION_STATUSES = ("paid", "paid", "certified", "submitted")


def _period_label(day: date, german: bool) -> str:
    """The month named the way the project's own documents name it."""
    names = _MONTHS_DE if german else _MONTHS_EN
    return f"{names[day.month - 1]} {day.year}"


def _report_title(day: date, german: bool) -> str:
    if german:
        return f"Kosten-Wert-Abgleich {_period_label(day, german=True)}"
    return f"Cost-value reconciliation {_period_label(day, german=False)}"


def _report_notes(*, german: bool, final: bool) -> str:
    if german and final:
        return (
            "Monatsabschluss. Leistungsstand aus der Baustellenaufnahme, Kosten aus "
            "Buchhaltung und Obligo, Abgrenzungen für erbrachte, noch nicht "
            "abgerechnete Leistungen."
        )
    if german:
        return "Laufender Monat, noch nicht abgeschlossen. Werte werden bis zum Monatsende fortgeschrieben."
    if final:
        return (
            "Month-end close. Value from the site measure, cost from the ledger and "
            "committed spend, accruals for work done and not yet invoiced."
        )
    return "Month in progress. Figures are carried forward until the month closes."


def _cashflow_label(*, german: bool, forecast: bool) -> str:
    if german:
        return "Prognose" if forecast else "Ist"
    return "Forecast" if forecast else "Actual"


def _seed_reports(
    *,
    project_id: uuid.UUID,
    contract_value: Decimal,
    currency: str,
    owner_id: uuid.UUID | None,
    german: bool,
    today: date,
) -> tuple[list[CvrReport], list[CvrLine], list[PaymentApplication]]:
    """Build the reports, their lines and the applications raised against them."""
    reports: list[CvrReport] = []
    lines: list[CvrLine] = []
    applications: list[PaymentApplication] = []
    created_by = str(owner_id) if owner_id else None

    for ordinal, index in enumerate(_REPORT_INDICES):
        month = shift_month(today, index - CURRENT_INDEX)
        period = f"{month.year:04d}-{month.month:02d}"
        final = index != CURRENT_INDEX
        overall = actual_progress(index)

        report = CvrReport(
            id=uuid.uuid4(),
            project_id=project_id,
            period=period,
            title=_report_title(month, german),
            status="final" if final else "draft",
            currency=currency,
            notes=_report_notes(german=german, final=final),
            created_by=created_by,
            metadata_={"seed": _SEED_MARK, "completion": str(q2(overall * Decimal("100")))},
        )
        reports.append(report)

        for sort_order, head in enumerate(HEADS):
            forecast_value = contract_value * head.weight
            # The forecast carries the overrun the head has already run up. A
            # forecast cost that ignores a known drift is the exact shape the
            # module's own advisory flag exists to catch.
            forecast_cost = forecast_value * (Decimal("1") - head.margin) * head.drift
            done = completion(head, overall)
            cost_to_date = forecast_cost * done
            lines.append(
                CvrLine(
                    id=uuid.uuid4(),
                    report_id=report.id,
                    cost_code=head.code,
                    description=head.name_de if german else head.name_en,
                    cost_to_date=q2(cost_to_date),
                    value_to_date=q2(forecast_value * done),
                    accruals=q2(cost_to_date * _ACCRUAL_RATE),
                    forecast_cost=q2(forecast_cost),
                    forecast_value=q2(forecast_value),
                    sort_order=sort_order,
                    metadata_={"seed": _SEED_MARK},
                )
            )

        # The application for the month claims the value certified within it,
        # which is that month's share of the curve rather than the position to
        # date: an interim application states the increment, not the total.
        gross = q2(contract_value * MONTH_WEIGHTS[index])
        retention = q2(gross * _RETENTION_RATE)
        prefix = "AZ" if german else "IPA"
        applications.append(
            PaymentApplication(
                id=uuid.uuid4(),
                project_id=project_id,
                period=period,
                application_number=f"{prefix}-{ordinal + 1:03d}",
                gross_value=gross,
                retention=retention,
                net_value=net_of_retention(gross, retention),
                currency=currency,
                status=_APPLICATION_STATUSES[ordinal],
                notes=None,
                created_by=created_by,
                metadata_={"seed": _SEED_MARK},
            )
        )

    return reports, lines, applications


def _seed_cashflow(
    *,
    project_id: uuid.UUID,
    contract_value: Decimal,
    currency: str,
    german: bool,
    today: date,
) -> list[CashflowPoint]:
    """Build the monthly cash-in / cash-out curve.

    Cash out is the month's spend. Cash in is the same month's work certified
    and paid one month later, less retention, which is why the early months
    are negative: the contractor funds the job before the client pays for it.

    The last month is the final account: its own value is certified with it
    rather than a month later, and the retention withheld all job is released.
    Without that the curve closes in the red on a profitable job, because the
    money the client is still holding never arrives inside the window - and a
    reader would take the closing figure for the result rather than for an
    artefact of where the chart stops.
    """
    total_cost = contract_value * (Decimal("1") - forecast_margin())
    last = len(MONTH_WEIGHTS) - 1
    points: list[CashflowPoint] = []

    for index, weight in enumerate(MONTH_WEIGHTS):
        month = shift_month(today, index - CURRENT_INDEX)
        certified = contract_value * MONTH_WEIGHTS[index - 1] if index > 0 else Decimal("0")
        cash_in = Decimal("0")
        if index == last:
            certified += contract_value * weight
            cash_in += contract_value * _RETENTION_RATE
        cash_in += certified * (Decimal("1") - _RETENTION_RATE)
        points.append(
            CashflowPoint(
                id=uuid.uuid4(),
                project_id=project_id,
                period=f"{month.year:04d}-{month.month:02d}",
                cash_in=q2(cash_in),
                cash_out=q2(total_cost * weight),
                currency=currency,
                label=_cashflow_label(german=german, forecast=index > CURRENT_INDEX),
                metadata_={"seed": _SEED_MARK},
            )
        )
    return points


async def _seed_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    currency: str,
    owner_id: uuid.UUID | None,
    *,
    german: bool,
    today: date,
) -> dict[str, int]:
    """Write one project's register, or nothing when it has no priced bill."""
    counts = {"projects": 0, "reports": 0, "lines": 0, "cashflow_points": 0, "applications": 0}

    contract_value = await bill_total(session, project_id)
    if contract_value <= 0:
        logger.debug("CVR demo seed skipped for project=%s: no priced bill", project_id)
        return counts

    reports, lines, applications = _seed_reports(
        project_id=project_id,
        contract_value=contract_value,
        currency=currency,
        owner_id=owner_id,
        german=german,
        today=today,
    )
    points = _seed_cashflow(
        project_id=project_id,
        contract_value=contract_value,
        currency=currency,
        german=german,
        today=today,
    )

    session.add_all(reports)
    await session.flush()
    session.add_all(lines)
    session.add_all(points)
    session.add_all(applications)
    await session.flush()

    counts["projects"] = 1
    counts["reports"] = len(reports)
    counts["lines"] = len(lines)
    counts["cashflow_points"] = len(points)
    counts["applications"] = len(applications)
    return counts


async def seed_cvr_demo(
    session: AsyncSession,
    project_ids: Iterable[uuid.UUID],
    *,
    today: date | None = None,
) -> dict[str, int]:
    """Populate the cost-value reconciliation register for the demo projects.

    Args:
        session: Async DB session. The caller commits.
        project_ids: Projects to consider - every one of them, never a first
            few. A project is seeded only when it belongs to the demo estate,
            carries a currency and a priced bill, and holds no CVR report yet,
            so a customer's own project is left alone and a re-run never
            doubles the register.
        today: The day the register is struck against. Defaults to the real
            date; a test passes a fixed one so the periods are predictable.

    Returns:
        Dict with per-entity insert counts across every project seeded.
    """
    totals = {"projects": 0, "reports": 0, "lines": 0, "cashflow_points": 0, "applications": 0}
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

    # Projects that already hold a report, in one query rather than one per
    # project. The guard is per project and not a table-wide count: a user who
    # strikes a single reconciliation must not stop the seed reaching the
    # projects that are still empty.
    seeded = set(
        (await session.execute(select(CvrReport.project_id).where(CvrReport.project_id.in_(ids)).distinct()))
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
        # No silent currency. A reconciliation whose amounts carry no code is a
        # column of numbers that cannot be added to anything, and guessing the
        # code here is how a euro job ends up totalled in dollars.
        if not currency:
            logger.debug("CVR demo seed skipped for project=%s: no currency", project_id)
            continue
        try:
            # A SAVEPOINT per project, so one project that cannot be seeded
            # costs only its own rows. Catching the exception is not enough on
            # PostgreSQL: a failed statement aborts the whole transaction, and
            # every later project would fail on a poisoned session rather than
            # on anything wrong with itself.
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
            logger.warning("CVR demo seed skipped for project=%s (non-fatal)", project_id, exc_info=True)
            continue
        for key, value in counts.items():
            totals[key] += value
    return totals


__all__ = ["seed_cvr_demo"]
