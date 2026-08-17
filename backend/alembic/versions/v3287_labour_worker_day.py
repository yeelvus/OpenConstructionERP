# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""labour_worker_day: one worker's day belongs to one source.

The same shift reaches the cost model from two places. A foreman punches the
crew in and out on a phone and the diary publishes those hours on approval; the
office fills in the desktop timesheet for the same site and the same day and
that publishes too. Both are honest records of the same eight hours.

The cost model's only guard was ``(report_id, status)``, which stops a message
being delivered twice and cannot see this at all - the two documents have
different ids by construction. So the project read as having paid twice for one
shift, and no screen said which day it was.

``oe_costmodel_labour_worker_day`` is the claim that closes it. The first source
to cost a given ``(project, day, worker)`` takes the row; a later source finds
it taken, skips those hours and names the worker in the log.

Nothing is backfilled. A claim written now for work already costed would have to
guess which source paid for it, and guessing wrong would block the honest source
from ever costing that day again. An empty table means the guard starts working
from today forward, which is the only thing it can honestly promise.

Revision ID: v3287_labour_worker_day
Revises: v3286_diary_labour_published
Create Date: 2026-08-11
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

from app.database import GUID

revision: str = "v3287_labour_worker_day"
down_revision: Union[str, Sequence[str], None] = "v3286_diary_labour_published"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TABLE = "oe_costmodel_labour_worker_day"


def _tables() -> set[str]:
    return set(sa.inspect(op.get_bind()).get_table_names())


def upgrade() -> None:
    if _TABLE in _tables():
        return

    op.create_table(
        _TABLE,
        sa.Column("id", GUID(), primary_key=True, nullable=False),
        sa.Column(
            "project_id",
            GUID(),
            sa.ForeignKey("oe_projects_project.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("work_date", sa.String(length=10), nullable=False),
        # Text, not a foreign key: the claim has to outlive the resource row.
        # Deleting a leaver would otherwise reopen every day they ever worked.
        sa.Column("resource_id", sa.String(length=64), nullable=False),
        sa.Column("source_module", sa.String(length=40), nullable=False, server_default=""),
        sa.Column("source_ref", sa.String(length=64), nullable=False, server_default=""),
        sa.Column("hours", sa.Numeric(18, 4), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint(
            "project_id",
            "work_date",
            "resource_id",
            name="uq_oe_costmodel_labour_worker_day",
        ),
    )
    op.create_index(
        "ix_oe_costmodel_labour_worker_day_project_date",
        _TABLE,
        ["project_id", "work_date"],
    )


def downgrade() -> None:
    if _TABLE not in _tables():
        return
    op.drop_index("ix_oe_costmodel_labour_worker_day_project_date", table_name=_TABLE)
    op.drop_table(_TABLE)
