# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Module builder manifest."""

from app.core.module_loader import ModuleManifest

manifest = ModuleManifest(
    name="oe_module_builder",
    version="1.0.0",
    display_name="Module Builder",
    description="Describe a module in a few steps and have the platform build and install it.",
    author="OpenConstructionERP Core Team",
    category="core",
    depends=[],
    auto_install=True,
    enabled=True,
)
