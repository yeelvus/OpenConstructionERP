# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Build a module from a description of it.

The wizard collects a :class:`~app.modules.module_builder.spec.ModuleSpec` -
what the record is, which fields it carries, which rules must hold - and
:mod:`~app.modules.module_builder.generator` renders that into a real module.

An assistant, when one is connected, drafts the spec from a sentence of plain
language. It never writes Python. Everything installed on a user's server comes
out of the deterministic renderer, from a spec that passed validation, which is
what makes a generated module reviewable rather than merely plausible.
"""


async def on_startup() -> None:
    """Register the builder's permissions."""
    from app.modules.module_builder.permissions import register_module_builder_permissions

    register_module_builder_permissions()
