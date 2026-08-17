# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""BCF demo seed - a populated coordination issue register per demo project.

Opens the BCF page on the register a BIM coordinator keeps between model
reviews: a dozen or so topics running from ``Open`` through ``In Progress`` to
``Closed`` (with a couple reopened), each carrying the thread of comments that
argued it out, and most carrying a viewpoint the reviewer can jump the model
to.

BCF is an interoperability format before it is a screen, so every seeded row is
written to survive a real ``.bcfzip`` export:

* the topic type, status and priority come from the BCF 3.0 enumerations the
  module's own writer declares, never from a vocabulary invented here;
* a viewpoint declares exactly one camera - perspective, with a unit direction
  and an up vector orthogonal to it - aimed at a point that really exists in
  the project's model, so ``field_of_view`` applies and
  ``view_to_world_scale`` stays null;
* ``components.selection`` stays empty because it is an IFC GUID list and this
  platform's element identity is a canonical stable id, which is carried in
  ``element_stable_ids`` instead - the documented platform extension for
  exactly this;
* ``snapshot_key`` stays null, because there is no PNG behind it. An export
  writes the viewpoint without an image rather than a broken reference.

Topics are grounded in what the project actually has. Where the clash engine
has already run, the clash-derived topics carry that run's real element names,
disciplines and centroid, and their status and priority come through the
module's own clash-to-BCF maps. The rest are the ordinary coordination
questions raised against real elements of the project's own models.

Dates are anchored to the run date, never hardcoded, and a topic's thread runs
forward: opened, commented on, modified, closed.

