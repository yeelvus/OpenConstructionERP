# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Fill the standing e-invoice configuration from the demo showcase invoice.

Loaded on demand via ``await seed_einvoice_settings_demo(session, project_ids)``.

The gap this closes
===================
The German E-Rechnung showcase invoice validates green on a fresh install, and
the /settings E-Rechnung form is empty on the same install. Both statements are
true because the seller identity travels in the invoice's own
``metadata["einvoice"]`` while the settings row is created lazily and starts
blank, so the document a visitor exports is complete and the screen that is
supposed to explain where its seller came from shows nothing.

So the seller is copied out of the invoice that already carries it, rather than
restated here. A literal in this file would be a second copy of a legal identity
that nobody would ever notice diverging: the invoice would keep rendering the
name it holds, the screen would show the other one, and both would look right on
their own.

What it will not do
===================
Overwrite. A field a user has typed is left exactly as it is, and the write only
happens when at least one field is still empty, so an instance that has been
configured never sees this seeder again. The configuration is instance-wide, so
it is also gated on the invoice being a demo one - see :func:`showcase_invoices`
- because a fictional VAT id written into a customer's real e-invoice settings
is on the wrong side of the line between an empty screen and a wrong one.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.finance.einvoice_settings_models import _PAYMENT_FIELDS, _SELLER_FIELDS
from app.modules.finance.einvoice_settings_schemas import EInvoiceSettingsUpdate
from app.modules.finance.einvoice_settings_service import get_settings, update_settings
from app.modules.finance.models import Invoice
from app.modules.projects.models import Project

logger = logging.getLogger(__name__)

__all__ = ["seed_einvoice_settings_demo", "showcase_invoices"]


def _as_uuid(value: object) -> uuid.UUID | None:
    """Read a project id that may arrive as a UUID or as its string form.

    Both spellings are in circulation for the same id: the demo enrichment
    passes ``uuid.UUID`` straight from a select, while ``install_demo_project``
    returns ``str(project.id)``, so a caller that seeds the project it just
    installed holds the string. Matching on the object rather than on the value
    would make that caller resolve nothing at all, and resolving nothing is the
    failure this whole seeder is written against - it looks exactly like "this
    install has no showcase" and says nothing.
    """
    if isinstance(value, uuid.UUID):
        return value
    try:
        return uuid.UUID(str(value))
    except (AttributeError, TypeError, ValueError):
        return None


async def showcase_invoices(
    session: AsyncSession,
    project_ids: list[uuid.UUID],
) -> list[tuple[uuid.UUID, Invoice]]:
    """Resolve every demo project's e-invoice showcase invoice, by its number.

    Resolved, never assumed. The demo pack declares which invoice is the
    showcase (``einvoice_showcase["invoice"]["invoice_number"]``) and this looks
    that number up on that project, so the row it returns is the row the pack
    named. The installer picks its invoice list with
    ``_INVOICES.get(demo_id) or generated.get("invoices", [])``, which means a
    hard-coded list added for a pack later would replace the generated one and
    silently drop the showcase invoice - a seeder that took "the first
    receivable" or "the invoice at index n" would then hang its records off a
    different document, or off nothing.

    Only demo projects are considered. The gate is the project's own
    ``metadata["demo_id"]`` resolving to a registered template that declares a
    showcase, which a customer's project cannot do by accident.

    Args:
        session: Open async DB session.
        project_ids: Candidate projects.

    Returns:
        ``(project_id, invoice)`` for each project whose showcase invoice really
        exists, in the order the projects were given. A project whose invoice is
        missing is logged and left out rather than returned empty-handed.
    """
    # Normalised and de-duplicated up front, so the ids compared below are the
    # ids the database hands back and the order stays the caller's.
    wanted: list[uuid.UUID] = []
    for value in project_ids:
        parsed = _as_uuid(value)
        if parsed is not None and parsed not in wanted:
            wanted.append(parsed)
    if not wanted:
        return []

    # Imported here rather than at module scope: ``demo_projects`` imports
    # ``demo_packs`` at the bottom of its own file to run the pack loader, and a
    # top-level import from a module the finance package owns would join that
    # cycle for no benefit.
    from app.core.demo_projects import DEMO_TEMPLATES

    # ``metadata_`` is a portable JSON column, so it is read in Python: a
    # containment filter against it compiles to a string comparison on this
    # type rather than to JSON containment, which is the same trap the demo
    # enrichment discovery documents.
    rows = (await session.execute(select(Project.id, Project.metadata_).where(Project.id.in_(wanted)))).all()
    by_project = {project_id: meta for project_id, meta in rows}

    found: list[tuple[uuid.UUID, Invoice]] = []
    for project_id in wanted:
        meta = by_project.get(project_id)
        demo_id = str(meta.get("demo_id") or "").strip() if isinstance(meta, dict) else ""
        if not demo_id:
            continue
        showcase = getattr(DEMO_TEMPLATES.get(demo_id), "einvoice_showcase", None) or {}
        if not showcase.get("einvoice"):
            continue
        number = str((showcase.get("invoice") or {}).get("invoice_number") or "").strip()
        if not number:
            continue

        invoice = (
            (
                await session.execute(
                    select(Invoice)
                    .where(
                        Invoice.project_id == project_id,
                        Invoice.invoice_number == number,
                        # The showcase is a receivable: the linked contact is the
                        # buyer only in that direction, which is what makes the
                        # document resolvable at all.
                        Invoice.invoice_direction == "receivable",
                    )
                    .order_by(Invoice.created_at.asc(), Invoice.id.asc())
                    .limit(1)
                )
            )
            .scalars()
            .first()
        )
        if invoice is None:
            logger.info(
                "e-invoice showcase: project %s (%s) carries no invoice %s, so nothing is seeded against it",
                project_id,
                demo_id,
                number,
            )
            continue
        found.append((project_id, invoice))
    return found


