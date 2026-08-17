# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""finance - per-line VAT rate and category on invoice lines.

Adds the EN 16931 per-line VAT terms to ``oe_finance_invoice_item``:

    vat_rate        Numeric(18,4), nullable    (BT-152, percent, e.g. 19.0000)
    vat_category    String(4),     nullable    (BT-151, S / Z / E / AE / ...)

An invoice may mix rates, for example standard-rated works beside a
reverse-charged subcontract, and only the line knows which applies to it.
Until now the exporter applied one rate to every line, which misstates the
VAT breakdown on any mixed invoice.

Both columns are nullable with no server default, and that is deliberate.
NULL means the line was written before per-line VAT existed, and the exporter
falls back to the invoice-level rate for it, so every already-issued invoice
renders exactly the figures it rendered before. Backfilling a rate here would
instead assert a tax treatment nobody entered.

The migration is inspector-guarded so a fresh install, whose tables env.py
already populated through ``Base.metadata.create_all``, hits an idempotent
no-op.

Revision ID: v3290_finance_invoice_line_vat
Revises: v3287_labour_worker_day
Create Date: 2026-08-11
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "v3290_finance_invoice_line_vat"
down_revision: Union[str, Sequence[str], None] = "v3287_labour_worker_day"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "oe_finance_invoice_item"


def _has_table(inspector: sa.engine.reflection.Inspector, name: str) -> bool:
    return name in inspector.get_table_names()


def _has_column(inspector: sa.engine.reflection.Inspector, table: str, column: str) -> bool:
    if not _has_table(inspector, table):
        return False
    return column in {c["name"] for c in inspector.get_columns(table)}


def _column_specs() -> list[tuple[str, sa.Column[object]]]:
    """Fresh column objects per call; batch_alter_table consumes them."""
    return [
        ("vat_rate", sa.Column("vat_rate", sa.Numeric(18, 4), nullable=True)),
        ("vat_category", sa.Column("vat_category", sa.String(4), nullable=True)),
    ]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, _TABLE):
        return

    missing = [(name, col) for (name, col) in _column_specs() if not _has_column(inspector, _TABLE, name)]
    if not missing:
        return

    with op.batch_alter_table(_TABLE) as batch:
        for _name, col in missing:
            batch.add_column(col)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, _TABLE):
        return

    to_drop = [name for (name, _col) in _column_specs() if _has_column(inspector, _TABLE, name)]
    if not to_drop:
        return

    with op.batch_alter_table(_TABLE) as batch:
        for name in to_drop:
            batch.drop_column(name)