Idempotent per project: a project that already carries a topic is left
untouched, and every topic GUID is derived from the project id, so a re-run
neither doubles the register nor renumbers it.
"""

from __future__ import annotations

import logging
import math
import random
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any, Iterable, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.bcf.models import BCFComment, BCFTopic, BCFViewpoint

logger = logging.getLogger(__name__)

_SEED = 42

# Namespace for the deterministic topic / comment / viewpoint GUIDs. A BCF GUID
# has to be a real RFC 4122 UUID (the writer rejects anything else as a topic
# folder name), and deriving it from the project id turns the
# ``(project_id, guid)`` unique constraint into the idempotency key.
_GUID_NS = uuid.UUID("6f0d9c1a-6d3e-4f2a-9d31-0f0a3c5b7e11")

# How many topics a project's register carries, indexed by the project's
# position in the seeding call so two demo projects are never the same size.
# Past the end of the tuple the position wraps and a whole span is added, which
# keeps the mapping injective.
_REGISTER_SIZES = (16, 12, 19, 14)
_SIZE_SPAN = max(_REGISTER_SIZES) - min(_REGISTER_SIZES) + 1

# BCF 3.0 enumerations, mirroring ``app.modules.bcf.writer._DEFAULT_EXTENSIONS``.
# Stage is deliberately absent: the writer ships an empty Stages list, so a
# stage value would be one no extensions document declares.
_TYPE_CLASH = "Clash"
_TYPE_ISSUE = "Issue"
_TYPE_INFORMATION = "Information"
_TYPE_INQUIRY = "Inquiry"
_TYPE_SOLUTION = "Solution"

_STATUS_OPEN = "Open"
_STATUS_IN_PROGRESS = "In Progress"
_STATUS_CLOSED = "Closed"
_STATUS_REOPENED = "ReOpened"

_PRIORITY_CRITICAL = "Critical"
_PRIORITY_MAJOR = "Major"
_PRIORITY_NORMAL = "Normal"
_PRIORITY_MINOR = "Minor"

# Lifecycle mix. A coordination register mid-project is mostly live work with a
# closed tail behind it and the odd item that came back.
_STATUS_WEIGHTS: tuple[tuple[str, int], ...] = (
    (_STATUS_OPEN, 5),
    (_STATUS_IN_PROGRESS, 4),
    (_STATUS_CLOSED, 5),
    (_STATUS_REOPENED, 1),
)
_PRIORITY_WEIGHTS: tuple[tuple[str, int], ...] = (
    (_PRIORITY_CRITICAL, 1),
    (_PRIORITY_MAJOR, 3),
    (_PRIORITY_NORMAL, 5),
    (_PRIORITY_MINOR, 2),
)

# Non-clash topics, one shape per BCF topic type. Each is filled from a real
# element of the project's own model - its type, its storey and its discipline.
_SUBJECTS: tuple[tuple[str, str, str], ...] = (
    (
        _TYPE_ISSUE,
        "{element} at {storey} does not follow the coordinated layout",
        "The {element} placed at {storey} in the {discipline} model sits outside "
        "the zone agreed at the last coordination review. Confirm which position "
        "is correct and reissue.",
    ),
    (
        _TYPE_INQUIRY,
        "Fixing detail required for {element} at {storey}",
        "No fixing detail has been issued for the {element} at {storey}. The "
        "{discipline} package needs it before fabrication can be released.",
    ),
    (
        _TYPE_INFORMATION,
        "{discipline} model revision issued for {storey}",
        "The {discipline} model covering {storey} has been reissued. Downstream "
        "packages should re-run their checks against this revision before "
        "ordering.",
    ),
    (
        _TYPE_SOLUTION,
        "Revised route for {discipline} services at {storey}",
        "A revised route for the {discipline} services at {storey} has been "
        "modelled and clears the {element}. Proposed for acceptance at the next "
        "review.",
    ),
    (
        _TYPE_ISSUE,
        "Access clearance not maintained around {element} at {storey}",
        "The maintenance clearance around the {element} at {storey} is not held "
        "in the coordinated model. Either the {discipline} layout moves or the "
        "clearance is formally reduced.",
    ),
)

# Comment thread. Every line is about the work and none of it names a person -
# the author is a real account on the installation, carried in the BCF Author
# field where a coordination tool expects an email address.
_THREAD_OPENING: tuple[str, ...] = (
    "Raised from the coordination review. Assigned for a response before the next model issue.",
    "Picked up in the model check. Please confirm which side is moving.",
    "Flagged during the weekly coordination call and recorded here for tracking.",
)
_THREAD_MIDDLE: tuple[str, ...] = (
    "Checked against the latest issued model - the condition is still there.",
    "Proposal attached to the viewpoint. Happy to move our elements if the levels allow it.",
    "This one needs the structural engineer to confirm the opening is acceptable.",
    "Discussed on site. The simplest fix is to reroute rather than form a new opening.",
    "Waiting on the revised layout before this can be signed off.",
)
_THREAD_CLOSING: tuple[str, ...] = (
    "Resolved in the current revision. Closing.",
    "Verified against the reissued model - the condition is cleared. Closing.",
    "Agreed and implemented. Closing this topic.",
)
_THREAD_REOPEN: tuple[str, ...] = (
    "Reopening: the condition is back in the latest issue.",
    "Reopening - the fix did not carry through to the reissued model.",
)

# How far back the register runs, and how a topic ages through it.
_HISTORY_DAYS = 140
_DUE_MIN_DAYS = 10
_DUE_MAX_DAYS = 45

# A perspective camera stands back from what it looks at by this many times the
# size of the thing, and half that above it. Same idea as the module's own
# ``synthesize_viewpoint_from_centroid``, scaled to the element rather than
# fixed at five metres, so a viewpoint on a whole storey is not inside a wall.
_STANDOFF_FACTOR = 1.8
_MIN_STANDOFF_M = 4.0
_FIELD_OF_VIEW = 60.0


def _is_demo_project(metadata: Any) -> bool:
    """Whether a project row's metadata marks it as a demo project.

    Both installers that create demo projects stamp ``demo_id``: the showcase
    templates in ``app/core/demo_projects.py`` and the flagship in
    ``app/scripts/seed_flagship.py``. Nothing else writes that key, so its
    presence is what separates a project we may fill with invented coordination
    issues from a project somebody is actually building. Read ``demo_id`` and
    not ``is_demo``: the flagship carries the former and not the latter.
    """
    return isinstance(metadata, dict) and bool(str(metadata.get("demo_id") or "").strip())


def _rng_for(project_id: uuid.UUID) -> random.Random:
    """A deterministic RNG per project, so a re-seed reproduces the register."""
    return random.Random(f"{_SEED}:{project_id}")


def _guid(project_id: uuid.UUID, kind: str, index: int, sub: int = 0) -> str:
    """A stable RFC 4122 GUID for one seeded row of ``kind`` in a project."""
    return str(uuid.uuid5(_GUID_NS, f"{project_id}:{kind}:{index}:{sub}"))


def _weighted(rng: random.Random, weights: Sequence[tuple[str, int]]) -> str:
    """Draw one value from ``(value, weight)`` pairs."""
    values = [value for value, _ in weights]
    return rng.choices(values, weights=[weight for _, weight in weights], k=1)[0]


def _unit(vec: tuple[float, float, float]) -> tuple[float, float, float]:
    """Normalise a vector, falling back to -Y when it has no length."""
    x, y, z = vec
    length = math.sqrt(x * x + y * y + z * z)
    if length < 1e-9:
        return (0.0, -1.0, 0.0)
    return (x / length, y / length, z / length)


def _orthonormal_up(direction: tuple[float, float, float]) -> tuple[float, float, float]:
    """The up vector for ``direction``: world up, made perpendicular to it.

    BCF stores the camera basis explicitly, and a viewer that trusts it will
    shear the view if up is not perpendicular to the direction, so up is
    Gram-Schmidt corrected rather than left at world +Z.
    """
    dx, dy, dz = direction
    world_up = (0.0, 0.0, 1.0)
    dot = dx * world_up[0] + dy * world_up[1] + dz * world_up[2]
    candidate = (
        world_up[0] - dot * dx,
        world_up[1] - dot * dy,
        world_up[2] - dot * dz,
    )
    if math.sqrt(sum(component * component for component in candidate)) < 1e-6:
        # Looking straight up or down: any perpendicular will do, take +Y.
        candidate = (0.0, 1.0, 0.0)
    return _unit(candidate)


def _vec_json(vec: tuple[float, float, float]) -> dict[str, float]:
    """A BCF XYZ triplet in the JSON shape the codec reads back."""
    return {"x": float(vec[0]), "y": float(vec[1]), "z": float(vec[2])}


def _camera_looking_at(
    target: tuple[float, float, float],
    size: float,
) -> dict[str, Any]:
    """Build the perspective camera JSON for a camera aimed at ``target``.

    The camera stands off to the south of the target and above it, looking back
    down at it - the coordination view a reviewer would set up by hand.
    """
    standoff = max(_MIN_STANDOFF_M, size * _STANDOFF_FACTOR)
    view_point = (target[0], target[1] - standoff, target[2] + standoff * 0.5)
    direction = _unit(
        (
            target[0] - view_point[0],
            target[1] - view_point[1],
            target[2] - view_point[2],
        ),
    )
    return {
        "camera_view_point": _vec_json(view_point),
        "camera_direction": _vec_json(direction),
        "camera_up_vector": _vec_json(_orthonormal_up(direction)),
    }


async def _project_authors(session: AsyncSession, owner_id: uuid.UUID) -> list[str]:
    """Return the accounts that author topics and comments, as BCF author labels.

    BCF carries an author as a plain string and every coordination tool writes
    an email address there, so the seeded rows use the real accounts on this
    installation rather than a name invented here.
    """
    try:
        from app.modules.users.models import User

        rows = (await session.execute(select(User.email).where(User.is_active.is_(True)).order_by(User.email))).all()
    except Exception:
        logger.debug("User lookup unavailable for the BCF register")
        rows = []
    authors = [str(email).strip() for (email,) in rows if str(email or "").strip()]
    if authors:
        return authors[:6]
    try:
        from app.modules.users.models import User

        owner_email = (await session.execute(select(User.email).where(User.id == owner_id))).scalars().first()
    except Exception:
        owner_email = None
    return [str(owner_email)] if owner_email else []


async def _project_models(session: AsyncSession, project_id: uuid.UUID) -> list[tuple[uuid.UUID, str, str]]:
    """Return ``(model_id, name, discipline)`` for the project's own BIM models."""
    try:
        from app.modules.bim_hub.models import BIMModel

        stmt = (
            select(BIMModel.id, BIMModel.name, BIMModel.discipline)
            .where(BIMModel.project_id == project_id)
            .order_by(BIMModel.name)
        )
        rows = (await session.execute(stmt)).all()
    except Exception:
        logger.debug("BIM model lookup unavailable for project=%s", project_id)
        return []
    return [(mid, str(name or "Model"), str(discipline or "Coordination")) for mid, name, discipline in rows]


