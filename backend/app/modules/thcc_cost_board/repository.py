# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""DB access for THCC cost board."""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.modules.thcc_cost_board.models import (
    ThccCostProjectRow,
    ThccCostSnapshot,
    ThccLaborSeries,
)


class ThccCostBoardRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ── Snapshots ─────────────────────────────────────────────────────

    async def list_snapshots(self) -> Sequence[ThccCostSnapshot]:
        stmt = select(ThccCostSnapshot).order_by(ThccCostSnapshot.period.desc())
        return (await self.session.execute(stmt)).scalars().all()

    async def get_snapshot(self, snapshot_id: uuid.UUID) -> ThccCostSnapshot | None:
        stmt = (
            select(ThccCostSnapshot)
            .where(ThccCostSnapshot.id == snapshot_id)
            .options(selectinload(ThccCostSnapshot.projects))
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_snapshot_by_period(self, period: str) -> ThccCostSnapshot | None:
        stmt = select(ThccCostSnapshot).where(ThccCostSnapshot.period == period)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_latest_active_snapshot(self) -> ThccCostSnapshot | None:
        stmt = (
            select(ThccCostSnapshot)
            .where(ThccCostSnapshot.status == "active")
            .order_by(ThccCostSnapshot.period.desc())
            .limit(1)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def count_projects(self, snapshot_id: uuid.UUID) -> int:
        stmt = select(func.count()).select_from(ThccCostProjectRow).where(
            ThccCostProjectRow.snapshot_id == snapshot_id
        )
        return int((await self.session.execute(stmt)).scalar_one())

    async def delete_snapshot(self, snapshot: ThccCostSnapshot) -> None:
        await self.session.delete(snapshot)

    async def add_snapshot(self, snapshot: ThccCostSnapshot) -> ThccCostSnapshot:
        self.session.add(snapshot)
        await self.session.flush()
        return snapshot

    # ── Project rows ──────────────────────────────────────────────────

    async def list_project_rows(
        self,
        snapshot_id: uuid.UUID,
        *,
        bucket: str | None = None,
        risk: str | None = None,
        q: str | None = None,
    ) -> Sequence[ThccCostProjectRow]:
        stmt = select(ThccCostProjectRow).where(ThccCostProjectRow.snapshot_id == snapshot_id)
        if bucket:
            stmt = stmt.where(ThccCostProjectRow.bucket == bucket)
        if risk:
            stmt = stmt.where(ThccCostProjectRow.risk == risk)
        if q:
            like = f"%{q.strip()}%"
            stmt = stmt.where(
                (ThccCostProjectRow.project_code.ilike(like))
                | (ThccCostProjectRow.name.ilike(like))
                | (ThccCostProjectRow.full_name.ilike(like))
            )
        stmt = stmt.order_by(ThccCostProjectRow.project_code.asc())
        return (await self.session.execute(stmt)).scalars().all()

    async def get_project_row(self, row_id: uuid.UUID) -> ThccCostProjectRow | None:
        stmt = select(ThccCostProjectRow).where(ThccCostProjectRow.id == row_id)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_project_row_by_code(
        self, snapshot_id: uuid.UUID, project_code: str
    ) -> ThccCostProjectRow | None:
        stmt = select(ThccCostProjectRow).where(
            ThccCostProjectRow.snapshot_id == snapshot_id,
            ThccCostProjectRow.project_code == project_code,
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def get_project_row_by_oce_id(
        self, snapshot_id: uuid.UUID, project_id: uuid.UUID
    ) -> ThccCostProjectRow | None:
        stmt = select(ThccCostProjectRow).where(
            ThccCostProjectRow.snapshot_id == snapshot_id,
            ThccCostProjectRow.project_id == project_id,
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    # ── Labour ────────────────────────────────────────────────────────

    async def clear_labor(self) -> int:
        result = await self.session.execute(delete(ThccLaborSeries))
        return int(result.rowcount or 0)

    async def add_labor_rows(self, rows: list[ThccLaborSeries]) -> None:
        self.session.add_all(rows)
        await self.session.flush()

    async def list_labor_projects(self) -> Sequence[tuple]:
        """Distinct projects with total (sum of total_labor)."""
        stmt = (
            select(
                ThccLaborSeries.project_key,
                ThccLaborSeries.project_code,
                ThccLaborSeries.project_name,
                func.coalesce(func.sum(ThccLaborSeries.amount), 0),
            )
            .where(ThccLaborSeries.category == "total_labor")
            .group_by(
                ThccLaborSeries.project_key,
                ThccLaborSeries.project_code,
                ThccLaborSeries.project_name,
            )
            .order_by(ThccLaborSeries.project_name.asc())
        )
        return (await self.session.execute(stmt)).all()

    async def labor_months(self) -> list[str]:
        stmt = (
            select(ThccLaborSeries.period_month)
            .distinct()
            .order_by(ThccLaborSeries.period_month.asc())
        )
        return list((await self.session.execute(stmt)).scalars().all())

    async def labor_series_for_project(self, project_key: str) -> Sequence[ThccLaborSeries]:
        stmt = (
            select(ThccLaborSeries)
            .where(ThccLaborSeries.project_key == project_key)
            .order_by(ThccLaborSeries.period_month.asc(), ThccLaborSeries.category.asc())
        )
        return (await self.session.execute(stmt)).scalars().all()

    async def labor_series_by_code(self, project_code: str) -> Sequence[ThccLaborSeries]:
        stmt = (
            select(ThccLaborSeries)
            .where(ThccLaborSeries.project_code == project_code)
            .order_by(ThccLaborSeries.period_month.asc(), ThccLaborSeries.category.asc())
        )
        return (await self.session.execute(stmt)).scalars().all()
