# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""Parse THCC cost-board JSON and labour HTML into plain Python structures."""

from __future__ import annotations

import json
import logging
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Categories used in the labour HTML allData object
LABOR_CATEGORIES = (
    "zh_formal",
    "zh_labor",
    "local_labor",
    "outsourcing_labor",
    "visa_fee",
    "total_labor",
)

LABOR_CATEGORY_LABELS_ZH = {
    "zh_formal": "中方正式工",
    "zh_labor": "中方劳务工",
    "local_labor": "属地工",
    "outsourcing_labor": "劳务公司/中介",
    "visa_fee": "签证费",
    "total_labor": "合计",
}

_SCALAR_KEYS = (
    "code",
    "name",
    "full_name",
    "bucket",
    "status",
    "risk",
    "pm",
    "contract",
    "resp_cost",
    "actual",
    "forecast",
    "settle",
    "progress",
    "bid_margin",
    "exp_margin",
    "budget_total",
    "proc_total",
    "fin_paid",
    "sub_contract",
)


def _to_decimal(value: Any) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def period_from_label(label: str | None, generated: str | None = None) -> str:
    """Convert '2026年06月' or similar to 'YYYY-MM'."""
    if label:
        m = re.search(r"(20\d{2})\s*年\s*(\d{1,2})\s*月", label)
        if m:
            return f"{m.group(1)}-{int(m.group(2)):02d}"
        m = re.search(r"(20\d{2})[-/](\d{1,2})", label)
        if m:
            return f"{m.group(1)}-{int(m.group(2)):02d}"
    if generated:
        m = re.search(r"(20\d{2})[-/](\d{1,2})", generated)
        if m:
            return f"{m.group(1)}-{int(m.group(2)):02d}"
    return "unknown"


def load_cost_board_json(path: Path | str | bytes) -> dict[str, Any]:
    """Load data_latest.json from path or raw bytes."""
    if isinstance(path, (bytes, bytearray)):
        data = json.loads(path.decode("utf-8"))
    else:
        p = Path(path)
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
    if not isinstance(data, dict) or "projects" not in data:
        raise ValueError("Invalid cost-board JSON: missing 'projects'")
    return data


def normalize_project_row(raw: dict[str, Any]) -> dict[str, Any]:
    """Map a raw project dict to ORM-ready fields + full payload.

    Empty codes are replaced with a stable synthetic ``NOCODE:<name>`` so the
    ``(snapshot_id, project_code)`` unique constraint can still hold when the
    upstream snapshot has unnamed / uncoded projects (common for local sites).
    """
    code = str(raw.get("code") or "").strip()
    name = str(raw.get("name") or "").strip() or code or "未命名"
    if not code:
        code = f"NOCODE:{name}"
    return {
        "project_code": code,
        "name": name,
        "full_name": (str(raw.get("full_name")).strip() if raw.get("full_name") else None),
        "bucket": raw.get("bucket"),
        "status": raw.get("status"),
        "risk": raw.get("risk"),
        "pm": raw.get("pm"),
        "contract": _to_decimal(raw.get("contract")),
        "resp_cost": _to_decimal(raw.get("resp_cost")),
        "actual": _to_decimal(raw.get("actual")),
        "forecast": _to_decimal(raw.get("forecast")),
        "settle": _to_decimal(raw.get("settle")),
        "progress": _to_decimal(raw.get("progress")),
        "bid_margin": _to_decimal(raw.get("bid_margin")),
        "exp_margin": _to_decimal(raw.get("exp_margin")),
        "budget_total": _to_decimal(raw.get("budget_total")),
        "proc_total": _to_decimal(raw.get("proc_total")),
        "fin_paid": _to_decimal(raw.get("fin_paid")),
        "sub_contract": _to_decimal(raw.get("sub_contract")),
        "payload": raw,
    }


