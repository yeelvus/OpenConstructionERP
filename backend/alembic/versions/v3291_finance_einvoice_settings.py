# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""finance - standing e-invoice configuration for the instance.

Creates ``oe_finance_einvoice_settings``, holding the seller identity, the tax
registration behind it and the account a buyer pays into. These are the same on
every invoice a company issues, so until now they had to be retyped into each
invoice's metadata by hand, and in practice were not, which is why the
compliance panel reported fatal BR-* violations a user had no way to clear.

One row, keyed by a ``scope`` column that only ever holds "default". The column
exists rather than being implied so that a future per-organisation split fills
it in instead of reshaping the table. There is no organisation table in the
platform today and seller identity is neither per user nor per project.

Every column is NOT NULL with an empty server default. A half-filled
configuration is the normal state on the way to a complete one, so the table
stores blanks and the screen reports which of them still matter.

No row is inserted. An instance that never opens the screen carries no row, and
``einvoice_defaults`` reads that as nothing configured, which leaves every
existing invoice rendering exactly as it does today.

Ids are ``String(36)``, not native ``UUID``: the ORM's ``GUID`` type is
``VARCHAR(36)`` on every dialect, and a native ``uuid`` column here would build
a schema the application reads with the wrong type on one of the two install
routes.

The migration is inspector-guarded so a fresh install, whose tables env.py
already populated through ``Base.metadata.create_all``, hits an idempotent
no-op.

Revision ID: v3291_finance_einvoice_settings
Revises: v3290_finance_invoice_line_vat
Create Date: 2026-08-11
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "v3291_finance_einvoice_settings"
down_revision: Union[str, Sequence[str], None] = "v3290_finance_invoice_line_vat"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "oe_finance_einvoice_settings"

# (name, length) for every text column. Kept as data so the create below and the
# model stay comparable by eye.
_TEXT_COLUMNS: tuple[tuple[str, int], ...] = (
    ("scope", 50),
    ("seller_name", 200),
    ("seller_vat_id", 50),
    ("seller_tax_number", 50),
    ("seller_legal_id", 50),
    ("seller_country_code", 2),
    ("seller_line1", 200),
    ("seller_postcode", 20),
    ("seller_city", 100),
    ("seller_email", 200),
    ("seller_electronic_address", 200),
    ("seller_electronic_address_scheme", 20),
    ("payee_iban", 34),
    ("payee_bic", 11),
    ("payee_account_name", 200),
    ("payment_means_code", 4),
    ("payment_terms", 500),
)


def _has_table(inspector: sa.engine.reflection.Inspector, name: str) -> bool:
    return name in inspector.get_table_names()


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if _has_table(inspector, _TABLE):
        return

    op.create_table(
        _TABLE,
        # String(36), not a native UUID type. The ORM's GUID type stores a
        # 36-character string, and a native uuid column here would produce a
        # schema the application reads with the wrong type on one of the two
        # install routes.
        sa.Column("id", sa.String(36), primary_key=True, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("CURRENT_TIMESTAMP"),
            nullable=False,
        ),
        *(
            sa.Column(
                name,
                sa.String(length),
                nullable=False,
                server_default="default" if name == "scope" else "",
            )
            for name, length in _TEXT_COLUMNS
        ),
        sa.Column("updated_by", sa.String(36), nullable=True),
        sa.UniqueConstraint("scope", name="uq_oe_finance_einvoice_settings_scope"),
    )
    op.create_index(f"ix_{_TABLE}_scope", _TABLE, ["scope"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    if not _has_table(inspector, _TABLE):
        return

    op.drop_index(f"ix_{_TABLE}_scope", table_name=_TABLE)
    op.drop_table(_TABLE)
