# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""THCC 综合成本看板 module manifest."""

from app.core.module_loader import ModuleManifest

manifest = ModuleManifest(
    name="oe_thcc_cost_board",
    version="1.0.0",
    display_name="THCC Cost Board",
    display_name_i18n={"zh": "综合成本看板", "zh-CN": "综合成本看板"},
    description=(
        "THCC portfolio cost cockpit: monthly snapshot of contract / responsibility "
        "cost / process actuals / labour / procurement / finance, with project drill-down "
        "and labour special topic. Snapshot-first; future linkage to finance / contracts."
    ),
    author="THCC Custom",
    category="business",
    depends=["oe_users", "oe_projects"],
    auto_install=True,
    enabled=True,
)
