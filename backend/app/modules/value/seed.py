# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Value-realized demo seed - the assisted work the value case is built on.

The value module owns no project-scoped table of its own: it is a composition
layer, and its dashboard reads figures other modules already produced. Its one
table, ``oe_value_time_factor``, holds a tenant's overrides of the hours-saved
minute factors and is sparse by design - an install with no rows there is
correct, and the admin factors panel is never empty because it lists every seed
default alongside any override.

What IS empty on a fresh demo is the dashboard, and the reason is upstream: the
hours-given-back figure, the hours-saved breakdown and the adoption benchmark
all rest on ``oe_activity_log`` rows scoped to a project, and a seeded estate has
none because seeders write rows directly rather than through the API that logs
them. So this seeder books the assisted work itself - three months of it, per
project.

Only ``(module, action)`` pairs the engine actually credits are booked, plus a
deliberate share of ordinary rows it credits nothing for, so the sample behind
the confidence badge is the honest count of saving-bearing rows rather than the
raw row count. Every row names the project it belongs to and one of the estate's
real user accounts, so the "by user" breakdown reads as people rather than ids.

The volume ramps up week on week and differs per project, which is what gives
the adoption benchmark a high and a low cohort to compare instead of one flat
line.

Timestamps are anchored to the run date, never hardcoded, so the chart still
shows the last three months a year from now.

Two gates, both of which have to open. A project must belong to the demo estate
(:func:`_is_demo_project`), and it must carry no activity at all - a project with
activity is one somebody has worked on, and the activity log is the
contemporaneous record a dispute is reconstructed from. The second gate is also
what makes the seeder idempotent: after the first pass the rows it wrote answer
it.

