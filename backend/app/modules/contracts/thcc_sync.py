# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""THCC local contract-folder sync (path registry only — never copies files).

Scans a local root such as::

    …/5_合同管理📑/A_总包合同/A_在建项目/THCC-2026-004_天顿科技/<合同夹>/
        合同信息.json
        *.pdf

and upserts ``oe_contracts_contract`` rows linked to projects by
``project_code`` (THCC-YYYY-NNN). PDF paths are stored relative to the
configured root so the root can be relocated without rewriting every
contract; individual files can be re-bound when renamed.

No file is copied into application storage.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# Default local root (user machine). Overridable via env / config file.
_DEFAULT_ROOT = (
    Path.home()
    / "Desktop"
    / "邯郸中材"
    / "01成本统计"
    / "5_合同管理📑"
)

_CONFIG_FILE = Path.home() / ".openestimate" / "thcc_contracts.json"

# THCC-2026-004 or THCC-2026-004_天顿科技
_PROJECT_CODE_RE = re.compile(r"^(THCC-\d{4}-\d{3})(?:_|$|[\s\-])", re.I)
_PROJECT_CODE_ANY_RE = re.compile(r"(THCC-\d{4}-\d{3})", re.I)

_SIDE_MAP = {
    "A_总包合同": "main",
    "B_分包合同": "sub",
}

_SKIP_DIR_NAMES = {".DS_Store", "__pycache__", ".git"}


@dataclass
class LocalPdf:
    """One PDF discovered next to 合同信息.json."""

    relpath: str  # relative to contracts root
    name: str
    exists: bool = True


@dataclass
class DiscoveredContract:
    """One contract folder with JSON + optional PDFs."""

    project_code: str
    project_name_hint: str
    side: str  # main | sub
    status_folder: str  # e.g. A_在建项目
    contract_code: str
    contract_title: str
    contract_type_label: str  # 总包 | 分包
    currency: str
    total_value: str
    counterparty_name: str
    end_date: str | None
    duration_note: str
    notes: str
    scope: str
    json_relpath: str
    folder_relpath: str
    pdfs: list[LocalPdf] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)

    # match / sync result (filled by service)
    project_id: str | None = None
    project_match: str | None = None  # matched | missing | ambiguous
    action: str | None = None  # create | update | skip | error
    contract_id: str | None = None
    message: str | None = None


def _read_config_file() -> str:
    return _CONFIG_FILE.read_text(encoding="utf-8")


def default_contracts_root() -> Path:
    env = (
        os.environ.get("OE_THCC_CONTRACTS_ROOT")
        or os.environ.get("THCC_CONTRACTS_ROOT")
        or ""
    ).strip()
    if env:
        return Path(env).expanduser().resolve()
    if _CONFIG_FILE.is_file():
        try:
            data = json.loads(_read_config_file())
            root = (data.get("root") or "").strip()
            if root:
                return Path(root).expanduser().resolve()
        except Exception:  # noqa: BLE001
            pass
    return _DEFAULT_ROOT


def load_config() -> dict[str, Any]:
    root = default_contracts_root()
    cfg: dict[str, Any] = {
        "root": str(root),
        "exists": root.is_dir(),
        "config_file": str(_CONFIG_FILE),
    }
    if _CONFIG_FILE.is_file():
        try:
            cfg["saved"] = json.loads(_read_config_file())
        except Exception:  # noqa: BLE001
            cfg["saved"] = None
    else:
        cfg["saved"] = None
    return cfg


def save_contracts_root(root: str) -> dict[str, Any]:
    path = Path(root).expanduser().resolve()
    _CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "root": str(path),
        "updated_at": datetime.now(UTC).isoformat(),
    }
    _CONFIG_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return load_config()


def _rel(root: Path, path: Path) -> str:
    try:
        return str(path.resolve().relative_to(root.resolve()))
    except ValueError:
        return str(path.resolve())


