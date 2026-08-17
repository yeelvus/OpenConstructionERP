# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""Event-reconciliation demo seed - reviewed decisions over real correlations.

``RecordLink`` is the durable record of a human decision about a correlation the
engine proposed. It is therefore derived twice over: the endpoints must be rows
that exist in other modules, and the correlation itself must be one the pure
engine actually scored. So this seeder invents neither. It gathers the project's
own correspondence, change orders, variation notices / requests / orders and
management-of-change entries through :func:`gather_candidates`, scores every
same-project pair with :func:`find_links`, and records a decision only on links
the engine really returned - carrying the engine's own confidence onto the row.

Ordering dependency
-------------------
Nothing here can run before its sources exist. Correspondence and change orders
are written by ``install_demo_project``; variations and management-of-change are
written by their own demo seeders. This seeder must therefore run after both, at
the end of the enrichment order.

The mix
-------
A register where every link is confirmed teaches nothing: the point of the
module is that a reviewer judges evidence and sometimes says no. The engine
returns its links strongest first, so the decisions follow the shape a real
review has - the strongest correlations are confirmed, the weakest are rejected
as false positives, a band in the middle is persisted as seen-but-undecided, and
the tail is left unpersisted so it still arrives in the thread view as a live
engine suggestion.

``suggested`` rows are written straight through the ORM because
:func:`decide_record_link` accepts only ``confirmed`` / ``rejected`` by design -
the service exists to record a *decision*. The status itself is first-class
(``LINK_STATUSES`` lists it, and the model documents it as "seen but undecided"),
and without it the decision ledger on ``/reconciliation`` could never show an
unreviewed row, because the ledger lists persisted rows only.

Idempotent per project: a project that already carries a link is left untouched.
"""

from __future__ import annotations

import logging
import uuid
from decimal import Decimal
from typing import Iterable, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.reconciliation.correlate import ScoredLink, find_links
from app.modules.reconciliation.models import (
    STATUS_CONFIRMED,
    STATUS_REJECTED,
    STATUS_SUGGESTED,
    RecordLink,
)
from app.modules.reconciliation.service import (
    decide_record_link,
    gather_candidates,
)

logger = logging.getLogger(__name__)

# Share of the engine's ranked links a reviewer has worked through, by decision.
# Applied from the strong end for confirmations and from the weak end for
# rejections, which is the order a reviewer actually works in. What is left over
# is untouched and still surfaces as a live suggestion in the thread view.
_CONFIRM_SHARE = 0.40
_REJECT_SHARE = 0.15
_SUGGEST_SHARE = 0.15

# Why a reviewer dismissed a correlation. Neutral, factual, about the evidence.
_REJECT_NOTE = "Same trade and week, but the two records are about different instructions."


def _decision_plan(links: Sequence[ScoredLink]) -> dict[int, str]:
    """Map a link's rank (0 = strongest) to the decision recorded on it.

    Only a subset is ruled on. With a single link there is one confirmation and
    nothing to contrast it with, which is honest for a project whose records
    correlate exactly once; from two links up the plan always contains at least
    one confirmation and one rejection so the register shows both outcomes.
    """
    total = len(links)
    if total == 0:
        return {}
    if total == 1:
        return {0: STATUS_CONFIRMED}

    confirm_n = max(1, round(total * _CONFIRM_SHARE))
    reject_n = max(1, round(total * _REJECT_SHARE))
    # Never let the two bands overlap - a link cannot be both confirmed and
    # rejected, and a small register must still show one of each.
    if confirm_n + reject_n > total:
        confirm_n = total - 1
        reject_n = 1

    plan: dict[int, str] = dict.fromkeys(range(confirm_n), STATUS_CONFIRMED)
    for index in range(total - reject_n, total):
        plan[index] = STATUS_REJECTED

    # Seen-but-undecided sits directly below the confirmed band, which is where
    # a reviewer working top-down would have stopped.
    suggest_n = max(1, round(total * _SUGGEST_SHARE))
    for index in range(confirm_n, min(confirm_n + suggest_n, total - reject_n)):
        plan[index] = STATUS_SUGGESTED
    return plan


async def _has_links(session: AsyncSession, project_id: uuid.UUID) -> bool:
    """True when the project already carries a persisted decision."""
    stmt = select(RecordLink.id).where(RecordLink.project_id == project_id).limit(1)
    return (await session.execute(stmt)).scalars().first() is not None


async def _seed_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    owner_id: uuid.UUID | None,
) -> dict[str, int]:
    """Record decisions on one project's engine-scored links."""
    empty = {"projects": 0, "links": 0, "confirmed": 0, "rejected": 0, "suggested": 0}

    if await _has_links(session, project_id):
        return empty

    candidates = await gather_candidates(session, project_id)
    if len(candidates) < 2:
        logger.debug(
            "Reconciliation demo skipped for project=%s (%d source record(s))",
            project_id,
            len(candidates),
        )
        return empty

    scored = find_links(candidates)
    if not scored:
        # The engine found nothing above its threshold. Persisting a decision
        # here would be a decision about a correlation nobody proposed.
        logger.debug("Reconciliation demo skipped for project=%s (engine scored no links)", project_id)
        return empty

    reviewer = str(owner_id) if owner_id is not None else None
    plan = _decision_plan(scored)
    counts = {"projects": 1, "links": 0, "confirmed": 0, "rejected": 0, "suggested": 0}

    for index, link in enumerate(scored):
        status = plan.get(index)
        if status is None:
            continue
        left = (link.left_type, link.left_id)
        right = (link.right_type, link.right_id)

        if status == STATUS_SUGGESTED:
            # The service records decisions only, so an explicitly persisted
            # "seen, not yet decided" row is written directly. Endpoints come
            # from the engine, which already emits them in canonical order.
            session.add(
                RecordLink(
                    project_id=project_id,
                    left_type=left[0],
                    left_id=left[1],
                    right_type=right[0],
                    right_id=right[1],
                    relation=link.relation,
                    confidence=Decimal(str(round(link.confidence, 4))),
                    status=STATUS_SUGGESTED,
                    created_by=reviewer,
                    metadata_={"reasons": list(link.reasons)},
                )
            )
            await session.flush()
            counts["suggested"] += 1
        else:
            row = await decide_record_link(
                session,
                project_id,
                left=left,
                right=right,
                relation=link.relation,
                status=status,
                confidence=link.confidence,
                created_by=reviewer,
            )
            # The engine's explanation is what the reviewer ruled on, so it is
            # kept alongside the decision instead of being recomputed later.
            meta = {"reasons": list(link.reasons)}
            if status == STATUS_REJECTED:
                meta["note"] = _REJECT_NOTE
            row.metadata_ = meta
            await session.flush()
            counts["confirmed" if status == STATUS_CONFIRMED else "rejected"] += 1

        counts["links"] += 1

    return counts


