# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""Default host / Docker paths for THCC cost-board source files."""

from __future__ import annotations

import os
from pathlib import Path

# Host Mac default (when running outside Docker).
_HOST_THCC_ROOT = Path.home() / "Desktop" / "邯郸中材"

# Docker bind-mount default (see docker-compose.custom.yml → /host/thcc).
_DOCKER_THCC_ROOT = Path("/host/thcc")


def thcc_root() -> Path:
    """Prefer env THCC_HOST_ROOT / THCC_ROOT, then Docker mount, then Mac desktop."""
    for key in ("THCC_ROOT", "THCC_HOST_ROOT"):
        raw = (os.environ.get(key) or "").strip()
        if raw:
            return Path(raw)
    if _DOCKER_THCC_ROOT.exists():
        return _DOCKER_THCC_ROOT
    return _HOST_THCC_ROOT


def z_report_dir() -> Path:
    return thcc_root() / "01成本统计" / "Z_report"


def default_cost_board_json() -> Path:
    return z_report_dir() / "综合成本看板" / "data_latest.json"


def default_labor_html() -> Path | None:
    """Pick the newest matching labour HTML under Z_report."""
    d = z_report_dir()
    if not d.is_dir():
        return None
    candidates = sorted(
        d.glob("人工费汇总分析*.html"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def default_labor_xlsx() -> Path:
    return z_report_dir() / "人工费汇总.xlsx"