def _parse_money(val: Any) -> str:
    if val is None or val == "":
        return "0"
    if isinstance(val, (int, float)):
        if float(val) == int(val) and abs(val) < 1e15:
            return str(int(val))
        return format(float(val), "f").rstrip("0").rstrip(".")
    text = str(val).strip().replace(",", "").replace(" ", "")
    try:
        n = Decimal(text)
        if n == n.to_integral_value() and abs(n) < Decimal("1e15"):
            return str(int(n))
        return format(n, "f").rstrip("0").rstrip(".")
    except (InvalidOperation, ValueError):
        return text or "0"


def _parse_date(val: Any) -> str | None:
    if val is None or val == "":
        return None
    text = str(val).strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2})", text)
    if m:
        return m.group(1)
    m = re.match(r"^(\d{4})[./](\d{1,2})[./](\d{1,2})", text)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return None


def _project_code_from_path(parts: list[str]) -> tuple[str, str]:
    """Return (code, name_hint) from a path segment like THCC-2026-004_天顿科技."""
    for part in parts:
        m = _PROJECT_CODE_RE.match(part)
        if m:
            code = m.group(1).upper()
            rest = part[m.end() :].lstrip("_- ")
            return code, rest
        m2 = _PROJECT_CODE_ANY_RE.search(part)
        if m2:
            return m2.group(1).upper(), part
    return "", ""


def scan_contracts_root(
    root: Path | None = None,
    *,
    project_code: str | None = None,
) -> list[DiscoveredContract]:
    """Walk A_总包合同 / B_分包合同 for 合同信息.json."""
    root = (root or default_contracts_root()).expanduser().resolve()
    if not root.is_dir():
        return []

    want = (project_code or "").strip().upper() or None
    found: list[DiscoveredContract] = []

    for side_name, side in _SIDE_MAP.items():
        side_dir = root / side_name
        if not side_dir.is_dir():
            continue
        for json_path in side_dir.rglob("合同信息.json"):
            if any(p in _SKIP_DIR_NAMES for p in json_path.parts):
                continue
            try:
                rel_parts = json_path.relative_to(side_dir).parts
            except ValueError:
                continue
            # status_folder / project_folder / contract_folder / 合同信息.json
            status_folder = rel_parts[0] if len(rel_parts) >= 2 else ""
            proj_seg = rel_parts[1] if len(rel_parts) >= 3 else (rel_parts[0] if rel_parts else "")
            code, name_hint = _project_code_from_path([proj_seg, *rel_parts])
            if not code:
                # also try full path string
                m = _PROJECT_CODE_ANY_RE.search(str(json_path))
                if m:
                    code = m.group(1).upper()
            if not code:
                continue
            if want and code != want:
                continue

            try:
                raw = json.loads(json_path.read_text(encoding="utf-8"))
            except Exception as exc:  # noqa: BLE001
                logger.warning("Cannot read %s: %s", json_path, exc)
                continue
            if not isinstance(raw, dict):
                continue

            folder = json_path.parent
            pdfs: list[LocalPdf] = []
            for pdf in sorted(folder.glob("*.pdf")) + sorted(folder.glob("*.PDF")):
                if pdf.name.startswith("."):
                    continue
                pdfs.append(
                    LocalPdf(
                        relpath=_rel(root, pdf),
                        name=pdf.name,
                        exists=pdf.is_file(),
                    )
                )
            # de-dupe case-insensitive
            seen: set[str] = set()
            uniq_pdfs: list[LocalPdf] = []
            for p in pdfs:
                key = p.relpath.lower()
                if key in seen:
                    continue
                seen.add(key)
                uniq_pdfs.append(p)

            ctype = str(raw.get("合同类型") or ("总包" if side == "main" else "分包"))
            ccode = str(raw.get("合同编号") or "").strip()
            ctitle = str(raw.get("合同名称") or folder.name).strip()
            if not ccode:
                # folder often starts with code
                ccode = folder.name.split("_")[0].strip() or folder.name[:80]

            # Ensure unique-ish codes across main/sub: prefix if needed
            if side == "sub" and ccode and not ccode.upper().startswith("SUB-"):
                # keep original code; uniqueness is global in DB — handle on sync
                pass

            found.append(
                DiscoveredContract(
                    project_code=code,
                    project_name_hint=str(raw.get("项目名称") or name_hint or ""),
                    side=side,
                    status_folder=status_folder,
                    contract_code=ccode[:80],
                    contract_title=ctitle[:500],
                    contract_type_label=ctype,
                    currency=str(raw.get("币种") or "").strip().upper()[:3],
                    total_value=_parse_money(raw.get("合同金额")),
                    counterparty_name=str(raw.get("对方公司名称") or "").strip(),
                    end_date=_parse_date(raw.get("预计竣工日期") or raw.get("结束日期")),
                    duration_note=str(raw.get("工期/交货期") or "").strip(),
                    notes=str(raw.get("备注") or "").strip(),
                    scope=str(raw.get("工程范围") or "").strip(),
                    json_relpath=_rel(root, json_path),
                    folder_relpath=_rel(root, folder),
                    pdfs=uniq_pdfs,
                    raw={k: raw[k] for k in list(raw)[:40]},
                )
            )

    found.sort(key=lambda d: (d.project_code, d.side, d.contract_code))
    return found


