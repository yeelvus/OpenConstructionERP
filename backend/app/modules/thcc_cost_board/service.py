# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""Business logic for THCC cost board."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.thcc_cost_board.importer import (
    LABOR_CATEGORIES,
    load_cost_board_json,
    load_labor_html,
    match_labor_codes,
    parse_cost_board,
)
from app.modules.thcc_cost_board.models import (
    ThccCostProjectRow,
    ThccCostSnapshot,
    ThccLaborSeries,
)
from app.modules.thcc_cost_board.paths import (
    default_cost_board_json,
    default_labor_html,
    default_labor_xlsx,
    thcc_root,
)
from app.modules.thcc_cost_board.repository import ThccCostBoardRepository
from app.modules.thcc_cost_board.schemas import (
    ImportPathsInfo,
    ImportResult,
    LaborCatalogResponse,
    LaborProjectInfo,
    LaborProjectSeriesResponse,
    LaborSeriesPoint,
    PortfolioKpis,
    ProjectDetailResponse,
    ProjectRowListResponse,
    ProjectRowSummary,
    SnapshotListResponse,
    SnapshotSummary,
)

logger = logging.getLogger(__name__)


def _dec_to_float(v: Decimal | float | int | None) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _sum_dec(values: list[Decimal | None]) -> float:
    total = Decimal("0")
    for v in values:
        if v is not None:
            total += v
    return float(total)