async def seed_reconciliation_demo(
    session: AsyncSession,
    project_ids: Iterable[uuid.UUID],
) -> dict[str, int]:
    """Record reviewed correlations for the demo projects.

    Only demo projects are touched: ``enrich_all`` hands this seeder every
    project in the database, including a customer's own. A project without
    ``metadata["demo_id"]`` is skipped outright - "this project has no links" is
    not a gate, because a real project nobody has reconciled is empty by that
    test too.

    Args:
        session: Async DB session. The caller commits.
        project_ids: Candidate projects. Skipped when not a demo, when it
            already carries a link, or when the engine scores no correlation
            over the records it has.

    Returns:
        Dict with the number of projects touched and the links persisted, split
        by the decision recorded on each.
    """
    totals = {"projects": 0, "links": 0, "confirmed": 0, "rejected": 0, "suggested": 0}
    ids = list(project_ids)
    if not ids:
        return totals

    from app.modules.projects.models import Project

    rows = (
        await session.execute(select(Project.id, Project.owner_id, Project.metadata_).where(Project.id.in_(ids)))
    ).all()

    # Filtered in Python rather than with a JSON predicate: ``contains`` on a
    # JSON column compiles to a string LIKE on PostgreSQL.
    for project_id, owner_id, metadata in rows:
        if not (metadata or {}).get("demo_id"):
            continue
        try:
            # A SAVEPOINT per project: on PostgreSQL a failed statement aborts
            # the whole transaction, so one project that cannot be seeded would
            # otherwise take every later project down with it.
            async with session.begin_nested():
                counts = await _seed_project(session, project_id, owner_id)
        except Exception:
            logger.warning("Reconciliation demo seed skipped for project=%s (non-fatal)", project_id, exc_info=True)
            continue
        for key, value in counts.items():
            totals[key] += value
    return totals
