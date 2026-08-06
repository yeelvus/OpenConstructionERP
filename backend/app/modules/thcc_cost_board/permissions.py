# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""THCC cost board permission definitions."""

from app.core.permissions import Role, permission_registry


def register_thcc_cost_board_permissions() -> None:
    """Register permissions for the THCC cost board module."""
    permission_registry.register_module_permissions(
        "thcc_cost_board",
        {
            "thcc_cost_board.read": Role.VIEWER,
            "thcc_cost_board.import": Role.EDITOR,
            "thcc_cost_board.admin": Role.MANAGER,
        },
    )
