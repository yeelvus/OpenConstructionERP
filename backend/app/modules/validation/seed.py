# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""Validation demo seed - the register carries the engine's own verdict.

A :class:`~app.modules.validation.models.ValidationReport` is the validation
engine's output, not a record a seeder is free to author. So this seeder writes
nothing of its own: it loads the BOQs a demo project already carries, hands each
one to :meth:`ValidationModuleService.run_validation` with the rule sets that
project itself declares, and persists whatever comes back. If the estimate is
clean the register says so; if it is not, every line names a rule that really
fired on a position that really exists. A screen showing invented problems on
data that does not have them is worse than an empty screen.

Why the register was still thin
-------------------------------
``install_demo_project`` already runs the engine once per demo, over the main
BOQ only (see the "Validation report" block in ``app.core.demo_projects``). Every
demo project also carries a second, budget-level BOQ, and that one was never
validated - so half the estimates in the estate had no verdict at all, and a
project whose install-time run hit the surrounding ``try/except`` had none. This
seeder closes both gaps by validating every BOQ that has no report yet.

Rule sets come from ``Project.validation_rule_sets`` - the same list the install
path uses - falling back to the universal ``boq_quality`` checks when a project
declares none. Choosing a stricter standard than the project claims to follow
would manufacture failures, which is the one outcome this module must never
produce.

Idempotent per BOQ: a BOQ that already has a report is skipped, so a re-run
never doubles the register and never re-runs the engine over settled work.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any, Iterable, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.validation.models import ValidationReport

logger = logging.getLogger(__name__)

# The universal checks every estimate can be held to, used when a project
# declares no rule sets of its own. Mirrors the install path's fallback.
_DEFAULT_RULE_SETS: tuple[str, ...] = ("boq_quality",)

# Reports are keyed on the validated entity; a BOQ report carries this token.
_TARGET_TYPE_BOQ = "boq"


async def _project_boq_ids(session: AsyncSession, project_id: uuid.UUID) -> list[uuid.UUID]:
    """Return the project's BOQ ids, oldest first.

    Ordered by creation so the main estimate is validated before the budget
    breakdown and the register reads in the order the estimates were built.
    """
    from app.modules.boq.models import BOQ

    stmt = select(BOQ.id).where(BOQ.project_id == project_id).order_by(BOQ.created_at, BOQ.id)
    return list((await session.execute(stmt)).scalars().all())


async def _reported_target_ids(session: AsyncSession, project_id: uuid.UUID) -> set[str]:
    """Return the BOQ ids that already carry a report for this project."""
    stmt = select(ValidationReport.target_id).where(
        ValidationReport.project_id == project_id,
        ValidationReport.target_type == _TARGET_TYPE_BOQ,
    )
    return {str(value) for value in (await session.execute(stmt)).scalars().all()}


def _rule_sets_for(declared: Sequence[str] | None) -> list[str]:
    """The rule sets to run: the project's own, or the universal fallback.

    Never widened. A project that declares only ``boq_quality`` is not held to
    DIN 276 here just because a regional rule set would light up more lines.
    """
    cleaned = [str(name).strip() for name in (declared or []) if str(name).strip()]
    return cleaned or list(_DEFAULT_RULE_SETS)


async def _seed_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    owner_id: uuid.UUID | None,
    declared_rule_sets: Sequence[str] | None,
) -> dict[str, int]:
    """Validate every unreported BOQ on one project. Returns per-entity counts."""
    from app.modules.validation.service import ValidationModuleService

    empty = {"projects": 0, "reports": 0, "passed": 0, "warnings": 0, "errors": 0}

    boq_ids = await _project_boq_ids(session, project_id)
    if not boq_ids:
        logger.debug("Validation demo skipped for project=%s (no BOQ to validate)", project_id)
        return empty

    already = await _reported_target_ids(session, project_id)
    pending = [boq_id for boq_id in boq_ids if str(boq_id) not in already]
    if not pending:
        return empty

    rule_sets = _rule_sets_for(declared_rule_sets)
    service = ValidationModuleService(session)
    counts = {"projects": 1, "reports": 0, "passed": 0, "warnings": 0, "errors": 0}

    for boq_id in pending:
        result: dict[str, Any] = await service.run_validation(
            project_id=project_id,
            boq_id=boq_id,
            rule_sets=list(rule_sets),
            user_id=owner_id,
        )
        counts["reports"] += 1
        counts["passed"] += int(result.get("passed_count") or 0)
        counts["warnings"] += int(result.get("warning_count") or 0)
        counts["errors"] += int(result.get("error_count") or 0)

    return counts


async def seed_validation_demo(
    session: AsyncSession,
    project_ids: Iterable[uuid.UUID],
) -> dict[str, int]:
    """Persist a real validation verdict for every demo project's BOQs.

    Only demo projects are touched: ``enrich_all`` hands this seeder every
    project in the database, including a customer's own, and re-runs on each
    app version. A project without ``metadata["demo_id"]`` is skipped outright -
    "this project has no reports yet" is not a gate, because a real project that
    has never run validation is empty by that test too.

    Args:
        session: Async DB session. The caller commits.
        project_ids: Candidate projects. Non-demo projects are skipped, and a
            demo project's BOQ is skipped when it already carries a report.

    Returns:
        Dict with the number of projects touched, reports written, and the
        rolled-up passed / warning / error counts the engine produced.
    """
    totals = {"projects": 0, "reports": 0, "passed": 0, "warnings": 0, "errors": 0}
    ids = list(project_ids)
    if not ids:
        return totals

    from app.core.validation.rules import register_builtin_rules
    from app.modules.projects.models import Project

    # Idempotent: fills the registry on the first call, a no-op after that.
    # Without it the engine reports every rule set as unsupported and persists
    # an empty verdict, which would be a lie about a BOQ nobody checked.
    register_builtin_rules()

    stmt = select(
        Project.id,
        Project.owner_id,
        Project.metadata_,
        Project.validation_rule_sets,
    ).where(Project.id.in_(ids))
    rows = (await session.execute(stmt)).all()

    # Filtered in Python rather than with a JSON predicate: ``contains`` on a
    # JSON column compiles to a string LIKE on PostgreSQL and would match on
    # substrings of unrelated metadata.
    for project_id, owner_id, metadata, declared in rows:
        if not (metadata or {}).get("demo_id"):
            continue
        try:
            # A SAVEPOINT per project: on PostgreSQL a failed statement aborts
            # the whole transaction, so a plain try/except around one project
            # would poison every later project in the run.
            async with session.begin_nested():
                counts = await _seed_project(session, project_id, owner_id, declared)
        except Exception:
            logger.warning("Validation demo seed skipped for project=%s (non-fatal)", project_id, exc_info=True)
            continue
        for key, value in counts.items():
            totals[key] += value
    return totals
