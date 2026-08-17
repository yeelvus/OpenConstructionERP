# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Reading and writing the instance's standing e-invoice configuration.

``einvoice_defaults`` is the only way anything should turn this configuration
into something a document can use. Two places render an invoice with the EN
16931 engine, the finance export route and the clearance module, and if they
resolved the configuration separately one of them would eventually resolve it
differently.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.finance.einvoice_settings_models import DEFAULT_SCOPE, EInvoiceSettings
from app.modules.finance.einvoice_settings_schemas import EInvoiceSettingsUpdate

__all__ = ["einvoice_defaults", "get_settings", "update_settings"]


async def get_settings(session: AsyncSession) -> EInvoiceSettings:
    """Return the configuration row, creating an empty one on first read.

    Lazy get-or-create rather than a seeded row, matching the CDE and project
    match settings: an instance that never opens the screen carries no row, and
    the absence of one means "nothing configured" rather than "not migrated".
    """
    found = (
        await session.execute(select(EInvoiceSettings).where(EInvoiceSettings.scope == DEFAULT_SCOPE))
    ).scalar_one_or_none()
    if found is not None:
        return found

    row = EInvoiceSettings(scope=DEFAULT_SCOPE)
    session.add(row)
    await session.flush()
    return row


async def update_settings(
    session: AsyncSession,
    payload: EInvoiceSettingsUpdate,
    *,
    user_id: uuid.UUID | None = None,
) -> EInvoiceSettings:
    """Write the whole configuration, having validated it as a whole.

    A full replace rather than a patch: the screen shows every field at once, so
    a field cleared on it is a field the user means to clear, and a patch would
    make clearing an IBAN impossible to express.
    """
    row = await get_settings(session)
    for name, value in payload.model_dump().items():
        setattr(row, name, value)
    row.updated_by = user_id
    await session.flush()
    return row


async def einvoice_defaults(session: AsyncSession) -> dict[str, Any]:
    """Return the configuration in the shape ``build_einvoice`` merges.

    Never creates a row: this runs on every compliance check and every export,
    and a read should not write. An unconfigured instance yields an empty dict,
    which leaves every invoice exactly as it is today.
    """
    found = (
        await session.execute(select(EInvoiceSettings).where(EInvoiceSettings.scope == DEFAULT_SCOPE))
    ).scalar_one_or_none()
    return found.as_defaults() if found is not None else {}