async def _project_elements(session: AsyncSession, project_id: uuid.UUID) -> list[dict[str, Any]]:
    """Return a sample of the project's real BIM elements, newest models first.

    Only elements that carry a bounding box are returned: a topic is only given
    a viewpoint when there is a real place to point the camera at.
    """
    try:
        from app.modules.bim_hub.models import BIMElement, BIMModel

        stmt = (
            select(
                BIMElement.stable_id,
                BIMElement.name,
                BIMElement.element_type,
                BIMElement.storey,
                BIMElement.discipline,
                BIMElement.bounding_box,
                BIMModel.id,
            )
            .join(BIMModel, BIMElement.model_id == BIMModel.id)
            .where(BIMModel.project_id == project_id, BIMElement.bounding_box.isnot(None))
            .order_by(BIMElement.stable_id)
            .limit(200)
        )
        rows = (await session.execute(stmt)).all()
    except Exception:
        logger.debug("BIM element lookup unavailable for project=%s", project_id)
        return []

    out: list[dict[str, Any]] = []
    for stable_id, name, element_type, storey, discipline, bbox, model_id in rows:
        if not isinstance(bbox, dict):
            continue
        try:
            low = (float(bbox["min_x"]), float(bbox["min_y"]), float(bbox["min_z"]))
            high = (float(bbox["max_x"]), float(bbox["max_y"]), float(bbox["max_z"]))
        except (KeyError, TypeError, ValueError):
            continue
        out.append(
            {
                "stable_id": str(stable_id),
                "name": str(name or element_type or "Element"),
                "element_type": str(element_type or "element"),
                "storey": str(storey or "the modelled level"),
                "discipline": str(discipline or "Coordination"),
                "centre": tuple((lo + hi) / 2.0 for lo, hi in zip(low, high, strict=True)),
                "size": max(hi - lo for lo, hi in zip(low, high, strict=True)),
                "model_id": model_id,
            },
        )
    return out


