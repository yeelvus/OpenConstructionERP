# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
"""Field Reports event definitions and publishers.

Field reports are the on-site source of truth for labour hours. When a
report is submitted or approved, the workforce log it carries is the
deterministic input for two downstream flows:

* the **cost model** turns ``hours x cost_rate`` into a labour-actuals
  rollup against the project budget (see ``costmodel.events``);
* the **payroll** module aggregates the same hours per worker/date into
  a draft pay batch.

This module owns the canonical event name and a single typed publisher so
both the service layer and any future caller emit an identically-shaped
payload. The payload is intentionally self-contained (it carries the
workforce rows inline) so subscribers never have to re-open the field
report inside a foreign session.

Auto-imported by the module loader when ``oe_fieldreports`` loads
(see ``module_loader._load_module`` -> ``events.py``).
"""

from __future__ import annotations

import logging
from typing import Any

from app.core.events import event_bus

logger = logging.getLogger(__name__)

# Canonical event name. ``labour`` (not ``workforce``) so the name reads as
# the business fact ("labour was logged"), matching the cost/payroll vocab.
LABOUR_LOGGED = "fieldreports.labour.logged"

# Its undo. A separate name rather than a negative payload: the cost calculator
# skips non-positive hours, so "reversed" has to be said in the name for the
# subscriber to know which direction the money moves.
LABOUR_REVERSED = "fieldreports.labour.reversed"


def publish_labour_logged(
    *,
    report_id: str,
    project_id: str,
    report_date: str,
    status: str,
    rows: list[dict[str, Any]],
    actor_id: str | None = None,
    source: str = "fieldreports",
) -> None:
    """Publish ``fieldreports.labour.logged`` with the workforce rows inline.

    Args:
        report_id: The field report UUID as a string.
        project_id: Owning project UUID as a string.
        report_date: ISO ``YYYY-MM-DD`` date the labour was performed.
        status: Report status at publish time (``submitted`` / ``approved``).
        rows: Normalised workforce rows. Each row is a dict with at least
            ``worker_type`` and ``hours`` (float); optional ``resource_id``,
            ``cost_rate``, ``currency``, ``overtime_hours``, ``headcount``,
            ``company``, ``wbs_id``, ``cost_category``.
        actor_id: User who triggered the transition, if known.
        source: Which module the hours were captured in - ``fieldreports``,
            ``field_diary`` (a phone) or ``field_time`` (the desktop
            timesheet). Three modules publish this event and the bus-level
            source names only the one that owns it, so the reader cannot tell
            them apart without this. It ends up on the worker-day claim, which
            is what an approver reads when they ask why a day was skipped.

    The publish is detached (fire-and-forget) so the submitting request can
    commit and release its writer lock before subscribers open a second
    session - identical rationale to ``schedule/events.py``.
    """
    if not rows:
        # Nothing to roll up - skip the bus traffic entirely.
        return
    event_bus.publish_detached(
        LABOUR_LOGGED,
        {
            "report_id": report_id,
            "project_id": project_id,
            "report_date": report_date,
            "status": status,
            "rows": rows,
            "actor_id": actor_id,
            "source_module": source,
        },
        source_module="oe_fieldreports",
    )
    logger.info(
        "Published %s for report=%s (%d workforce rows)",
        LABOUR_LOGGED,
        report_id,
        len(rows),
    )


def publish_labour_reversed(
    *,
    report_id: str,
    reverses_id: str,
    project_id: str,
    report_date: str,
    rows: list[dict[str, Any]],
    actor_id: str | None = None,
    source: str = "fieldreports",
) -> None:
    """Publish ``fieldreports.labour.reversed`` - take posted labour back off.

    The counterpart of :func:`publish_labour_logged`. A document that posted
    labour actuals can be undone, and until this existed the money it posted
    stayed on the budget line forever and its worker-day claims stayed held, so
    a reversal permanently stranded those days: neither the corrected sheet nor
    the phone could ever cost them again.

    Args:
        report_id: The *reversing* document's id, used as its own replay key.
        reverses_id: The original document whose actuals are being taken back.
            The claims released are only the ones that document holds - a day
            costed by somebody else is not this reversal's to give away.
        project_id: Owning project UUID as a string.
        report_date: ISO ``YYYY-MM-DD`` of the work being reversed.
        rows: The reversing document's own rows, hours positive. The sign lives
            in the event name, not in the numbers: reversal rows mirror the
            original verbatim, and a negative here would be skipped by the
            cost calculator rather than subtracted.
        actor_id: User who reversed it, if known.
        source: Which module reversed - matched against the claim's own
            ``source_module`` so one module cannot release another's day.

    Detached like its sibling: the reversing request is still inside its own
    transaction when this fires.
    """
    if not rows:
        return
    event_bus.publish_detached(
        LABOUR_REVERSED,
        {
            "report_id": report_id,
            "reverses_id": reverses_id,
            "project_id": project_id,
            "report_date": report_date,
            "rows": rows,
            "actor_id": actor_id,
            "source_module": source,
        },
        source_module="oe_fieldreports",
    )
    logger.info(
        "Published %s for reversal=%s of report=%s (%d rows)",
        LABOUR_REVERSED,
        report_id,
        reverses_id,
        len(rows),
    )


__all__ = ["LABOUR_LOGGED", "LABOUR_REVERSED", "publish_labour_logged", "publish_labour_reversed"]