def parse_cost_board(data: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return (snapshot_fields, project_row_dicts)."""
    meta = data.get("meta") or {}
    period_label = meta.get("month")
    generated = meta.get("generated")
    period = period_from_label(
        str(period_label) if period_label else None,
        str(generated) if generated else None,
    )
    snapshot = {
        "period": period,
        "period_label": str(period_label) if period_label else None,
        "title": meta.get("title") or "综合成本分析看板",
        "fx_cny_to_thb": _to_decimal(meta.get("fx_cny_to_thb")),
        "unit": meta.get("unit"),
        "source_generated_at": str(generated) if generated else None,
        "source_meta": {
            "sources": meta.get("sources") or {},
            "counts": meta.get("counts") or {},
            "raw_meta": {k: v for k, v in meta.items() if k not in ("sources",)},
        },
        "status": "active",
    }
    projects = [normalize_project_row(p) for p in data.get("projects") or [] if isinstance(p, dict)]
    return snapshot, projects


def parse_labor_html(text: str) -> tuple[list[str], list[dict[str, Any]]]:
    """Parse months + allData from the labour HTML export.

    Returns (months, rows) where each row is:
      {project_key, project_name, period_month, category, amount}
    Project names are taken from h2/h3 section titles in document order.
    """
    months_m = re.search(r"const\s+months\s*=\s*(\[[^\]]+\])", text)
    if not months_m:
        raise ValueError("Labour HTML: months array not found")
    months: list[str] = json.loads(months_m.group(1))

    start = text.find("const allData = ")
    if start < 0:
        raise ValueError("Labour HTML: allData not found")
    sub = text[start + len("const allData = ") :]
    depth = 0
    end = None
    for i, ch in enumerate(sub):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is None:
        raise ValueError("Labour HTML: allData object not closed")
    all_data: dict[str, Any] = json.loads(sub[:end])

    # Project names in document order (h2/h3, excluding fixed chrome titles)
    skip = {"项目目录", "人工费汇总分析", "累计趋势", "构成趋势"}
    titles = re.findall(r"<h[23][^>]*>([^<]+)</h[23]>", text)
    names = [t.strip() for t in titles if t.strip() not in skip and "趋势" not in t]

    # Sort keys project_1, project_2, …
    def _key_num(k: str) -> int:
        m = re.search(r"(\d+)$", k)
        return int(m.group(1)) if m else 0

    keys = sorted(all_data.keys(), key=_key_num)
    rows: list[dict[str, Any]] = []
    for idx, key in enumerate(keys):
        series_map = all_data[key] or {}
        pname = names[idx] if idx < len(names) else key
        for cat in LABOR_CATEGORIES:
            arr = series_map.get(cat) or []
            if not isinstance(arr, list):
                continue
            for mi, month in enumerate(months):
                amt = arr[mi] if mi < len(arr) else 0
                try:
                    amount = Decimal(str(amt or 0))
                except (InvalidOperation, ValueError):
                    amount = Decimal("0")
                rows.append(
                    {
                        "project_key": key,
                        "project_name": pname,
                        "period_month": month,
                        "category": cat,
                        "amount": amount,
                        "currency": "THB",
                        "unit": "万泰铢",
                        "source": "labor_html",
                    }
                )
    return months, rows


def load_labor_html(path: Path | str | bytes) -> tuple[list[str], list[dict[str, Any]]]:
    if isinstance(path, (bytes, bytearray)):
        text = path.decode("utf-8", errors="ignore")
    else:
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
    return parse_labor_html(text)


def match_labor_codes(
    labor_rows: list[dict[str, Any]],
    code_by_name: dict[str, str],
) -> list[dict[str, Any]]:
    """Attach project_code from cost-board name map (fuzzy exact name match)."""
    # Also try stripping suffixes like "项目"
    alt: dict[str, str] = dict(code_by_name)
    for name, code in list(code_by_name.items()):
        for s in ("项目", "一期", "二期", "三期"):
            if name.endswith(s) and name[: -len(s)]:
                alt.setdefault(name[: -len(s)], code)

    out: list[dict[str, Any]] = []
    for r in labor_rows:
        name = r.get("project_name") or ""
        code = alt.get(name) or alt.get(name.replace("项目", "")) or None
        nr = dict(r)
        nr["project_code"] = code
        out.append(nr)
    return out