async def _project_clashes(session: AsyncSession, project_id: uuid.UUID, limit: int) -> list[dict[str, Any]]:
    """Return the project's own clash results, worst first, for clash topics.

    Read only - the clash rows are somebody else's data. When the clash engine
    has not run on this project the list is empty and the register is made up of
    ordinary coordination topics instead.
    """
    try:
        from app.modules.clash.models import ClashResult, ClashRun

        stmt = (
            select(
                ClashResult.a_name,
                ClashResult.b_name,
                ClashResult.a_discipline,
                ClashResult.b_discipline,
                ClashResult.a_stable_id,
                ClashResult.b_stable_id,
                ClashResult.clash_type,
                ClashResult.severity,
                ClashResult.status,
                ClashResult.cx,
                ClashResult.cy,
                ClashResult.cz,
            )
            .join(ClashRun, ClashResult.run_id == ClashRun.id)
            .where(ClashRun.project_id == project_id)
            .order_by(ClashResult.created_at.desc())
            .limit(limit)
        )
        rows = (await session.execute(stmt)).all()
    except Exception:
        logger.debug("Clash lookup unavailable for project=%s", project_id)
        return []

    out: list[dict[str, Any]] = []
    for row in rows:
        out.append(
            {
                "a_name": str(row[0] or "Element A"),
                "b_name": str(row[1] or "Element B"),
                "a_discipline": str(row[2] or "Unassigned"),
                "b_discipline": str(row[3] or "Unassigned"),
                "a_stable_id": str(row[4] or ""),
                "b_stable_id": str(row[5] or ""),
                "clash_type": str(row[6] or "hard"),
                "severity": str(row[7] or "medium").lower(),
                "status": str(row[8] or "new").lower(),
                "centroid": (float(row[9] or 0.0), float(row[10] or 0.0), float(row[11] or 0.0)),
            },
        )
    return out


