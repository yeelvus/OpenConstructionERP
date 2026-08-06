# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Pure helpers for detecting duplicate projects by code / name.

Used by Excel import (skip) and the bulk archive-dedupe endpoint.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any


def normalize_project_code(code: str | None) -> str:
    return (code or "").strip().upper()


def normalize_project_name(name: str | None) -> str:
    """Case-fold + collapse whitespace for name matching."""
    return " ".join((name or "").casefold().split())


@dataclass(frozen=True)
class ProjectDedupeKey:
    """Identity of one project row for grouping."""

    id: str
    name: str
    project_code: str | None
    status: str
    updated_at: datetime | None
    created_at: datetime | None


def _ts(value: datetime | None) -> float:
    if value is None:
        return 0.0
    try:
        return value.timestamp()
    except Exception:  # noqa: BLE001
        return 0.0


def pick_keeper(group: list[ProjectDedupeKey]) -> ProjectDedupeKey:
    """Choose the project to keep in a duplicate group.

    Preference:
      1. Non-archived over archived
      2. Most recently updated
      3. Most recently created
      4. Stable id for determinism
    """

    def rank(p: ProjectDedupeKey) -> tuple:
        archived = 1 if (p.status or "").lower() == "archived" else 0
        return (archived, -_ts(p.updated_at), -_ts(p.created_at), p.id)

    return min(group, key=rank)


def _is_archived(p: ProjectDedupeKey) -> bool:
    return (p.status or "").lower() == "archived"


def _archive_targets(members: list[ProjectDedupeKey], keeper: ProjectDedupeKey) -> list[ProjectDedupeKey]:
    """Non-keeper members that still need archiving (skip already archived)."""
    return [m for m in members if m.id != keeper.id and not _is_archived(m)]


def group_duplicates(
    projects: list[ProjectDedupeKey],
) -> list[dict[str, Any]]:
    """Group projects that share a non-empty code or normalized name.

    Pass 1 — project_code: identical codes collapse to one keeper.
    Pass 2 — name: among projects not already scheduled for archive,
    identical normalized names collapse to one keeper (covers same-site
    re-imports that used different year codes).

    ``archive_ids`` only lists *non-archived* extras so re-runs are
    idempotent and previews report true pending work.
    """
    by_code: dict[str, list[ProjectDedupeKey]] = {}
    for p in projects:
        code = normalize_project_code(p.project_code)
        if code:
            by_code.setdefault(code, []).append(p)

    # IDs already slated for archive (must not be keepers later / re-grouped)
    pending_archive: set[str] = set()
    groups: list[dict[str, Any]] = []

    for code, members in sorted(by_code.items()):
        # Need at least two non-archived, or one non-archived + archived twins
        # that leave only one live keeper — only act when >1 non-archived.
        live = [m for m in members if not _is_archived(m)]
        if len(live) < 2 and len(members) < 2:
            continue
        if len(live) < 2:
            # All extras already archived — nothing pending
            continue
        keeper = pick_keeper(members)
        archive = _archive_targets(members, keeper)
        if not archive:
            continue
        for m in archive:
            pending_archive.add(m.id)
        groups.append(
            {
                "key_type": "project_code",
                "key": code,
                "keep_id": keeper.id,
                "keep_name": keeper.name,
                "archive_ids": [m.id for m in archive],
                "archive_names": [m.name for m in archive],
                "count": len(live),
            }
        )

    by_name: dict[str, list[ProjectDedupeKey]] = {}
    for p in projects:
        # Skip rows already marked for archive; keepers of code-groups may
        # still participate so same-name different-code twins are caught.
        if p.id in pending_archive:
            continue
        if _is_archived(p):
            continue
        key = normalize_project_name(p.name)
        if not key:
            continue
        by_name.setdefault(key, []).append(p)

    for name_key, members in sorted(by_name.items()):
        if len(members) < 2:
            continue
        keeper = pick_keeper(members)
        archive = _archive_targets(members, keeper)
        if not archive:
            continue
        groups.append(
            {
                "key_type": "name",
                "key": name_key,
                "keep_id": keeper.id,
                "keep_name": keeper.name,
                "archive_ids": [m.id for m in archive],
                "archive_names": [m.name for m in archive],
                "count": len(members),
            }
        )

    return groups