def _showcase_settings(invoice: Invoice) -> dict[str, str]:
    """The settings columns this invoice's own e-invoice metadata answers.

    The exact inverse of :meth:`EInvoiceSettings.as_defaults`, walking the same
    two field tuples, so a column added to the model reaches this seeder without
    a second edit and the parity that docstring promises keeps holding. Nothing
    is invented: a key the invoice does not carry stays out, which leaves the
    column empty rather than filling it with a plausible guess.
    """
    ei = dict((invoice.metadata_ or {}).get("einvoice") or {})
    seller = dict(ei.get("seller") or {})
    values = {f"seller_{name}": str(seller.get(name) or "").strip() for name in _SELLER_FIELDS}
    values.update({name: str(ei.get(name) or "").strip() for name in _PAYMENT_FIELDS})
    return {name: value for name, value in values.items() if value}


async def seed_einvoice_settings_demo(
    session: AsyncSession,
    project_ids: list[uuid.UUID],
) -> dict[str, int]:
    """Fill the empty fields of the instance e-invoice configuration.

    Args:
        session: Open async DB session.
        project_ids: Candidate projects. Only demo ones with a showcase invoice
            are read; everything else is ignored.

    Returns:
        ``{"einvoice_settings": 1}`` when the row was written, or an empty dict
        when there was nothing to resolve and when every field was already set.
    """
    resolved = await showcase_invoices(session, project_ids)
    if not resolved:
        return {}
    # The configuration is one row for the whole instance, so several showcases
    # cannot each have their seller in it. The first resolved project wins, and
    # the order is the caller's project order rather than a database order, so
    # the outcome is the same on every install.
    project_id, invoice = resolved[0]

    seeded = _showcase_settings(invoice)
    if not seeded.get("seller_name"):
        logger.info(
            "e-invoice settings seed skipped: invoice %s on project %s names no seller",
            invoice.invoice_number,
            project_id,
        )
        return {}

    row = await get_settings(session)
    current = {name: str(getattr(row, name, "") or "") for name in EInvoiceSettingsUpdate.model_fields}
    # Gap-fill, not replace. ``update_settings`` writes the whole row on purpose
    # (a field cleared on the screen is a field the user means to clear), so the
    # payload has to carry back everything that is already there.
    filled = {name: (value or seeded.get(name, "")) for name, value in current.items()}
    if filled == current:
        return {}

    # ``updated_by`` lands as None, which is what happened: the seed wrote this,
    # and no user did. It is only reached when a field was still empty, so a
    # configuration somebody has finished never has its authorship rewritten.
    await update_settings(session, EInvoiceSettingsUpdate(**filled))
    logger.info(
        "e-invoice settings seeded from invoice %s: %s",
        invoice.invoice_number,
        ", ".join(sorted(name for name in filled if filled[name] and not current[name])),
    )
    return {"einvoice_settings": 1}