def build_thcc_metadata(
    disc: DiscoveredContract,
    *,
    root: Path,
) -> dict[str, Any]:
    return {
        "thcc": {
            "project_code": disc.project_code,
            "project_name": disc.project_name_hint,
            "side": disc.side,
            "status_folder": disc.status_folder,
            "contract_type_label": disc.contract_type_label,
            "counterparty_name": disc.counterparty_name,
            "scope": disc.scope,
            "duration_note": disc.duration_note,
            "notes": disc.notes,
            "root": str(root.resolve()),
            "folder_relpath": disc.folder_relpath,
            "json_relpath": disc.json_relpath,
            "pdf_relpaths": [p.relpath for p in disc.pdfs],
            "pdfs": [asdict(p) for p in disc.pdfs],
            "synced_at": datetime.now(UTC).isoformat(),
        }
    }


def resolve_pdf_status(
    metadata: dict[str, Any] | None,
    *,
    root: Path | None = None,
) -> list[dict[str, Any]]:
    """Return pdf list with exists flags using current root + relpaths."""
    root = (root or default_contracts_root()).resolve()
    thcc = (metadata or {}).get("thcc") if isinstance(metadata, dict) else None
    if not isinstance(thcc, dict):
        return []
    rels = thcc.get("pdf_relpaths") or []
    out: list[dict[str, Any]] = []
    for rel in rels:
        rel_s = str(rel)
        # Prefer join with current root; also try absolute if stored that way
        abs_path = Path(rel_s) if Path(rel_s).is_absolute() else (root / rel_s)
        out.append(
            {
                "relpath": rel_s if not Path(rel_s).is_absolute() else _rel(root, abs_path),
                "name": Path(rel_s).name,
                "absolute": str(abs_path),
                "exists": abs_path.is_file(),
            }
        )
    return out