def _clash_topic(clash: dict[str, Any]) -> dict[str, Any]:
    """Turn one real clash row into the BCF fields a clash topic carries.

    The status and priority come from the module's own clash-to-BCF maps (the
    ones the clash export uses), so a seeded clash topic says exactly what an
    exported one would.
    """
    from app.modules.bcf.service import BCFExportService

    status = BCFExportService._STATUS_MAP.get(clash["status"], _STATUS_OPEN)  # noqa: SLF001 - same module
    priority = BCFExportService._PRIORITY_MAP.get(clash["severity"], _PRIORITY_NORMAL)  # noqa: SLF001
    title = f"{clash['a_name']} x {clash['b_name']} ({clash['clash_type']})"
    description = (
        f"Discipline A: {clash['a_discipline']}\n"
        f"Discipline B: {clash['b_discipline']}\n"
        f"Clash type: {clash['clash_type']}\n"
        f"Raised from the clash run on this project."
    )
    stable_ids = [sid for sid in (clash["a_stable_id"], clash["b_stable_id"]) if sid]
    return {
        "topic_type": _TYPE_CLASH,
        "topic_status": status,
        "priority": priority,
        "title": title[:500],
        "description": description,
        "labels": [clash["clash_type"], clash["severity"]],
        "centre": clash["centroid"] if clash["centroid"] != (0.0, 0.0, 0.0) else None,
        "size": 2.0,
        "stable_ids": stable_ids,
    }


def _element_topic(rng: random.Random, element: dict[str, Any], index: int) -> dict[str, Any]:
    """Turn one real element into the BCF fields an ordinary topic carries."""
    topic_type, title_template, description_template = _SUBJECTS[index % len(_SUBJECTS)]
    fields = {
        "element": element["element_type"],
        "storey": element["storey"],
        "discipline": element["discipline"],
    }
    return {
        "topic_type": topic_type,
        "topic_status": _weighted(rng, _STATUS_WEIGHTS),
        "priority": _weighted(rng, _PRIORITY_WEIGHTS),
        "title": title_template.format(**fields)[:500],
        "description": description_template.format(**fields),
        "labels": [element["discipline"]],
        "centre": element["centre"],
        "size": element["size"],
        "stable_ids": [element["stable_id"]],
    }


def _thread(
    rng: random.Random,
    *,
    topic_status: str,
    opened: datetime,
    authors: Sequence[str],
) -> list[tuple[str, str, datetime]]:
    """Build a topic's comment thread as ``(text, author, date)``, oldest first.

    The thread runs forward from the day the topic was opened and ends the way
    its status says it ended: a closed topic has somebody closing it, a
    reopened one has somebody closing it and then taking it back.
    """
    out: list[tuple[str, str, datetime]] = []
    cursor = opened + timedelta(hours=rng.randint(4, 30))
    out.append((rng.choice(_THREAD_OPENING), authors[0], cursor))

    for _ in range(rng.randint(0, 3)):
        cursor = cursor + timedelta(days=rng.randint(1, 9), hours=rng.randint(0, 8))
        out.append((rng.choice(_THREAD_MIDDLE), rng.choice(authors), cursor))

    if topic_status in (_STATUS_CLOSED, _STATUS_REOPENED):
        cursor = cursor + timedelta(days=rng.randint(1, 7))
        out.append((rng.choice(_THREAD_CLOSING), rng.choice(authors), cursor))
    if topic_status == _STATUS_REOPENED:
        cursor = cursor + timedelta(days=rng.randint(2, 20))
        out.append((rng.choice(_THREAD_REOPEN), rng.choice(authors), cursor))
    return out


