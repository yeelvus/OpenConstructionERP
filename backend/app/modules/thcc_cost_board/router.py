# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""THCC cost board API routes.

Mounted at /api/v1/thcc-cost-board
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status

from app.dependencies import CurrentUserId, RequirePermission, SessionDep
from app.modules.thcc_cost_board.schemas import (
    ImportPathsInfo,
    ImportResult,
    LaborCatalogResponse,
    LaborProjectSeriesResponse,
    PortfolioKpis,
    ProjectDetailResponse,
    ProjectRowListResponse,
    SnapshotListResponse,
)
from app.modules.thcc_cost_board.service import ThccCostBoardService

router = APIRouter(tags=["thcc-cost-board"])
logger = logging.getLogger(__name__)


def _svc(session: SessionDep) -> ThccCostBoardService:
    return ThccCostBoardService(session)


# ── Snapshots & portfolio ─────────────────────────────────────────────


@router.get(
    "/snapshots",
    response_model=SnapshotListResponse,
    dependencies=[Depends(RequirePermission("thcc_cost_board.read"))],
)
async def list_snapshots(session: SessionDep) -> SnapshotListResponse:
    return await _svc(session).list_snapshots()


@router.get(
    "/portfolio",
    response_model=PortfolioKpis,
    dependencies=[Depends(RequirePermission("thcc_cost_board.read"))],
)
async def portfolio_kpis(
    session: SessionDep,
    snapshot_id: uuid.UUID | None = Query(None),
    period: str | None = Query(None, description="YYYY-MM"),
) -> PortfolioKpis:
    try:
        return await _svc(session).get_portfolio(snapshot_id=snapshot_id, period=period)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get(
    "/projects",
    response_model=ProjectRowListResponse,
    dependencies=[Depends(RequirePermission("thcc_cost_board.read"))],
)
async def list_projects(
    session: SessionDep,
    snapshot_id: uuid.UUID | None = Query(None),
    period: str | None = Query(None),
    bucket: str | None = Query(None),
    risk: str | None = Query(None),
    q: str | None = Query(None, description="Search code/name"),
) -> ProjectRowListResponse:
    return await _svc(session).list_projects(
        snapshot_id=snapshot_id,
        period=period,
        bucket=bucket,
        risk=risk,
        q=q,
    )


@router.get(
    "/projects/{row_id}",
    response_model=ProjectDetailResponse,
    dependencies=[Depends(RequirePermission("thcc_cost_board.read"))],
)
async def get_project_by_row(
    row_id: uuid.UUID,
    session: SessionDep,
) -> ProjectDetailResponse:
    try:
        return await _svc(session).get_project_detail(row_id=row_id)
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get(
    "/by-code/{project_code}",
    response_model=ProjectDetailResponse,
    dependencies=[Depends(RequirePermission("thcc_cost_board.read"))],
)
async def get_project_by_code(
    project_code: str,
    session: SessionDep,
    snapshot_id: uuid.UUID | None = Query(None),
    period: str | None = Query(None),
) -> ProjectDetailResponse:
    try:
        return await _svc(session).get_project_detail(
            project_code=project_code,
            snapshot_id=snapshot_id,
            period=period,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.get(
    "/by-oce-project/{project_id}",
    response_model=ProjectDetailResponse,
    dependencies=[Depends(RequirePermission("thcc_cost_board.read"))],
)
async def get_project_by_oce_id(
    project_id: uuid.UUID,
    session: SessionDep,
    snapshot_id: uuid.UUID | None = Query(None),
    period: str | None = Query(None),
) -> ProjectDetailResponse:
    try:
        return await _svc(session).get_project_detail(
            project_id=project_id,
            snapshot_id=snapshot_id,
            period=period,
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


# ── Labour ────────────────────────────────────────────────────────────


@router.get(
    "/labor/catalog",
    response_model=LaborCatalogResponse,
    dependencies=[Depends(RequirePermission("thcc_cost_board.read"))],
)
async def labor_catalog(session: SessionDep) -> LaborCatalogResponse:
    return await _svc(session).labor_catalog()


@router.get(
    "/labor/series",
    response_model=LaborProjectSeriesResponse,
    dependencies=[Depends(RequirePermission("thcc_cost_board.read"))],
)
async def labor_series(
    session: SessionDep,
    project_key: str | None = Query(None),
    project_code: str | None = Query(None),
) -> LaborProjectSeriesResponse:
    if not project_key and not project_code:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="project_key or project_code is required",
        )
    try:
        return await _svc(session).labor_project_series(
            project_key=project_key, project_code=project_code
        )
    except LookupError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


# ── Import ────────────────────────────────────────────────────────────


@router.get(
    "/import/paths",
    response_model=ImportPathsInfo,
    dependencies=[Depends(RequirePermission("thcc_cost_board.import"))],
)
async def import_paths(session: SessionDep) -> ImportPathsInfo:
    return _svc(session).import_paths()


@router.post(
    "/import/from-disk",
    response_model=ImportResult,
    dependencies=[Depends(RequirePermission("thcc_cost_board.import"))],
)
async def import_from_disk(
    session: SessionDep,
    user_id: CurrentUserId,
    replace: bool = Query(True),
    include_labor: bool = Query(True),
) -> ImportResult:
    """Import data_latest.json (+ optional labour HTML) from default THCC paths."""
    result = await _svc(session).import_from_default_paths(
        user_id=str(user_id) if user_id else None,
        replace=replace,
        include_labor=include_labor,
    )
    if not result.ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=result.message)
    return result


@router.post(
    "/import/json",
    response_model=ImportResult,
    dependencies=[Depends(RequirePermission("thcc_cost_board.import"))],
)
async def import_json_upload(
    session: SessionDep,
    user_id: CurrentUserId,
    file: UploadFile = File(...),
    replace: bool = Query(True),
) -> ImportResult:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    try:
        return await _svc(session).import_cost_board_bytes(
            raw,
            user_id=str(user_id) if user_id else None,
            replace=replace,
            filename=file.filename,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post(
    "/import/labor-html",
    response_model=ImportResult,
    dependencies=[Depends(RequirePermission("thcc_cost_board.import"))],
)
async def import_labor_html_upload(
    session: SessionDep,
    file: UploadFile = File(...),
) -> ImportResult:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")
    try:
        n = await _svc(session).import_labor_bytes(raw)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return ImportResult(ok=True, labor_rows=n, message=f"Imported {n} labour series rows")