Every project handed in is considered. There is no "flagship plus a few" cap,
which is how a screen ends up permanently empty on the projects that fell
outside it.
"""

from __future__ import annotations

import logging
import random
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Iterable, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit_log import ActivityLog
from app.modules.value.service import _project_scope
from app.modules.value.time_factors_service import set_factors
from app.modules.value.time_saved import DEFAULT_FACTORS

logger = logging.getLogger(__name__)

_SEED = 7720

# Written into ``request_id`` on every seeded row, so seeded work can be told
# from real work and removed again. A scalar column, deliberately: a marker
# inside the JSON ``metadata`` column cannot be selected back, because
# ``JSON.contains`` compiles to a string LIKE on PostgreSQL rather than to JSONB
# containment. It is provenance, not the gate - see ``_seed_project``.
_MARKER = "demo-seed:value"

# How far back the assisted work runs. Twelve weeks is long enough for the
# weekly chart to show a trend and short enough to still read as current.
_WEEKS = 12

# Activity volume per project, indexed by the project's position in the seeding
# call. Past the end of the tuple the position wraps and a whole span is added,
# so no two projects land on the same volume and the adoption benchmark has a
# genuine spread to split into cohorts.
_VOLUMES = (168, 74, 122, 96)
_VOLUME_SPAN = max(_VOLUMES) - min(_VOLUMES) + 1

# Weekly ramp: adoption grows through the window, so the newest week carries
# roughly three times the oldest. Every week gets at least this many rows, which
# is what keeps the weekly chart free of holes.
_WEEK_GROWTH = 0.16
_MIN_ROWS_PER_WEEK = 2

# Working hours a logged action can land in.
_WORK_HOURS = (8, 9, 10, 11, 12, 14, 15, 16, 17)
_WORK_MINUTES = (0, 10, 20, 30, 40, 50)

# The assisted actions the engine credits, with how often each happens relative
# to the others and the note recorded against the row. Every pair here is one
# the hours engine knows (see ``DEFAULT_FACTORS``); a pair it does not know
# credits nothing and would be dead weight on the chart. Verified against the
# engine at import time by ``_SCORED``.
_SCORED_ACTIONS: tuple[tuple[str, str, int, str], ...] = (
    ("rfi", "rfi_answered", 26, "Reply drafted from the specification and issued for review."),
    ("changeorders", "change_order_logged", 14, "Change captured from the instruction and priced into the register."),
    ("changeorders", "change_order_updated", 18, "Change re-priced after the revised scope was confirmed."),
    ("change_intelligence", "comms_digest_generated", 9, "Correspondence thread summarised to its open points."),
    (
        "change_intelligence",
        "change_request_clarified",
        7,
        "Clarifying questions drafted against an ambiguous request.",
    ),
    ("change_intelligence", "delay_detected", 5, "Delay correlated from the field reports against the programme."),
    ("takeoff", "takeoff_parsed", 11, "Quantities parsed from the issued drawing sheet."),
    ("ai_estimator", "ai_estimate_produced", 6, "First-pass estimate produced from the takeoff for review."),
    ("claims_evidence", "evidence_pack_assembled", 4, "Contemporaneous records collated into an evidence pack."),
)

# Ordinary rows the engine credits nothing for. They are logged all the same on
# a real install, and booking a share of them is what keeps the confidence
# denominator honest: the sample behind the hours figure has to be the rows that
# genuinely saved time, not every row in the log.
_UNSCORED_ACTIONS: tuple[tuple[str, str, int, str], ...] = (
    ("projects", "updated", 10, "Project record updated."),
    ("boq", "status_changed", 8, "Bill of quantities moved on in its lifecycle."),
    ("value", "report_generated", 5, "Value report generated for the monthly review."),
)

# Share of the register that is uncredited work. Around a fifth, so the hours
# sample is visibly smaller than the activity count without the chart thinning
# out.
_UNSCORED_SHARE = 0.22

# Guard: every scored pair must be one the engine credits, or the seeded chart
# would show a row count with no hours behind it.
_SCORED = tuple(entry for entry in _SCORED_ACTIONS if (entry[0], entry[1]) in DEFAULT_FACTORS)

# A demo tenant that has measured its own baseline and tuned a few factors, so
# the admin factors panel shows tuned rows against inherited ones. Each value
# MUST differ from the engine default: a value equal to the default deletes the
# override rather than storing it, which would leave the panel showing nothing
# tuned.
_TUNED_FACTORS: tuple[tuple[str, str, Decimal], ...] = (
    ("rfi", "rfi_answered", Decimal("32")),
    ("takeoff", "takeoff_parsed", Decimal("50")),
    ("claims_evidence", "evidence_pack_assembled", Decimal("70")),
)


def _is_demo_project(metadata: dict | None) -> bool:
    """Whether a project row belongs to the demo estate.

    The first of this seeder's two gates, and the one that matters most here.
    The boot backfill runs over every project in the database and re-runs on
    every version upgrade, so on a customer installation their real projects are
    handed in. Writing invented rows into ``oe_activity_log`` is worse than a
    cosmetic mistake: that table is the contemporaneous record a dispute is
    reconstructed from, and the timeline reads it back.

    ``demo_id`` is the key that covers the whole estate. The ten templates stamp
    it alongside ``is_demo``; the flagship reference project is built from its
    own baked fixture and stamps ``demo_id`` without ``is_demo``, so a gate on
    ``is_demo`` would skip the project users actually land on.

    Read from the fetched value rather than matched in SQL: ``metadata_`` is a
    JSON column, and a containment test against it compiles to a string LIKE on
    PostgreSQL rather than to JSONB containment.
    """
    if not isinstance(metadata, dict):
        return False
    return bool(str(metadata.get("demo_id") or "").strip())


def _rng_for(project_id: uuid.UUID) -> random.Random:
    """A deterministic RNG per project, so a re-seed reproduces the register."""
    return random.Random(f"{_SEED}:{project_id}")


def _week_counts(volume: int) -> list[int]:
    """Split a project's volume across the window, oldest week first.

    The weights ramp so the newest week carries about three times the oldest -
    an estate that took the platform up over the quarter rather than one that
    used it evenly from a standing start. Every week is given a floor so the
    weekly chart has no empty bucket.
    """
    weights = [1.0 + _WEEK_GROWTH * index for index in range(_WEEKS)]
    total = sum(weights)
    return [max(_MIN_ROWS_PER_WEEK, round(volume * weight / total)) for weight in weights]


def _moment(rng: random.Random, *, now: datetime, weeks_back: int) -> datetime:
    """A working-hours timestamp inside the week ``weeks_back`` weeks ago.

    Never lands on today: the working hour is stamped onto the day afterwards,
    so a run early in the morning would otherwise book work in the future.
    """
    day = now - timedelta(weeks=weeks_back, days=rng.randrange(1, 6))
    if day.weekday() >= 5:
        # Pull a weekend draw back onto the Friday: nobody books this work then.
        day -= timedelta(days=day.weekday() - 4)
    return day.replace(
        hour=rng.choice(_WORK_HOURS),
        minute=rng.choice(_WORK_MINUTES),
        second=0,
        microsecond=0,
    )


def _pick(rng: random.Random, table: Sequence[tuple[str, str, int, str]]) -> tuple[str, str, int, str]:
    """Draw one action from a weighted table."""
    return rng.choices(table, weights=[entry[2] for entry in table], k=1)[0]


async def _project_actors(session: AsyncSession, owner_id: uuid.UUID) -> list[uuid.UUID]:
    """Return the user accounts the assisted work is attributed to.

    Real accounts from the estate, so the "by user" breakdown names people the
    demo already has. Falls back to the project owner alone when the user table
    cannot be read.
    """
    try:
        from app.modules.users.models import User

        stmt = select(User.id).where(User.is_active.is_(True)).order_by(User.email).limit(5)
        rows = [row for row in (await session.execute(stmt)).scalars().all() if row is not None]
    except Exception:
        logger.debug("User lookup unavailable; value activity attributed to the project owner")
        return [owner_id]
    return rows or [owner_id]


async def _seed_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    owner_id: uuid.UUID,
    ordinal: int,
) -> dict[str, int]:
    """Seed one project's assisted-work history. Returns counts (zeros when skipped)."""
    empty = {"projects": 0, "activity_rows": 0, "credited_rows": 0}

    # The gate is the dashboard's own scope predicate, so what decides here is
    # exactly what the screen would read. Any row at all and the seeder declines.
    #
    # Declining, not just skipping a repeat: ``enrich_all`` hands this seeder
    # every project in the database, which on a real installation means a
    # customer's live ones, and the activity log is the contemporaneous record a
    # dispute is later reconstructed from. Fabricated rows do not belong in it.
    # A project with any activity is a project somebody has worked on.
    #
    # The demo estate is written straight through the ORM rather than through the
    # API that logs activity, so a demo project reaches this seeder with none -
    # which is also what makes the seeder idempotent, because after the first
    # pass the rows it wrote are what answer this query.
    scoped = (
        (await session.execute(select(ActivityLog.id).where(_project_scope(project_id)).limit(1))).scalars().first()
    )
    if scoped is not None:
        return empty

    actors = await _project_actors(session, owner_id)
    rng = _rng_for(project_id)
    slot = ordinal % len(_VOLUMES)
    volume = _VOLUMES[slot] + (ordinal // len(_VOLUMES)) * _VOLUME_SPAN

    now = datetime.now(UTC)
    counts = {"projects": 1, "activity_rows": 0, "credited_rows": 0}
    rows: list[ActivityLog] = []

    for weeks_back, per_week in enumerate(reversed(_week_counts(volume))):
        for _ in range(per_week):
            credited = rng.random() >= _UNSCORED_SHARE and bool(_SCORED)
            module, action, _weight, reason = _pick(rng, _SCORED if credited else _UNSCORED_ACTIONS)
            rows.append(
                ActivityLog(
                    tenant_id=owner_id,
                    actor_id=rng.choice(actors),
                    entity_type="project",
                    entity_id=str(project_id),
                    action=action,
                    reason=reason,
                    module=module,
                    parent_entity_type="project",
                    parent_entity_id=str(project_id),
                    metadata_={"demo_seed": "value"},
                    request_id=_MARKER,
                    # The hours-saved chart buckets on ``created_at`` and there is
                    # no other timestamp on the row to bucket on. Left to the
                    # base default every row would land on the boot instant and
                    # the weekly chart would be a single bar.
                    created_at=_moment(rng, now=now, weeks_back=weeks_back),
                )
            )
            counts["activity_rows"] += 1
            if credited:
                counts["credited_rows"] += 1

    session.add_all(rows)
    await session.flush()
    return counts


async def _seed_tuned_factors(session: AsyncSession) -> int:
    """Tune a few minute factors for the estate's admin accounts.

    The tenant of a single-tenant install is the acting user's own id, so the
    overrides are written against each admin account - the accounts that can
    open the factors panel. Written through :func:`set_factors`, the same layer
    the admin endpoint uses, so a value the endpoint would reject is a value
    this seeder cannot write either. Skips a tenant that already carries an
    override, so a re-run never re-tunes what an operator has since changed.
    """
    from app.modules.users.models import User
    from app.modules.value.models import TimeSavedFactor

    stmt = select(User.id).where(User.role == "admin", User.is_active.is_(True)).order_by(User.email).limit(3)
    admins = [row for row in (await session.execute(stmt)).scalars().all() if row is not None]

    written = 0
    for admin_id in admins:
        tenant_id = str(admin_id)
        existing = (
            (
                await session.execute(
                    select(TimeSavedFactor.id).where(TimeSavedFactor.tenant_id == tenant_id).limit(1),
                )
            )
            .scalars()
            .first()
        )
        if existing is not None:
            continue
        await set_factors(session, tenant_id, list(_TUNED_FACTORS))
        written += len(_TUNED_FACTORS)
    return written


async def seed_value_demo(
    session: AsyncSession,
    project_ids: Iterable[uuid.UUID],
) -> dict[str, int]:
    """Book the assisted work the value-realized dashboard reports on.

    A reader who opens the Value screen afterwards sees hours given back rather
    than a zero: a headline hours figure with a confidence badge backed by a
    sample smaller than the activity count, a "by feature" breakdown naming the
    actions that produced it, a weekly series with no empty bucket over the last
    three months, and a "by user" split across the estate's real accounts. The
    portfolio view totals across projects and the adoption benchmark has a high
    and a low cohort to contrast, because the volume differs per project. The
    admin factors panel additionally shows three tuned factors against the
    inherited defaults.

    Args:
        session: Async DB session. The caller commits.
        project_ids: Projects to consider - every one of them, never a first few.
            A project outside the demo estate is left alone, and so is one that
            already carries any activity: a real project because its log is a
            record of work that happened, a re-run because the rows the first
            pass wrote are themselves activity.

    Returns:
        Dict with per-entity insert counts across every project seeded.
    """
    totals = {"projects": 0, "activity_rows": 0, "credited_rows": 0, "tuned_factors": 0}
    ids = list(project_ids)
    if not ids:
        return totals

    from app.modules.projects.models import Project

    rows = (
        await session.execute(select(Project.id, Project.owner_id, Project.metadata_).where(Project.id.in_(ids)))
    ).all()
    known = {pid: (owner, meta) for pid, owner, meta in rows}

    # Demo projects only. The position that picks a volume counts only those, so
    # the adoption cohorts stay spread on an installation that also holds
    # projects of its own.
    targets: list[tuple[uuid.UUID, uuid.UUID]] = []
    for project_id in ids:
        found = known.get(project_id)
        if found is None:
            continue
        owner_id, metadata = found
        if owner_id is None or not _is_demo_project(metadata):
            continue
        targets.append((project_id, owner_id))

    for ordinal, (project_id, owner_id) in enumerate(targets):
        try:
            # A SAVEPOINT per project, so one project that cannot be seeded costs
            # only its own rows. Catching the exception is not enough on
            # PostgreSQL: a failed statement aborts the whole transaction, and
            # every later project would then fail on a poisoned session rather
            # than on anything wrong with itself.
            async with session.begin_nested():
                counts = await _seed_project(session, project_id, owner_id, ordinal)
        except Exception:
            logger.warning("Value demo seed skipped for project=%s (non-fatal)", project_id, exc_info=True)
            continue
        for key, value in counts.items():
            totals[key] += value

    # Only where the demo estate is. The factors are tenant configuration, and
    # the tenant of a single-tenant install is a real admin account - tuning it
    # on an installation that holds no demo project at all would be editing a
    # customer's settings.
    if targets:
        try:
            async with session.begin_nested():
                totals["tuned_factors"] += await _seed_tuned_factors(session)
        except Exception:
            logger.warning("Value demo factor tuning skipped (non-fatal)", exc_info=True)

    return totals


__all__ = ["seed_value_demo"]