def resolve_registered_pdf(
    metadata: dict[str, Any] | None,
    *,
    relpath: str,
    root: Path | None = None,
) -> Path:
    """Resolve a registered THCC PDF to an absolute path under the root.

    Raises:
        FileNotFoundError: path not registered, missing on disk, or escapes root.
        ValueError: empty relpath.
    """
    root = (root or default_contracts_root()).resolve()
    want = (relpath or "").strip()
    if not want:
        raise ValueError("relpath is required")

    registered = resolve_pdf_status(metadata, root=root)
    match: dict[str, Any] | None = None
    want_name = Path(want).name.lower()
    for f in registered:
        if f["relpath"] == want or f["absolute"] == want:
            match = f
            break
    if match is None and want_name:
        by_name = [
            f
            for f in registered
            if Path(str(f["relpath"])).name.lower() == want_name
        ]
        if len(by_name) == 1:
            match = by_name[0]
    if match is None:
        raise FileNotFoundError(f"PDF not registered on this contract: {want}")

    abs_path = Path(str(match["absolute"])).expanduser().resolve()
    # Path traversal guard: prefer staying under contracts root.
    try:
        abs_path.relative_to(root)
    except ValueError as exc:
        # Absolute path outside root is only OK if it exactly matches the
        # registered absolute entry (user relocated to another volume).
        if str(abs_path) != str(Path(str(match["absolute"])).expanduser().resolve()):
            raise FileNotFoundError("PDF path escapes contracts root") from exc

    if not abs_path.is_file():
        raise FileNotFoundError(f"PDF missing on disk: {abs_path}")
    return abs_path


def relocate_pdf_in_metadata(
    metadata: dict[str, Any] | None,
    *,
    old_relpath: str | None,
    new_absolute: str,
    root: Path | None = None,
) -> dict[str, Any]:
    """Replace one PDF path (or append) using absolute path → root-relative."""
    root = (root or default_contracts_root()).resolve()
    meta = dict(metadata or {})
    thcc = dict(meta.get("thcc") or {})
    new_path = Path(new_absolute).expanduser().resolve()
    if not new_path.is_file():
        raise FileNotFoundError(f"File not found: {new_path}")
    new_rel = _rel(root, new_path)
    rels = [str(r) for r in (thcc.get("pdf_relpaths") or [])]
    if old_relpath and old_relpath in rels:
        rels = [new_rel if r == old_relpath else r for r in rels]
    elif old_relpath:
        # old path missing from list — append new
        rels.append(new_rel)
    else:
        if new_rel not in rels:
            rels.append(new_rel)
    thcc["pdf_relpaths"] = rels
    thcc["pdfs"] = [
        {
            "relpath": r,
            "name": Path(r).name,
            "exists": (root / r).is_file() if not Path(r).is_absolute() else Path(r).is_file(),
        }
        for r in rels
    ]
    thcc["root"] = str(root)
    thcc["path_relocated_at"] = datetime.now(UTC).isoformat()
    meta["thcc"] = thcc
    return meta


async def match_projects(
    session: "AsyncSession",
    discoveries: list[DiscoveredContract],
) -> list[DiscoveredContract]:
    """Attach project_id by project_code / name."""
    from sqlalchemy import select

    from app.modules.projects.models import Project

    result = await session.execute(select(Project))
    projects = [
        p
        for p in result.scalars().all()
        if (getattr(p, "status", None) or "active") != "archived"
    ]

    # Prefer exact ``project_code`` column; fall back to code embedded in name.
    by_exact_code: dict[str, dict[str, Any]] = {}
    by_name_code: dict[str, dict[str, Any]] = {}
    by_name: dict[str, dict[str, Any]] = {}
    for p in projects:
        pid = str(p.id)
        code = (getattr(p, "project_code", None) or "").strip().upper()
        if code:
            by_exact_code.setdefault(code, {})[pid] = p
        name = (p.name or "").strip()
        if name:
            by_name.setdefault(name, {})[pid] = p
            m = _PROJECT_CODE_ANY_RE.search(name)
            if m:
                by_name_code.setdefault(m.group(1).upper(), {})[pid] = p

    def _pick(pool: dict[str, Any]) -> Any | None:
        if not pool:
            return None
        if len(pool) == 1:
            return next(iter(pool.values()))
        # Prefer the most recently updated project when duplicates exist
        # (common after repeated Excel imports of the same portfolio).
        return max(
            pool.values(),
            key=lambda x: str(getattr(x, "updated_at", None) or getattr(x, "created_at", None) or ""),
        )

    for d in discoveries:
        exact = by_exact_code.get(d.project_code) or {}
        p = _pick(exact)
        if p is not None:
            d.project_id = str(p.id)
            d.project_match = "matched" if len(exact) == 1 else "matched_dup"
            if len(exact) > 1:
                d.message = f"Picked latest of {len(exact)} projects with code {d.project_code}"
            continue

        named = by_name_code.get(d.project_code) or {}
        p = _pick(named)
        if p is not None:
            d.project_id = str(p.id)
            d.project_match = "matched_name_code"
            continue

        name_hits = by_name.get(d.project_name_hint) or {}
        if not name_hits and d.project_name_hint:
            name_hits = {
                str(p.id): p
                for p in projects
                if d.project_name_hint in (p.name or "")
                or (p.name or "") in d.project_name_hint
            }
        p = _pick(name_hits)
        if p is not None:
            d.project_id = str(p.id)
            d.project_match = "matched_name"
            continue

        d.project_match = "missing"
        d.message = f"No OCE project for {d.project_code} / {d.project_name_hint}"
    return discoveries


