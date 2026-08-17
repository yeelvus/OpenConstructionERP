# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""finance - seller contact (BG-6) on the standing e-invoice configuration.

Adds ``seller_contact_name``, ``seller_contact_phone`` and
``seller_contact_email`` to ``oe_finance_einvoice_settings``.

XRechnung makes the SELLER CONTACT group and all three of its fields mandatory
(BR-DE-2, BR-DE-5, BR-DE-6, BR-DE-7). None of them existed anywhere in the
platform, so every German invoice it produced drew four fatal findings at the
receiver and no screen could clear them. They describe the company rather than
one document, which is why they belong on this row and not in an invoice's
metadata.

``seller_email`` is deliberately left in place and left alone. It always held
the address a person reads, which is the same business term as the new
``seller_contact_email`` (BT-43), and instances have real addresses stored in
it. The model reads it as the contact email when the newer column is empty, so
an instance that upgrades keeps whatever it had configured without a data
migration that would have to guess.

Every column is NOT NULL with an empty server default, matching the rest of the
table: a half-filled configuration is the normal state on the way to a complete
one.

Inspector-guarded in both directions so a fresh install, whose tables env.py
already built through ``Base.metadata.create_all``, hits an idempotent no-op.

Revision ID: v3292_finance_einvoice_seller_contact
Revises: v3291_finance_einvoice_settings
Create Date: 2026-08-12
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "v3292_finance_einvoice_seller_contact"
down_revision: Union[str, Sequence[str], None] = "v3291_finance_einvoice_settings"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "oe_finance_einvoice_settings"

# (name, length), same shape as the create migration so the two stay comparable.
_NEW_COLUMNS: tuple[tuple[str, int], ...] = (
    ("seller_contact_name", 200),
    ("seller_contact_phone", 50),
    ("seller_contact_email", 200),
)


def _existing_columns(inspector: sa.engine.reflection.Inspector) -> set[str]:
    if _TABLE not in inspector.get_table_names():
        return set()
    return {c["name"] for c in inspector.get_columns(_TABLE)}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    present = _existing_columns(inspector)
    if not present:
        return

    for name, length in _NEW_COLUMNS:
        if name in present:
            continue
        op.add_column(
            _TABLE,
            sa.Column(name, sa.String(length), nullable=False, server_default=""),
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    present = _existing_columns(inspector)
    if not present:
        return

    for name, _length in reversed(_NEW_COLUMNS):
        if name in present:
            op.drop_column(_TABLE, name)
