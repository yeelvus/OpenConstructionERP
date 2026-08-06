# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""THCC 责任成本 std → finance budget lines bulk import.

Scans::

    …/3.1_责任成本/2_责任成本_std/
        THCC-2025-001_裕州项目_责任成本.xlsx
        …

Each workbook has columns roughly::

    序号 | 名称 | 金额（泰铢|人民币|综合合价） | 材料合价 | 施工合价

Leaf lines (``A.1``, ``B.2`` …) become one ``oe_finance_budget`` row each:
``wbs_id`` = line code, ``category`` = line name, amounts as original/revised
budget. Section headers (``A`` / ``预计直接成本``) are skipped.

Idempotent: re-import upserts by ``(project_id, wbs_id)`` for rows tagged
``metadata.source == "thcc_resp_cost"``. Optional ``replace=True`` removes
stale tagged lines not present in the new file.

CNY files (header 金额（人民币）) are converted to THB using ``fx_cny_to_thb``
(default 4.9) so portfolio rollups stay single-currency with Thai projects.
"""

from __future__ import annotations

import logging
import os
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

SOURCE_TAG = "thcc_resp_cost"
DEFAULT_FX_CNY_TO_THB = Decimal("4.9")

_HOST_DEFAULT_ROOT = (
    Path.home()
    / "Desktop"
    / "邯郸中材"
    / "01成本统计"
    / "3.1_责任成本"
    / "2_责任成本_std"
)
_DOCKER_DEFAULT_ROOT = Path("/host/thcc/01成本统计/3.1_责任成本/2_责任成本_std")

_PROJECT_CODE_RE = re.compile(r"(THCC-\d{4}-\d{3}|LSBM-\d{2}|XCY-\d{2})", re.I)
# Leaf line codes: A.1, A.10, B.2, C.4 — not bare section letters A/B/C
_LEAF_CODE_RE = re.compile(r"^[A-Za-z](\.\d+)+$")


def _config_file() -> Path:
    data = (os.environ.get("OE_DATA_DIR") or "").strip()
    if data:
        return Path(data) / "thcc_resp_cost.json"
    return Path.home() / ".openestimate" / "thcc_resp_cost.json"


def get_resp_cost_root() -> Path:
    env = (os.environ.get("THCC_RESP_COST_ROOT") or "").strip()
    if env:
        return Path(env).expanduser()
    try:
        cfg = _config_file()
        if cfg.is_file():
            import json

            data = json.loads(cfg.read_text(encoding="utf-8"))
            raw = (data.get("root") or "").strip()
            if raw:
                return Path(raw).expanduser()
    except Exception:  # noqa: BLE001
        logger.debug("Could not read thcc_resp_cost config", exc_info=True)
    if _DOCKER_DEFAULT_ROOT.is_dir():
        return _DOCKER_DEFAULT_ROOT
    return _HOST_DEFAULT_ROOT


def set_resp_cost_root(root: str | Path) -> Path:
    path = Path(root).expanduser().resolve()
    cfg = _config_file()
    cfg.parent.mkdir(parents=True, exist_ok=True)
    import json

    cfg.write_text(
        json.dumps(
            {"root": str(path), "updated_at": datetime.now(UTC).isoformat()},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return path


def _q2(v: Decimal) -> Decimal:
    return v.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _cell_str(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip().replace("\n", "").replace("\r", "")


def _cell_decimal(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, (int, float)):
        try:
            return Decimal(str(value))
        except (InvalidOperation, ValueError):
            return None
    text = str(value).strip().replace(",", "").replace("，", "")
    if not text or text in {"-", "—", "–"}:
        return None
    try:
        return Decimal(text)
    except (InvalidOperation, ValueError):
        return None


def _detect_currency(amount_header: str) -> str:
    h = amount_header.replace("\n", "").replace(" ", "")
    if any(k in h for k in ("人民币", "CNY", "RMB", "元")):
        return "CNY"
    if any(k in h for k in ("泰铢", "THB", "铢")):
        return "THB"
    return "THB"


def parse_project_from_filename(name: str) -> tuple[str | None, str | None]:
    """Return (project_code, short_name) from ``THCC-…_名称_责任成本.xlsx``."""
    m = _PROJECT_CODE_RE.search(name)
    code = m.group(1).upper() if m else None
    stem = Path(name).stem
    short = stem
    if code and code in stem:
        short = stem.split(code, 1)[-1].lstrip("_- ")
    short = re.sub(r"_?责任成本$", "", short).strip("_- ") or None
    return code, short


@dataclass
class RespCostLine:
    code: str
    name: str
    amount: Decimal
    amount_mat: Decimal | None = None
    amount_construct: Decimal | None = None
    section: str | None = None  # A / B / C


@dataclass
class ParsedRespCostFile:
    path: str
    filename: str
    project_code: str | None
    project_name: str | None
    currency_original: str
    lines: list[RespCostLine] = field(default_factory=list)
    total: Decimal = Decimal("0")
    error: str | None = None


@dataclass
class DiscoveredRespCostFile:
    path: str
    filename: str
    project_code: str | None
    project_name: str | None
    line_count: int = 0
    total: float = 0.0
    currency_original: str = "THB"
    project_id: str | None = None
    project_matched: bool = False
    match_name: str | None = None
    error: str | None = None


def parse_resp_cost_workbook(path: Path | str) -> ParsedRespCostFile:
    """Parse one 责任成本_std xlsx into leaf budget lines."""
    import openpyxl

    p = Path(path)
    code, short = parse_project_from_filename(p.name)
    result = ParsedRespCostFile(
        path=str(p),
        filename=p.name,
        project_code=code,
        project_name=short,
        currency_original="THB",
    )
    try:
        wb = openpyxl.load_workbook(p, read_only=True, data_only=True)
    except Exception as exc:  # noqa: BLE001
        result.error = f"open failed: {exc}"
        return result

    try:
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
    finally:
        wb.close()

    if not rows:
        result.error = "empty sheet"
        return result

    header = [_cell_str(c) for c in rows[0]]
    # Find amount column: prefer col index 2, else first header with 金额/合价
    amount_idx = 2 if len(header) > 2 else 1
    for i, h in enumerate(header):
        if any(k in h for k in ("金额", "综合合价", "合价")) and "材料" not in h and "施工" not in h:
            amount_idx = i
            break
    mat_idx = next((i for i, h in enumerate(header) if "材料" in h), None)
    construct_idx = next((i for i, h in enumerate(header) if "施工" in h), None)
    result.currency_original = _detect_currency(header[amount_idx] if amount_idx < len(header) else "")

    current_section: str | None = None
    lines: list[RespCostLine] = []
    for raw in rows[1:]:
        if not raw:
            continue
        code_cell = _cell_str(raw[0] if len(raw) > 0 else None)
        name_cell = _cell_str(raw[1] if len(raw) > 1 else None)
        # Section letter only
        if re.fullmatch(r"[A-Za-z]", code_cell):
            current_section = code_cell.upper()
            continue
        # Named section without code (e.g. 建筑工程)
        if not code_cell and name_cell:
            continue
        if not _LEAF_CODE_RE.match(code_cell):
            continue
        amount = _cell_decimal(raw[amount_idx] if amount_idx < len(raw) else None)
        if amount is None:
            continue  # leaf header without amount
        mat = _cell_decimal(raw[mat_idx]) if mat_idx is not None and mat_idx < len(raw) else None
        con = (
            _cell_decimal(raw[construct_idx])
            if construct_idx is not None and construct_idx < len(raw)
            else None
        )
        section = code_cell.split(".", 1)[0].upper()
        lines.append(
            RespCostLine(
                code=code_cell.upper() if code_cell[0].isalpha() else code_cell,
                name=name_cell or code_cell,
                amount=amount,
                amount_mat=mat,
                amount_construct=con,
                section=section or current_section,
            )
        )

    result.lines = lines
    result.total = sum((ln.amount for ln in lines), Decimal("0"))
    if not lines:
        result.error = "no leaf lines found"
    return result


def scan_resp_cost_files(root: Path | None = None) -> list[DiscoveredRespCostFile]:
    root = root or get_resp_cost_root()
    if not root.is_dir():
        return []
    out: list[DiscoveredRespCostFile] = []
    for path in sorted(root.glob("*.xlsx")):
        if path.name.startswith("~$") or path.name.startswith("完整"):
            continue
        parsed = parse_resp_cost_workbook(path)
        out.append(
            DiscoveredRespCostFile(
                path=str(path),
                filename=path.name,
                project_code=parsed.project_code,
                project_name=parsed.project_name,
                line_count=len(parsed.lines),
                total=float(parsed.total),
                currency_original=parsed.currency_original,
                error=parsed.error,
            )
        )
    return out


async def _project_maps(
    session: AsyncSession,
) -> tuple[dict[str, uuid.UUID], dict[str, uuid.UUID], dict[uuid.UUID, str]]:
    from app.modules.projects.models import Project

    stmt = select(Project.id, Project.project_code, Project.name, Project.currency)
    rows = (await session.execute(stmt)).all()
    by_code: dict[str, uuid.UUID] = {}
    by_name: dict[str, uuid.UUID] = {}
    currency: dict[uuid.UUID, str] = {}
    for pid, pcode, pname, cur in rows:
        if pcode:
            by_code[str(pcode).strip().upper()] = pid
        if pname:
            by_name[str(pname).strip()] = pid
            # also short name without 项目
            if str(pname).endswith("项目"):
                by_name.setdefault(str(pname)[:-2], pid)
        currency[pid] = (cur or "").strip().upper()
    return by_code, by_name, currency


async def enrich_scan(
    session: AsyncSession,
    files: list[DiscoveredRespCostFile],
) -> list[dict[str, Any]]:
    by_code, by_name, _cur = await _project_maps(session)
    out: list[dict[str, Any]] = []
    for f in files:
        d = asdict(f)
        pid = None
        match_name = None
        if f.project_code and f.project_code.upper() in by_code:
            pid = by_code[f.project_code.upper()]
        elif f.project_name and f.project_name in by_name:
            pid = by_name[f.project_name]
        elif f.project_name and f"{f.project_name}项目" in by_name:
            pid = by_name[f"{f.project_name}项目"]
        if pid:
            d["project_id"] = str(pid)
            d["project_matched"] = True
            # reverse lookup name
            for name, p in by_name.items():
                if p == pid:
                    match_name = name
                    break
            d["match_name"] = match_name
        else:
            d["project_id"] = None
            d["project_matched"] = False
            d["match_name"] = None
        out.append(d)
    return out


def _to_target_amount(
    amount: Decimal,
    *,
    currency_original: str,
    target_currency: str,
    fx_cny_to_thb: Decimal,
) -> tuple[Decimal, str, dict[str, Any]]:
    """Convert amount to target currency; return (amount, currency, meta extras)."""
    meta: dict[str, Any] = {
        "amount_original": str(amount),
        "currency_original": currency_original,
    }
    cur_o = (currency_original or "THB").upper()
    cur_t = (target_currency or "THB").upper() or "THB"

    if cur_o == cur_t:
        return _q2(amount), cur_t, meta

    if cur_o == "CNY" and cur_t == "THB":
        converted = _q2(amount * fx_cny_to_thb)
        meta["fx_cny_to_thb"] = str(fx_cny_to_thb)
        meta["converted_from"] = "CNY"
        return converted, "THB", meta

    if cur_o == "THB" and cur_t == "CNY" and fx_cny_to_thb:
        converted = _q2(amount / fx_cny_to_thb)
        meta["fx_cny_to_thb"] = str(fx_cny_to_thb)
        meta["converted_from"] = "THB"
        return converted, "CNY", meta

    # fallback: keep original currency
    return _q2(amount), cur_o, meta


async def import_resp_cost_file(
    session: AsyncSession,
    *,
    path: Path | str,
    project_id: uuid.UUID | None = None,
    dry_run: bool = False,
    replace: bool = True,
    fx_cny_to_thb: Decimal | None = None,
    actor_id: str | None = None,
    sync_cost_board: bool = True,
) -> dict[str, Any]:
    """Import one workbook into finance budgets for a matched project."""
    from app.modules.finance.models import ProjectBudget

    fx = fx_cny_to_thb or DEFAULT_FX_CNY_TO_THB
    parsed = parse_resp_cost_workbook(path)
    if parsed.error and not parsed.lines:
        return {
            "ok": False,
            "filename": parsed.filename,
            "error": parsed.error,
            "created": 0,
            "updated": 0,
            "deleted": 0,
            "skipped": 0,
            "total": 0.0,
        }

    by_code, by_name, cur_map = await _project_maps(session)
    pid = project_id
    if pid is None:
        if parsed.project_code and parsed.project_code.upper() in by_code:
            pid = by_code[parsed.project_code.upper()]
        elif parsed.project_name and parsed.project_name in by_name:
            pid = by_name[parsed.project_name]
    if pid is None:
        return {
            "ok": False,
            "filename": parsed.filename,
            "project_code": parsed.project_code,
            "error": "No matching OCE project (set project_code on project master)",
            "created": 0,
            "updated": 0,
            "deleted": 0,
            "skipped": 0,
            "total": float(parsed.total),
            "line_count": len(parsed.lines),
        }

    target_currency = cur_map.get(pid) or "THB"
    if target_currency not in {"THB", "CNY", "USD", "EUR"}:
        target_currency = "THB"

    # Existing THCC resp-cost budget lines for this project
    stmt = select(ProjectBudget).where(ProjectBudget.project_id == pid)
    existing_all = list((await session.execute(stmt)).scalars().all())
    existing_by_wbs: dict[str, ProjectBudget] = {}
    for b in existing_all:
        meta = b.metadata_ or {}
        if meta.get("source") == SOURCE_TAG and b.wbs_id:
            existing_by_wbs[str(b.wbs_id)] = b

    created = updated = skipped = 0
    seen_codes: set[str] = set()
    total_target = Decimal("0")

    for ln in parsed.lines:
        wbs = ln.code[:36]
        seen_codes.add(wbs)
        cat = (ln.name or ln.code)[:100]
        amt, cur, extra = _to_target_amount(
            ln.amount,
            currency_original=parsed.currency_original,
            target_currency=target_currency,
            fx_cny_to_thb=fx,
        )
        total_target += amt
        meta: dict[str, Any] = {
            "source": SOURCE_TAG,
            "line_code": ln.code,
            "line_name": ln.name,
            "section": ln.section,
            "source_file": parsed.filename,
            "imported_at": datetime.now(UTC).isoformat(),
            "actor_id": actor_id,
            **extra,
        }
        if ln.amount_mat is not None:
            meta["amount_mat"] = str(ln.amount_mat)
        if ln.amount_construct is not None:
            meta["amount_construct"] = str(ln.amount_construct)

        if dry_run:
            if wbs in existing_by_wbs:
                updated += 1
            else:
                created += 1
            continue

        if wbs in existing_by_wbs:
            b = existing_by_wbs[wbs]
            b.category = cat
            b.currency_code = cur
            b.original_budget = amt
            b.revised_budget = amt
            b.metadata_ = {**(b.metadata_ or {}), **meta}
            updated += 1
        else:
            # also try unique key match without source tag
            hit = next(
                (
                    b
                    for b in existing_all
                    if b.wbs_id == wbs and (b.category or "") == cat
                ),
                None,
            )
            if hit:
                hit.currency_code = cur
                hit.original_budget = amt
                hit.revised_budget = amt
                hit.metadata_ = {**(hit.metadata_ or {}), **meta}
                existing_by_wbs[wbs] = hit
                updated += 1
            else:
                session.add(
                    ProjectBudget(
                        project_id=pid,
                        wbs_id=wbs,
                        category=cat,
                        currency_code=cur,
                        original_budget=amt,
                        revised_budget=amt,
                        committed=Decimal("0"),
                        actual=Decimal("0"),
                        forecast_final=amt,
                        metadata_=meta,
                    )
                )
                created += 1

    deleted = 0
    if replace and not dry_run:
        for wbs, b in list(existing_by_wbs.items()):
            if wbs not in seen_codes:
                await session.delete(b)
                deleted += 1

    if not dry_run:
        await session.flush()
        if sync_cost_board:
            await _sync_cost_board_resp(
                session,
                project_id=pid,
                project_code=parsed.project_code,
                total_thb=_to_thb(total_target, target_currency if not dry_run else target_currency, fx),
            )
        await session.commit()

    return {
        "ok": True,
        "filename": parsed.filename,
        "project_id": str(pid),
        "project_code": parsed.project_code,
        "currency_original": parsed.currency_original,
        "currency": target_currency if parsed.currency_original == target_currency or parsed.currency_original == "CNY" else target_currency,
        "line_count": len(parsed.lines),
        "created": created,
        "updated": updated,
        "deleted": deleted,
        "skipped": skipped,
        "total": float(total_target),
        "total_original": float(parsed.total),
        "dry_run": dry_run,
        "fx_cny_to_thb": float(fx),
    }


def _to_thb(amount: Decimal, currency: str, fx: Decimal) -> Decimal:
    if (currency or "THB").upper() == "THB":
        return amount
    if (currency or "").upper() == "CNY":
        return _q2(amount * fx)
    return amount


async def _sync_cost_board_resp(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    project_code: str | None,
    total_thb: Decimal,
) -> None:
    """Update latest cost-board snapshot ``resp_cost`` (万泰铢) when module present."""
    try:
        from app.modules.thcc_cost_board.models import ThccCostProjectRow, ThccCostSnapshot
    except Exception:  # pragma: no cover
        return

    # latest active snapshot
    snap = (
        await session.execute(
            select(ThccCostSnapshot)
            .where(ThccCostSnapshot.status == "active")
            .order_by(ThccCostSnapshot.period.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not snap:
        return

    wan = _q2(total_thb / Decimal("10000"))
    row = None
    if project_code:
        row = (
            await session.execute(
                select(ThccCostProjectRow).where(
                    ThccCostProjectRow.snapshot_id == snap.id,
                    ThccCostProjectRow.project_code == project_code,
                )
            )
        ).scalar_one_or_none()
    if row is None:
        row = (
            await session.execute(
                select(ThccCostProjectRow).where(
                    ThccCostProjectRow.snapshot_id == snap.id,
                    ThccCostProjectRow.project_id == project_id,
                )
            )
        ).scalar_one_or_none()
    if row is None:
        return
    row.resp_cost = wan
    payload = dict(row.payload or {})
    payload["resp_cost"] = float(wan)
    payload["resp_cost_source"] = SOURCE_TAG
    payload["resp_cost_thb"] = float(total_thb)
    row.payload = payload


async def import_from_local_root(
    session: AsyncSession,
    *,
    project_id: uuid.UUID | None = None,
    project_codes: list[str] | None = None,
    filenames: list[str] | None = None,
    dry_run: bool = False,
    replace: bool = True,
    fx_cny_to_thb: Decimal | None = None,
    actor_id: str | None = None,
    sync_cost_board: bool = True,
) -> dict[str, Any]:
    root = get_resp_cost_root()
    if not root.is_dir():
        return {
            "ok": False,
            "root": str(root),
            "exists": False,
            "error": f"Directory not found: {root}",
            "files": [],
            "created": 0,
            "updated": 0,
            "deleted": 0,
        }

    files = scan_resp_cost_files(root)
    code_filter = {c.upper() for c in (project_codes or []) if c}
    name_filter = set(filenames or [])

    # If scoped to one OCE project, resolve its code
    scope_code: str | None = None
    if project_id is not None:
        from app.modules.projects.models import Project

        proj = await session.get(Project, project_id)
        if proj and proj.project_code:
            scope_code = str(proj.project_code).upper()

    selected: list[DiscoveredRespCostFile] = []
    for f in files:
        if name_filter and f.filename not in name_filter:
            continue
        if code_filter and (not f.project_code or f.project_code.upper() not in code_filter):
            continue
        if scope_code and (not f.project_code or f.project_code.upper() != scope_code):
            # also allow match by project_id during import if code missing
            if not f.project_code:
                continue
            continue
        selected.append(f)

    results: list[dict[str, Any]] = []
    totals = {"created": 0, "updated": 0, "deleted": 0, "ok_files": 0, "fail_files": 0}
    for f in selected:
        # when project_id scoped, pass it so unmatched filename code still binds
        r = await import_resp_cost_file(
            session,
            path=f.path,
            project_id=project_id if scope_code else None,
            dry_run=dry_run,
            replace=replace,
            fx_cny_to_thb=fx_cny_to_thb,
            actor_id=actor_id,
            sync_cost_board=sync_cost_board,
        )
        results.append(r)
        if r.get("ok"):
            totals["ok_files"] += 1
            totals["created"] += int(r.get("created") or 0)
            totals["updated"] += int(r.get("updated") or 0)
            totals["deleted"] += int(r.get("deleted") or 0)
        else:
            totals["fail_files"] += 1

    return {
        "ok": totals["fail_files"] == 0 and totals["ok_files"] > 0,
        "root": str(root),
        "exists": True,
        "dry_run": dry_run,
        "file_count": len(selected),
        "results": results,
        **totals,
        "message": (
            f"{'预检' if dry_run else '导入'} {totals['ok_files']} 个文件成功"
            f"，失败 {totals['fail_files']}；"
            f"新建 {totals['created']} / 更新 {totals['updated']} / 删除 {totals['deleted']} 条预算行"
        ),
    }