def _oce_contract_type(label: str, side: str) -> str:
    # Map to supported contract_type enum
    if side == "sub" or "分包" in label:
        return "lump_sum"
    return "lump_sum"


def _counterparty_type(side: str, label: str) -> str:
    if side == "sub" or "分包" in (label or ""):
        return "subcontractor"
    return "client"


def _stable_contract_code(disc: DiscoveredContract) -> str:
    """DB code is globally unique — namespace by project + side when needed."""
    base = disc.contract_code.strip() or "UNKNOWN"
    # Keep readable; include project code to avoid collisions across projects
    code = f"{disc.project_code}:{base}"
    return code[:80]


async def sync_discoveries(
    session: "AsyncSession",
    discoveries: list[DiscoveredContract],
    *,
    user_id: str | None,
    apply: bool,
    root: Path | None = None,
) -> list[DiscoveredContract]:
    """Create/update contracts for matched discoveries.

    When ``apply`` is False, only fills ``action`` / ``message`` (dry-run).
    """
    from sqlalchemy import select

    from app.modules.contracts.models import Contract
    from app.modules.contracts.schemas import ContractCreate
    from app.modules.contracts.service import ContractsService

    root = (root or default_contracts_root()).resolve()
    await match_projects(session, discoveries)

    # Load existing contracts keyed by code
    result = await session.execute(select(Contract))
    existing = {c.code: c for c in result.scalars().all()}

    service = ContractsService(session)

    for d in discoveries:
        if not d.project_id or (d.project_match or "").startswith("missing"):
            d.action = "skip"
            continue

        code = _stable_contract_code(d)
        meta = build_thcc_metadata(d, root=root)
        currency = d.currency or "THB"
        if len(currency) != 3:
            currency = "THB"

        try:
            total = Decimal(d.total_value or "0")
        except InvalidOperation:
            total = Decimal("0")

        if code in existing:
            d.action = "update"
            d.contract_id = str(existing[code].id)
            if not apply:
                d.message = "Would update metadata/paths"
                continue
            contract = existing[code]
            # Merge thcc metadata; update soft fields when draft
            merged = dict(getattr(contract, "metadata_", None) or {})
            merged = {**merged, **meta}
            # Prefer existing thcc merge deep
            old_thcc = (getattr(contract, "metadata_", None) or {}).get("thcc") or {}
            if isinstance(old_thcc, dict):
                new_thcc = {**old_thcc, **meta["thcc"]}
                # keep any manually relocated extra paths
                old_pdfs = old_thcc.get("pdf_relpaths") or []
                new_pdfs = meta["thcc"].get("pdf_relpaths") or []
                # union, scan wins for same basename? prefer new scan set
                new_thcc["pdf_relpaths"] = list(dict.fromkeys([*new_pdfs, *old_pdfs]))
                merged["thcc"] = new_thcc
            contract.metadata_ = merged
            if contract.status == "draft":
                contract.title = d.contract_title or contract.title
                contract.total_value = total
                contract.currency = currency
                contract.counterparty_type = _counterparty_type(d.side, d.contract_type_label)
                if d.end_date:
                    contract.end_date = d.end_date
            d.message = "Updated"
            continue

        d.action = "create"
        if not apply:
            d.message = "Would create contract"
            continue
        try:
            created = await service.create_contract(
                ContractCreate(
                    code=code,
                    title=d.contract_title or d.contract_code,
                    contract_type=_oce_contract_type(d.contract_type_label, d.side),
                    counterparty_type=_counterparty_type(d.side, d.contract_type_label),
                    project_id=uuid.UUID(d.project_id),
                    total_value=total,
                    currency=currency,
                    retention_percent=Decimal("5"),
                    end_date=d.end_date,
                    status="draft",
                    metadata=meta,
                ),
                user_id=user_id,
            )
            d.contract_id = str(created.id)
            existing[code] = created
            d.message = "Created"
        except Exception as exc:  # noqa: BLE001
            d.action = "error"
            d.message = str(exc)[:300]
            logger.exception("THCC contract create failed for %s", code)

    if apply:
        await session.flush()

    return discoveries


