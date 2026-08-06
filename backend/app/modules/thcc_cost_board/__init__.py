# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""THCC 综合成本看板 — portfolio cost cockpit.

Independent OCE module for monthly THCC cost snapshots:
portfolio KPIs, per-project overview, labour topic, monthly import.
"""


async def on_startup() -> None:
    """Register module permissions at process start."""
    from app.modules.thcc_cost_board.permissions import register_thcc_cost_board_permissions

    register_thcc_cost_board_permissions()
