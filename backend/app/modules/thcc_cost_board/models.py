# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""THCC cost board ORM models.

Tables:
    oe_thcc_cost_snapshot     - one monthly portfolio snapshot
    oe_thcc_cost_project_row  - one project line inside a snapshot (payload jsonb)
    oe_thcc_labor_series      - monthly labour amounts by project / category
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import GUID, Base


class ThccCostSnapshot(Base):
    """One imported monthly cost-board snapshot (portfolio layer)."""

    __tablename__ = "oe_thcc_cost_snapshot"
    __table_args__ = (
        UniqueConstraint("period", name="uq_thcc_cost_snapshot_period"),
        Index("ix_thcc_cost_snapshot_status", "status"),
    )

    # YYYY-MM commercial period
    period: Mapped[str] = mapped_column(String(7), nullable=False)
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Display label from source, e.g. "2026年06月"
    period_label: Mapped[str | None] = mapped_column(String(64), nullable=True)
    fx_cny_to_thb: Mapped[Decimal | None] = mapped_column(Numeric(12, 6), nullable=True)
    unit: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # draft | active | archived
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", index=True)
    source_generated_at: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source_meta: Mapped[dict] = mapped_column(
        JSON,
        nullable=False,
        default=dict,
        server_default="{}",
    )
    imported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    imported_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    projects: Mapped[list["ThccCostProjectRow"]] = relationship(
        back_populates="snapshot",
        cascade="all, delete-orphan",
        lazy="selectin",
    )

    def __repr__(self) -> str:
        return f"<ThccCostSnapshot {self.period} ({self.status})>"


class ThccCostProjectRow(Base):
    """One project inside a cost snapshot.

    Scalar columns used for list sort / filter; full original dict in ``payload``.
    """

    __tablename__ = "oe_thcc_cost_project_row"
    __table_args__ = (
        UniqueConstraint("snapshot_id", "project_code", name="uq_thcc_cost_row_snap_code"),
        Index("ix_thcc_cost_row_bucket", "snapshot_id", "bucket"),
        Index("ix_thcc_cost_row_risk", "snapshot_id", "risk"),
        Index("ix_thcc_cost_row_project_id", "project_id"),
    )

    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        GUID(),
        ForeignKey("oe_thcc_cost_snapshot.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Optional link to OCE project master (matched by project_code on import)
    project_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), nullable=True, index=True)
    project_code: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    full_name: Mapped[str | None] = mapped_column(String(512), nullable=True)
    bucket: Mapped[str | None] = mapped_column(String(32), nullable=True)  # 在建 / 完工 …
    status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    risk: Mapped[str | None] = mapped_column(String(32), nullable=True)  # danger / warn / ok
    pm: Mapped[str | None] = mapped_column(String(255), nullable=True)

    contract: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    resp_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    actual: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    forecast: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    settle: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    progress: Mapped[Decimal | None] = mapped_column(Numeric(12, 6), nullable=True)
    bid_margin: Mapped[Decimal | None] = mapped_column(Numeric(12, 6), nullable=True)
    exp_margin: Mapped[Decimal | None] = mapped_column(Numeric(12, 6), nullable=True)
    budget_total: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    proc_total: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    fin_paid: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)
    sub_contract: Mapped[Decimal | None] = mapped_column(Numeric(18, 4), nullable=True)

    payload: Mapped[dict] = mapped_column(
        JSON,
        nullable=False,
        default=dict,
        server_default="{}",
    )

    snapshot: Mapped["ThccCostSnapshot"] = relationship(back_populates="projects")

    def __repr__(self) -> str:
        return f"<ThccCostProjectRow {self.project_code} {self.name}>"


class ThccLaborSeries(Base):
    """Monthly labour amount for one project / category (万泰铢)."""

    __tablename__ = "oe_thcc_labor_series"
    __table_args__ = (
        UniqueConstraint(
            "period_month",
            "project_key",
            "category",
            name="uq_thcc_labor_period_proj_cat",
        ),
        Index("ix_thcc_labor_project_code", "project_code"),
        Index("ix_thcc_labor_project_key", "project_key"),
    )

    # Source key e.g. project_1 (stable within one HTML export)
    project_key: Mapped[str] = mapped_column(String(64), nullable=False, default="")
    project_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    project_name: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    # YYYY-MM
    period_month: Mapped[str] = mapped_column(String(7), nullable=False)
    # zh_formal | zh_labor | local_labor | outsourcing_labor | visa_fee | total_labor
    category: Mapped[str] = mapped_column(String(64), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False, default=Decimal("0"))
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="THB")
    unit: Mapped[str | None] = mapped_column(String(64), nullable=True)
    source: Mapped[str | None] = mapped_column(String(64), nullable=True)

    def __repr__(self) -> str:
        return f"<ThccLaborSeries {self.project_name} {self.period_month} {self.category}>"
