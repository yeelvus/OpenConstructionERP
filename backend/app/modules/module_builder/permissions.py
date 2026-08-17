# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Module builder permissions.

Four rather than two, because the steps differ in what they can cost.

Drafting and previewing write nothing: the spec is data and the rendered files
are returned rather than saved, so an estimator who wants to see what a module
would look like can. Installing puts files on the server's disk and loads them
into the running process, and uninstalling takes a module away from everyone
using it. Those two are administrator work, and they are separate from each
other so that being able to add a module is not the same as being able to
remove one.
"""

from app.core.permissions import Role, permission_registry

MODULE_BUILDER_PERMISSIONS: dict[str, Role] = {
    "module_builder.read": Role.VIEWER,
    "module_builder.draft": Role.EDITOR,
    "module_builder.install": Role.ADMIN,
    "module_builder.uninstall": Role.ADMIN,
}


def register_module_builder_permissions() -> None:
    """Register the builder's permissions with the platform registry."""
    permission_registry.register_module_permissions("module_builder", MODULE_BUILDER_PERMISSIONS)