async def _seed_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    owner_id: uuid.UUID,
    ordinal: int,
) -> dict[str, int]:
    """Seed one project's register. Returns per-entity counts (zeros when skipped)."""
    empty = {"projects": 0, "topics": 0, "comments": 0, "viewpoints": 0}

    already = (
        (await session.execute(select(BCFTopic.id).where(BCFTopic.project_id == project_id).limit(1))).scalars().first()
    )
    if already is not None:
        return empty

    models = await _project_models(session, project_id)
    elements = await _project_elements(session, project_id)
    if not models and not elements:
        # BCF is a BIM coordination format. On a project with no model there is
        # nothing to coordinate and every topic would be pure invention, so the
        # register is left empty rather than filled in.
        logger.debug("BCF demo skipped for project=%s (no BIM model)", project_id)
        return empty

    authors = await _project_authors(session, owner_id)
    if not authors:
        logger.debug("BCF demo skipped for project=%s (no account to author a topic)", project_id)
        return empty

    rng = _rng_for(project_id)
    slot = ordinal % len(_REGISTER_SIZES)
    size = _REGISTER_SIZES[slot] + (ordinal // len(_REGISTER_SIZES)) * _SIZE_SPAN
    clashes = await _project_clashes(session, project_id, limit=max(2, size // 3))
    now = datetime.now(UTC)
    default_model_id = str(models[0][0]) if models else None

    counts = {"projects": 1, "topics": 0, "comments": 0, "viewpoints": 0}
    for index in range(size):
        if index < len(clashes):
            spec = _clash_topic(clashes[index])
        elif elements:
            spec = _element_topic(rng, elements[(index * 7) % len(elements)], index)
        else:
            # Models but no elements with geometry: still a real coordination
            # question about a real model, just without a place to stand.
            model_name, model_discipline = models[index % len(models)][1:3]
            spec = {
                "topic_type": _TYPE_INFORMATION,
                "topic_status": _weighted(rng, _STATUS_WEIGHTS),
                "priority": _weighted(rng, _PRIORITY_WEIGHTS),
                "title": f"{model_discipline} model revision issued: {model_name}"[:500],
                "description": (
                    f"The {model_discipline} model '{model_name}' has been reissued. "
                    "Downstream packages should re-run their checks against this revision."
                ),
                "labels": [model_discipline],
                "centre": None,
                "size": 0.0,
                "stable_ids": [],
            }

        opened = now - timedelta(
            days=rng.randint(1, _HISTORY_DAYS),
            hours=rng.randint(0, 20),
        )
        thread = _thread(rng, topic_status=spec["topic_status"], opened=opened, authors=authors)
        modified = thread[-1][2] if thread else opened
        status = spec["topic_status"]
        due_date = (
            opened + timedelta(days=rng.randint(_DUE_MIN_DAYS, _DUE_MAX_DAYS))
            if status in (_STATUS_OPEN, _STATUS_IN_PROGRESS, _STATUS_REOPENED)
            else None
        )

        topic = BCFTopic(
            guid=_guid(project_id, "topic", index),
            project_id=project_id,
            bim_model_id=default_model_id,
            title=spec["title"],
            description=spec["description"],
            topic_type=spec["topic_type"],
            topic_status=status,
            priority=spec["priority"],
            topic_index=index + 1,
            assigned_to=rng.choice(authors),
            due_date=due_date,
            labels=list(spec["labels"]),
            reference_links=[],
            creation_author=authors[0],
            creation_date=opened,
            modified_author=thread[-1][1] if thread else authors[0],
            modified_date=modified,
            created_by=str(owner_id),
            metadata_={},
        )
        session.add(topic)
        await session.flush()
        counts["topics"] += 1

        viewpoint_guid: str | None = None
        centre = spec["centre"]
        # Roughly two topics in three carry a viewpoint, and only where there
        # is a real point in the model to aim at.
        if centre is not None and index % 3 != 2:
            viewpoint_guid = _guid(project_id, "viewpoint", index)
            session.add(
                BCFViewpoint(
                    guid=viewpoint_guid,
                    topic_id=topic.id,
                    vp_index=0,
                    camera_type="perspective",
                    camera=_camera_looking_at(centre, float(spec["size"] or 0.0)),
                    components={
                        # Selection is an IFC GUID list and this platform's
                        # element identity is a canonical stable id, so the
                        # elements are carried in element_stable_ids instead.
                        "selection": [],
                        "visible": [],
                        "hidden": [],
                        "default_visibility": True,
                    },
                    lines=[],
                    clipping_planes=[],
                    element_stable_ids=list(spec["stable_ids"]),
                    snapshot_key=None,
                    snapshot_type=None,
                    field_of_view=_FIELD_OF_VIEW,
                    # A perspective camera has no view-to-world scale; that is
                    # the orthogonal camera's field.
                    view_to_world_scale=None,
                    created_by=str(owner_id),
                    metadata_={},
                ),
            )
            counts["viewpoints"] += 1

        for comment_index, (text, author, when) in enumerate(thread):
            session.add(
                BCFComment(
                    guid=_guid(project_id, "comment", index, comment_index),
                    topic_id=topic.id,
                    comment_text=text,
                    author=author,
                    date=when,
                    modified_author=author,
                    modified_date=when,
                    # Only the opening comment carries the viewpoint, the way a
                    # reviewer attaches the view once and then discusses it.
                    viewpoint_guid=viewpoint_guid if comment_index == 0 else None,
                    created_by=str(owner_id),
                    metadata_={},
                ),
            )
            counts["comments"] += 1
    await session.flush()
    return counts


async def seed_bcf_demo(
    session: AsyncSession,
    project_ids: Iterable[uuid.UUID],
) -> dict[str, int]:
    """Populate the BCF coordination register for the given demo projects.

    Args:
        session: Async DB session. The caller commits.
        project_ids: Candidate projects. Anything that is not a demo project
            is skipped outright; a demo project is skipped when it already
            carries a topic, or when it has no BIM model to coordinate
            against. Every demo project given is seeded - there is no cap.

    Returns:
        Dict with per-entity insert counts across every project seeded.
    """
    totals = {"projects": 0, "topics": 0, "comments": 0, "viewpoints": 0}
    ids = list(project_ids)
    if not ids:
        return totals

    from app.modules.projects.models import Project

    # The caller hands us every project in the database, not only demo ones,
    # and the backfill around it re-runs once per app version - so it fires
    # again on every upgrade. That makes "has no topics yet" the wrong gate on
    # its own: a real customer project that has simply recorded no coordination
    # issues is also empty of them, and would receive a register of invented
    # defects on their next upgrade. Demo projects are marked, so read the
    # marker. Emptiness stays on top of this as the idempotency guard.
    rows = (
        await session.execute(select(Project.id, Project.owner_id, Project.metadata_).where(Project.id.in_(ids)))
    ).all()
    owners = {pid: owner for pid, owner, meta in rows if _is_demo_project(meta)}
    # Filtering before the enumerate keeps the ordinal dense, so the register
    # size a project draws never depends on how many projects that are not
    # being seeded happen to sort ahead of it.
    ids = [pid for pid in ids if pid in owners]

    for ordinal, project_id in enumerate(ids):
        owner_id = owners[project_id]
        try:
            # A SAVEPOINT per project, so one project that cannot be seeded
            # costs only its own rows. Catching the exception is not enough on
            # PostgreSQL: a failed statement aborts the whole transaction, and
            # every later project would then fail on a poisoned session rather
            # than on anything wrong with itself.
            async with session.begin_nested():
                counts = await _seed_project(session, project_id, owner_id, ordinal)
        except Exception:
            logger.warning("BCF demo seed skipped for project=%s (non-fatal)", project_id, exc_info=True)
            continue
        for key, value in counts.items():
            totals[key] += value
    return totals