class ThccCostBoardService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.repo = ThccCostBoardRepository(session)

    # ── Path discovery ────────────────────────────────────────────────

    def import_paths(self) -> ImportPathsInfo:
        cj = default_cost_board_json()
        lh = default_labor_html()
        lx = default_labor_xlsx()
        root = thcc_root()
        return ImportPathsInfo(
            cost_board_json=str(cj),
            cost_board_json_exists=cj.is_file(),
            labor_html=str(lh) if lh else None,
            labor_html_exists=bool(lh and lh.is_file()),
            labor_xlsx=str(lx),
            labor_xlsx_exists=lx.is_file(),
            thcc_root=str(root),
        )

    # ── Snapshots / portfolio ─────────────────────────────────────────

    async def list_snapshots(self) -> SnapshotListResponse:
        snaps = await self.repo.list_snapshots()
        items: list[SnapshotSummary] = []
        for s in snaps:
            count = await self.repo.count_projects(s.id)
            items.append(self._snapshot_summary(s, count))
        return SnapshotListResponse(items=items, total=len(items))

    async def get_portfolio(
        self,
        *,
        snapshot_id: uuid.UUID | None = None,
        period: str | None = None,
    ) -> PortfolioKpis:
        snap = await self._resolve_snapshot(snapshot_id=snapshot_id, period=period)
        if not snap:
            raise LookupError("No cost-board snapshot found. Import data_latest.json first.")
        rows = await self.repo.list_project_rows(snap.id)
        return self._compute_kpis(snap, rows)

    async def list_projects(
        self,
        *,
        snapshot_id: uuid.UUID | None = None,
        period: str | None = None,
        bucket: str | None = None,
        risk: str | None = None,
        q: str | None = None,
    ) -> ProjectRowListResponse:
        snap = await self._resolve_snapshot(snapshot_id=snapshot_id, period=period)
        if not snap:
            return ProjectRowListResponse(items=[], total=0, snapshot=None)
        rows = await self.repo.list_project_rows(
            snap.id, bucket=bucket, risk=risk, q=q
        )
        count = await self.repo.count_projects(snap.id)
        return ProjectRowListResponse(
            items=[self._row_summary(r) for r in rows],
            total=len(rows),
            snapshot=self._snapshot_summary(snap, count),
        )

    async def get_project_detail(
        self,
        *,
        row_id: uuid.UUID | None = None,
        project_code: str | None = None,
        project_id: uuid.UUID | None = None,
        snapshot_id: uuid.UUID | None = None,
        period: str | None = None,
    ) -> ProjectDetailResponse:
        snap = await self._resolve_snapshot(snapshot_id=snapshot_id, period=period)
        if not snap:
            raise LookupError("No cost-board snapshot found")

        row: ThccCostProjectRow | None = None
        if row_id:
            row = await self.repo.get_project_row(row_id)
        elif project_code:
            row = await self.repo.get_project_row_by_code(snap.id, project_code)
        elif project_id:
            row = await self.repo.get_project_row_by_oce_id(snap.id, project_id)
        if not row:
            raise LookupError("Project row not found in snapshot")

        count = await self.repo.count_projects(snap.id)
        return ProjectDetailResponse(
            summary=self._row_summary(row),
            payload=row.payload or {},
            snapshot=self._snapshot_summary(snap, count),
        )

    # ── Import ────────────────────────────────────────────────────────

    async def import_from_default_paths(
        self,
        *,
        user_id: str | None = None,
        replace: bool = True,
        include_labor: bool = True,
    ) -> ImportResult:
        paths = self.import_paths()
        if not paths.cost_board_json_exists or not paths.cost_board_json:
            return ImportResult(
                ok=False,
                message="data_latest.json not found on default path",
                source_path=paths.cost_board_json,
            )
        data = load_cost_board_json(paths.cost_board_json)
        result = await self.import_cost_board_data(
            data, user_id=user_id, replace=replace, source_path=paths.cost_board_json
        )
        if include_labor and paths.labor_html_exists and paths.labor_html:
            labor_n = await self.import_labor_from_path(paths.labor_html, attach_codes=True)
            result.labor_rows = labor_n
            result.message = (
                f"{result.message}; labour series {labor_n} rows from HTML"
            )
        return result

    async def import_cost_board_bytes(
        self,
        raw: bytes,
        *,
        user_id: str | None = None,
        replace: bool = True,
        filename: str | None = None,
    ) -> ImportResult:
        data = load_cost_board_json(raw)
        return await self.import_cost_board_data(
            data, user_id=user_id, replace=replace, source_path=filename
        )

    async def import_cost_board_data(
        self,
        data: dict[str, Any],
        *,
        user_id: str | None = None,
        replace: bool = True,
        source_path: str | None = None,
    ) -> ImportResult:
        snap_fields, project_dicts = parse_cost_board(data)
        period = snap_fields["period"]
        replaced = False

        existing = await self.repo.get_snapshot_by_period(period)
        if existing:
            if not replace:
                return ImportResult(
                    ok=False,
                    period=period,
                    message=f"Snapshot for {period} already exists (replace=false)",
                    source_path=source_path,
                )
            await self.repo.delete_snapshot(existing)
            await self.session.flush()
            replaced = True

        # Match OCE projects by project_code
        code_to_id = await self._project_code_map()
        linked = 0
        rows: list[ThccCostProjectRow] = []
        for pd in project_dicts:
            code = pd["project_code"] or ""
            oce_id = code_to_id.get(code.upper()) if code else None
            if oce_id:
                linked += 1
            rows.append(
                ThccCostProjectRow(
                    project_id=oce_id,
                    project_code=code,
                    name=pd["name"],
                    full_name=pd.get("full_name"),
                    bucket=pd.get("bucket"),
                    status=pd.get("status"),
                    risk=pd.get("risk"),
                    pm=pd.get("pm"),
                    contract=pd.get("contract"),
                    resp_cost=pd.get("resp_cost"),
                    actual=pd.get("actual"),
                    forecast=pd.get("forecast"),
                    settle=pd.get("settle"),
                    progress=pd.get("progress"),
                    bid_margin=pd.get("bid_margin"),
                    exp_margin=pd.get("exp_margin"),
                    budget_total=pd.get("budget_total"),
                    proc_total=pd.get("proc_total"),
                    fin_paid=pd.get("fin_paid"),
                    sub_contract=pd.get("sub_contract"),
                    payload=pd.get("payload") or {},
                )
            )

        snap = ThccCostSnapshot(
            period=period,
            period_label=snap_fields.get("period_label"),
            title=snap_fields.get("title"),
            fx_cny_to_thb=snap_fields.get("fx_cny_to_thb"),
            unit=snap_fields.get("unit"),
            status="active",
            source_generated_at=snap_fields.get("source_generated_at"),
            source_meta=snap_fields.get("source_meta") or {},
            imported_at=datetime.now(UTC),
            imported_by=user_id,
            projects=rows,
        )
        await self.repo.add_snapshot(snap)
        await self.session.commit()

        return ImportResult(
            ok=True,
            snapshot_id=snap.id,
            period=period,
            project_count=len(rows),
            linked_projects=linked,
            replaced=replaced,
            message=f"Imported {len(rows)} projects for {period} ({linked} linked to OCE)",
            source_path=source_path,
        )

    async def import_labor_bytes(self, raw: bytes) -> int:
        return await self._import_labor_rows(load_labor_html(raw)[1])

    async def import_labor_from_path(self, path: str | Path, *, attach_codes: bool = True) -> int:
        _months, rows = load_labor_html(path)
        if attach_codes:
            code_by_name = await self._name_to_code_from_latest()
            rows = match_labor_codes(rows, code_by_name)
        return await self._import_labor_rows(rows)

    async def _import_labor_rows(self, rows: list[dict[str, Any]]) -> int:
        await self.repo.clear_labor()
        entities = [
            ThccLaborSeries(
                project_key=r["project_key"],
                project_code=r.get("project_code"),
                project_name=r["project_name"],
                period_month=r["period_month"],
                category=r["category"],
                amount=r["amount"] if isinstance(r["amount"], Decimal) else Decimal(str(r["amount"] or 0)),
                currency=r.get("currency") or "THB",
                unit=r.get("unit"),
                source=r.get("source"),
            )
            for r in rows
        ]
        if entities:
            # batch insert
            batch = 500
            for i in range(0, len(entities), batch):
                await self.repo.add_labor_rows(entities[i : i + batch])
        await self.session.commit()
        return len(entities)

    # ── Labour API ────────────────────────────────────────────────────

    async def labor_catalog(self) -> LaborCatalogResponse:
        projects_raw = await self.repo.list_labor_projects()
        months = await self.repo.labor_months()
        projects = [
            LaborProjectInfo(
                project_key=r[0],
                project_code=r[1],
                project_name=r[2],
                total_amount=float(r[3] or 0),
            )
            for r in projects_raw
        ]
        return LaborCatalogResponse(
            projects=projects,
            categories=list(LABOR_CATEGORIES),
            months=months,
        )

    async def labor_project_series(
        self,
        *,
        project_key: str | None = None,
        project_code: str | None = None,
    ) -> LaborProjectSeriesResponse:
        if project_key:
            rows = await self.repo.labor_series_for_project(project_key)
        elif project_code:
            rows = await self.repo.labor_series_by_code(project_code)
        else:
            raise ValueError("project_key or project_code required")
        if not rows:
            raise LookupError("No labour series for this project")

        months = sorted({r.period_month for r in rows})
        name = rows[0].project_name
        code = rows[0].project_code
        key = rows[0].project_key

        # Build category -> month -> amount
        grid: dict[str, dict[str, float]] = {}
        points: list[LaborSeriesPoint] = []
        for r in rows:
            cat = r.category
            grid.setdefault(cat, {})[r.period_month] = float(r.amount or 0)
            points.append(
                LaborSeriesPoint(
                    period_month=r.period_month,
                    category=cat,
                    amount=float(r.amount or 0),
                )
            )

        series: dict[str, list[float]] = {}
        cumulative: dict[str, list[float]] = {}
        for cat, by_m in grid.items():
            vals = [by_m.get(m, 0.0) for m in months]
            series[cat] = vals
            run = 0.0
            cum: list[float] = []
            for v in vals:
                run += v
                cum.append(run)
            cumulative[cat] = cum

        return LaborProjectSeriesResponse(
            project_key=key,
            project_code=code,
            project_name=name,
            months=months,
            series=series,
            cumulative=cumulative,
            points=points,
        )

    # ── Helpers ───────────────────────────────────────────────────────

    async def _resolve_snapshot(
        self,
        *,
        snapshot_id: uuid.UUID | None = None,
        period: str | None = None,
    ) -> ThccCostSnapshot | None:
        if snapshot_id:
            return await self.repo.get_snapshot(snapshot_id)
        if period:
            return await self.repo.get_snapshot_by_period(period)
        return await self.repo.get_latest_active_snapshot()

    async def _project_code_map(self) -> dict[str, uuid.UUID]:
        """Uppercased project_code -> OCE project id."""
        try:
            from app.modules.projects.models import Project
        except Exception:  # pragma: no cover
            logger.warning("projects model unavailable for code matching")
            return {}
        stmt = select(Project.id, Project.project_code).where(Project.project_code.is_not(None))
        rows = (await self.session.execute(stmt)).all()
        out: dict[str, uuid.UUID] = {}
        for pid, code in rows:
            if code:
                out[str(code).strip().upper()] = pid
        return out

    async def _name_to_code_from_latest(self) -> dict[str, str]:
        snap = await self.repo.get_latest_active_snapshot()
        if not snap:
            return {}
        rows = await self.repo.list_project_rows(snap.id)
        mapping: dict[str, str] = {}
        for r in rows:
            if r.name and r.project_code:
                mapping[r.name] = r.project_code
            if r.full_name and r.project_code:
                mapping[r.full_name] = r.project_code
        return mapping

    def _snapshot_summary(self, s: ThccCostSnapshot, count: int) -> SnapshotSummary:
        return SnapshotSummary(
            id=s.id,
            period=s.period,
            period_label=s.period_label,
            title=s.title,
            fx_cny_to_thb=_dec_to_float(s.fx_cny_to_thb),
            unit=s.unit,
            status=s.status,
            source_generated_at=s.source_generated_at,
            imported_at=s.imported_at,
            project_count=count,
            source_meta=s.source_meta or {},
        )

    def _row_summary(self, r: ThccCostProjectRow) -> ProjectRowSummary:
        alerts = []
        if isinstance(r.payload, dict):
            raw_alerts = r.payload.get("alerts") or []
            if isinstance(raw_alerts, list):
                alerts = [str(a) for a in raw_alerts]
        return ProjectRowSummary(
            id=r.id,
            snapshot_id=r.snapshot_id,
            project_id=r.project_id,
            project_code=r.project_code,
            name=r.name,
            full_name=r.full_name,
            bucket=r.bucket,
            status=r.status,
            risk=r.risk,
            pm=r.pm,
            contract=_dec_to_float(r.contract),
            resp_cost=_dec_to_float(r.resp_cost),
            actual=_dec_to_float(r.actual),
            forecast=_dec_to_float(r.forecast),
            settle=_dec_to_float(r.settle),
            progress=_dec_to_float(r.progress),
            bid_margin=_dec_to_float(r.bid_margin),
            exp_margin=_dec_to_float(r.exp_margin),
            budget_total=_dec_to_float(r.budget_total),
            proc_total=_dec_to_float(r.proc_total),
            fin_paid=_dec_to_float(r.fin_paid),
            sub_contract=_dec_to_float(r.sub_contract),
            alerts=alerts,
        )

    def _compute_kpis(
        self, snap: ThccCostSnapshot, rows: list[ThccCostProjectRow] | Any
    ) -> PortfolioKpis:
        row_list = list(rows)
        meta_counts = (snap.source_meta or {}).get("counts") or {}

        def _bucket_is_active(b: str | None) -> bool:
            return (b or "") in ("在建", "active", "在施")

        def _bucket_is_done(b: str | None) -> bool:
            return (b or "") in ("完工", "done", "竣工", "已完工")

        active = sum(1 for r in row_list if _bucket_is_active(r.bucket))
        done = sum(1 for r in row_list if _bucket_is_done(r.bucket))
        risk_n = sum(1 for r in row_list if (r.risk or "") in ("danger", "warn", "high", "风险"))

        exp_margins = [float(r.exp_margin) for r in row_list if r.exp_margin is not None]
        bid_margins = [float(r.bid_margin) for r in row_list if r.bid_margin is not None]
        progresses = [float(r.progress) for r in row_list if r.progress is not None]

        counts = {
            "projects": len(row_list),
            "active": active or int(meta_counts.get("active") or 0),
            "done": done or int(meta_counts.get("done") or 0),
            "risk": risk_n or int(meta_counts.get("risk") or 0),
        }

        return PortfolioKpis(
            snapshot_id=snap.id,
            period=snap.period,
            period_label=snap.period_label,
            title=snap.title,
            fx_cny_to_thb=_dec_to_float(snap.fx_cny_to_thb),
            unit=snap.unit,
            source_generated_at=snap.source_generated_at,
            counts=counts,
            total_contract=_sum_dec([r.contract for r in row_list]),
            total_resp_cost=_sum_dec([r.resp_cost for r in row_list]),
            total_actual=_sum_dec([r.actual for r in row_list]),
            total_forecast=_sum_dec([r.forecast for r in row_list]),
            total_budget=_sum_dec([r.budget_total for r in row_list]),
            total_proc=_sum_dec([r.proc_total for r in row_list]),
            total_fin_paid=_sum_dec([r.fin_paid for r in row_list]),
            total_sub_contract=_sum_dec([r.sub_contract for r in row_list]),
            active_count=counts["active"],
            done_count=counts["done"],
            risk_count=counts["risk"],
            avg_exp_margin=(sum(exp_margins) / len(exp_margins)) if exp_margins else None,
            avg_bid_margin=(sum(bid_margins) / len(bid_margins)) if bid_margins else None,
            avg_progress=(sum(progresses) / len(progresses)) if progresses else None,
        )