def discovery_to_dict(d: DiscoveredContract) -> dict[str, Any]:
    return {
        "project_code": d.project_code,
        "project_name_hint": d.project_name_hint,
        "side": d.side,
        "status_folder": d.status_folder,
        "contract_code": d.contract_code,
        "stable_code": _stable_contract_code(d),
        "contract_title": d.contract_title,
        "contract_type_label": d.contract_type_label,
        "currency": d.currency,
        "total_value": d.total_value,
        "counterparty_name": d.counterparty_name,
        "end_date": d.end_date,
        "json_relpath": d.json_relpath,
        "folder_relpath": d.folder_relpath,
        "pdfs": [asdict(p) for p in d.pdfs],
        "project_id": d.project_id,
        "project_match": d.project_match,
        "action": d.action,
        "contract_id": d.contract_id,
        "message": d.message,
    }


async def rescan_fix_paths(
    session: "AsyncSession",
    *,
    project_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    """Re-scan root and refresh pdf_relpaths for existing THCC-synced contracts."""
    from sqlalchemy import select

    from app.modules.contracts.models import Contract

    root = default_contracts_root()
    discoveries = scan_contracts_root(root)
    by_stable = {_stable_contract_code(d): d for d in discoveries}

    result = await session.execute(select(Contract))
    contracts = list(result.scalars().all())
    fixed = 0
    missing = 0
    checked = 0
    for c in contracts:
        meta = getattr(c, "metadata_", None) or {}
        thcc = meta.get("thcc") if isinstance(meta, dict) else None
        if not isinstance(thcc, dict):
            continue
        if project_id and c.project_id != project_id:
            continue
        checked += 1
        stable = c.code
        disc = by_stable.get(stable)
        if disc:
            new_meta = build_thcc_metadata(disc, root=root)
            merged = {**meta, **new_meta}
            # preserve manual notes under thcc.manual if any
            if "manual" in thcc:
                merged["thcc"]["manual"] = thcc["manual"]
            c.metadata_ = merged
            fixed += 1
        else:
            # re-check existence of current paths
            statuses = resolve_pdf_status(meta, root=root)
            if any(not s["exists"] for s in statuses):
                missing += 1
            thcc = {**thcc, "pdfs": statuses, "root": str(root.resolve())}
            meta = {**meta, "thcc": thcc}
            c.metadata_ = meta

    await session.flush()
    return {
        "checked": checked,
        "refreshed_from_scan": fixed,
        "still_missing_files": missing,
        "root": str(root),
        "root_exists": root.is_dir(),
    }
