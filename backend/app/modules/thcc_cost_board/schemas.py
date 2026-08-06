# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""Pydantic schemas for THCC cost board API."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class SnapshotSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    period: str
    period_label: str | None = None
    title: str | None = None
    fx_cny_to_thb: float | None = None
    unit: str | None = None
    status: str
    source_generated_at: str | None = None
    imported_at: datetime | None = None
    project_count: int = 0
    source_meta: dict[str, Any] = Field(default_factory=dict)


class SnapshotListResponse(BaseModel):
    items: list[SnapshotSummary]
    total: int


class PortfolioKpis(BaseModel):
    """Roll-up KPIs for the active (or selected) snapshot."""

    snapshot_id: UUID
    period: str
    period_label: str | None = None
    title: str | None = None
    fx_cny_to_thb: float | None = None
    unit: str | None = None
    source_generated_at: str | None = None
    counts: dict[str, int] = Field(default_factory=dict)
    total_contract: float = 0.0
    total_resp_cost: float = 0.0
    total_actual: float = 0.0
    total_forecast: float = 0.0
    total_budget: float = 0.0
    total_proc: float = 0.0
    total_fin_paid: float = 0.0
    total_sub_contract: float = 0.0
    active_count: int = 0
    done_count: int = 0
    risk_count: int = 0
    avg_exp_margin: float | None = None
    avg_bid_margin: float | None = None
    avg_progress: float | None = None


class ProjectRowSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    snapshot_id: UUID
    project_id: UUID | None = None
    project_code: str
    name: str
    full_name: str | None = None
    bucket: str | None = None
    status: str | None = None
    risk: str | None = None
    pm: str | None = None
    contract: float | None = None
    resp_cost: float | None = None
    actual: float | None = None
    forecast: float | None = None
    settle: float | None = None
    progress: float | None = None
    bid_margin: float | None = None
    exp_margin: float | None = None
    budget_total: float | None = None
    proc_total: float | None = None
    fin_paid: float | None = None
    sub_contract: float | None = None
    alerts: list[str] = Field(default_factory=list)


class ProjectRowListResponse(BaseModel):
    items: list[ProjectRowSummary]
    total: int
    snapshot: SnapshotSummary | None = None


class ProjectDetailResponse(BaseModel):
    """Full project row including original payload for tabs."""

    summary: ProjectRowSummary
    payload: dict[str, Any] = Field(default_factory=dict)
    snapshot: SnapshotSummary | None = None


class LaborProjectInfo(BaseModel):
    project_key: str
    project_code: str | None = None
    project_name: str
    total_amount: float = 0.0


class LaborCatalogResponse(BaseModel):
    projects: list[LaborProjectInfo]
    categories: list[str]
    months: list[str]


class LaborSeriesPoint(BaseModel):
    period_month: str
    category: str
    amount: float


class LaborProjectSeriesResponse(BaseModel):
    project_key: str
    project_code: str | None = None
    project_name: str
    months: list[str]
    series: dict[str, list[float]]  # category -> amounts aligned to months
    cumulative: dict[str, list[float]]
    points: list[LaborSeriesPoint] = Field(default_factory=list)


class ImportResult(BaseModel):
    ok: bool
    snapshot_id: UUID | None = None
    period: str | None = None
    project_count: int = 0
    linked_projects: int = 0
    labor_rows: int = 0
    replaced: bool = False
    message: str = ""
    source_path: str | None = None


class ImportPathsInfo(BaseModel):
    cost_board_json: str | None = None
    cost_board_json_exists: bool = False
    labor_html: str | None = None
    labor_html_exists: bool = False
    labor_xlsx: str | None = None
    labor_xlsx_exists: bool = False
    thcc_root: str | None = None
