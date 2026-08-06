# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
"""Unit tests for project duplicate grouping."""

from datetime import UTC, datetime

from app.modules.projects.dedupe import (
    ProjectDedupeKey,
    group_duplicates,
    normalize_project_code,
    normalize_project_name,
    pick_keeper,
)


def _p(
    id: str,
    name: str,
    code: str | None = None,
    status: str = "active",
    updated: datetime | None = None,
    created: datetime | None = None,
) -> ProjectDedupeKey:
    return ProjectDedupeKey(
        id=id,
        name=name,
        project_code=code,
        status=status,
        updated_at=updated,
        created_at=created,
    )


def test_normalize():
    assert normalize_project_code(" thcc-2026-004 ") == "THCC-2026-004"
    assert normalize_project_name("  北新建材  大城府 ") == "北新建材 大城府"
    assert normalize_project_name("ABC") == normalize_project_name("abc")


def test_pick_keeper_prefers_non_archived_and_newest():
    old = _p(
        "1",
        "A",
        "C1",
        "active",
        updated=datetime(2024, 1, 1, tzinfo=UTC),
    )
    newer = _p(
        "2",
        "A",
        "C1",
        "active",
        updated=datetime(2025, 6, 1, tzinfo=UTC),
    )
    arch = _p(
        "3",
        "A",
        "C1",
        "archived",
        updated=datetime(2026, 1, 1, tzinfo=UTC),
    )
    assert pick_keeper([old, newer, arch]).id == "2"


def test_group_by_code_and_name():
    t0 = datetime(2025, 1, 1, tzinfo=UTC)
    t1 = datetime(2025, 6, 1, tzinfo=UTC)
    rows = [
        _p("a1", "北新建材", "THCC-1", updated=t0),
        _p("a2", "北新建材 copy", "THCC-1", updated=t1),
        _p("b1", "天顿", None, updated=t0),
        _p("b2", "天顿", None, updated=t1),
        _p("c1", "唯一项目", "THCC-X", updated=t0),
    ]
    groups = group_duplicates(rows)
    assert len(groups) == 2
    by_type = {g["key_type"]: g for g in groups}
    assert by_type["project_code"]["keep_id"] == "a2"
    assert set(by_type["project_code"]["archive_ids"]) == {"a1"}
    assert by_type["name"]["keep_id"] == "b2"
    assert set(by_type["name"]["archive_ids"]) == {"b1"}


def test_same_name_different_codes_are_name_grouped():
    """Keepers of distinct codes still collapse when display names match."""
    t0 = datetime(2025, 1, 1, tzinfo=UTC)
    t1 = datetime(2025, 6, 1, tzinfo=UTC)
    rows = [
        _p("z1", "中石科技", "THCC-2021-002", "finished", updated=t0),
        _p("z2", "中石科技", "THCC-2023-007", "finished", updated=t1),
        # already-archived twin under z2's code should not inflate archive_ids
        _p("z3", "中石科技", "THCC-2023-007", "archived", updated=t0),
    ]
    groups = group_duplicates(rows)
    assert len(groups) == 1
    g = groups[0]
    assert g["key_type"] == "name"
    assert g["keep_id"] == "z2"
    assert g["archive_ids"] == ["z1"]


def test_already_archived_code_twins_not_reported():
    t0 = datetime(2025, 1, 1, tzinfo=UTC)
    rows = [
        _p("k1", "海螺", "THCC-2019-001", "finished", updated=t0),
        _p("k2", "海螺", "THCC-2019-001", "archived", updated=t0),
    ]
    assert group_duplicates(rows) == []
