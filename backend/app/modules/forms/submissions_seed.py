# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Filled-in forms for the demo projects, against the starter templates.

The forms library ships with starter templates from the first boot, but nothing
has ever filled one in outside a live request, so every demo project's
submissions list is empty. This seeder fills it: site inductions, concrete pour
acceptances and room-by-room handover checks, per project.

It lives beside :mod:`app.modules.forms.seed` rather than inside it because that
module is imported by :mod:`app.modules.forms.service` for its template data and
promises to stay stdlib-only; a submissions seeder has to call the service, and
putting it there would close an import cycle.

The answers are built from each submission's own frozen template snapshot rather
than from an assumption about what the template contains, and every row is
written through :class:`FormsService` - the same ``create`` and ``complete``
calls the API uses. Completing a submission runs the module's own
:func:`validate_submission_answers`, so a form whose answers did not match its
template would raise here instead of landing in the list looking fine and being
wrong the moment somebody opened it.

What a reader sees on the forms screen afterwards:

* fifteen to twenty-five submissions per project, numbered FRM-001 upwards,
  spread across all three starter templates;
* most of them completed and a handful still draft - part-filled on site, with
  the sign-off section not yet reached - so the list is not one uniform status;
* pass, fail and n/a results, with the failures readable: a pour that was not
  approved is a pour where a pre-pour check failed, and a room that failed its
  handover check carries the snag list that explains it;
* answers that read as a site record - a named trade on the induction, a mix
  and a delivery docket on the pour, a room and a readiness rating on the
  handover check.

Dates are anchored to the run date, never hardcoded, so the register still reads
as this month's work a year from now.

Self-gating twice over: only projects carrying the demo marker are filled, and a
project that already holds any submission is left alone - so a re-run never
doubles the list and a project somebody is really using is never touched.
"""

from __future__ import annotations

import logging
import random
import uuid
from collections.abc import Iterable, Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any, NamedTuple

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.forms.models import FormSubmission, FormTemplate
from app.modules.forms.repository import FormsRepository
from app.modules.forms.schemas import SubmissionCreate
from app.modules.forms.service import FormsService
from app.modules.forms.validation import COMPUTED_TYPES, LAYOUT_TYPES

logger = logging.getLogger(__name__)

_SEED = 8140

# How many submissions each starter-template category gets per project, indexed
# by the project's position in the seeding call. Distinct counts keep two demo
# projects from rendering the same list, and the totals land between eighteen and
# twenty-four submissions per project.
_COUNTS_BY_CATEGORY: dict[str, tuple[int, ...]] = {
    "safety": (7, 9, 6, 8),
    "quality": (6, 5, 8, 7),
    "handover": (5, 7, 6, 8),
}
_DEFAULT_COUNTS: tuple[int, ...] = (5, 4, 6, 5)

# Share of each template's submissions left as drafts - the ones being filled in
# right now, with the sign-off not yet reached.
_DRAFT_SHARE = 0.25

# Fraction of the fillable fields a draft has got through before it was put down.
_DRAFT_PROGRESS = 0.6

# Which completed sheets record a problem, counted rather than rolled for: one
# pour in four is held because a pre-pour check failed, and every other room
# handover finds a snag, which is what snagging is for. A probability would leave
# a small project's whole register reading "pass", and an estate that never shows
# a failure never shows what the result column is for.
_FAIL_EVERY: dict[str, int] = {"quality": 4, "handover": 2}

# Offset into that cycle. Index 0 is always a clean sheet, so a register always
# opens on something that passed.
_FAIL_OFFSET = 1

# Storey ceiling per project archetype, keyed by the leading word of the demo id,
# so a single-storey warehouse never records a pour on level six.
_MAX_LEVEL_BY_ARCHETYPE: dict[str, int] = {
    "warehouse": 2,
    "school": 3,
    "retail": 2,
    "medical": 4,
    "govt": 4,
    "solar": 1,
    "modular": 3,
    "rc": 4,
}
_DEFAULT_MAX_LEVEL = 8

_BLOCKS: tuple[str, ...] = ("Block A", "Block B", "Block C", "Zone 1", "Zone 2", "Core")
_GRIDS: tuple[str, ...] = ("A-D / 1-4", "C-F / 3-6", "E-H / 5-9", "B-E / 2-5", "G-K / 6-10")

# Trades an inducted worker belongs to. A trade is a description, not a name.
_TRADES: tuple[str, ...] = (
    "groundworks",
    "reinforcement",
    "formwork",
    "concrete",
    "steel erection",
    "scaffolding",
    "roofing",
    "cladding",
    "drylining",
    "mechanical",
    "electrical",
    "glazing",
    "joinery",
    "painting",
    "landscaping",
)

# Concrete specifications a pour acceptance can record.
_MIXES: tuple[str, ...] = (
    "C25/30 XC2, 20 mm aggregate",
    "C30/37 XC3, 20 mm aggregate",
    "C32/40 XC4 XD1, 20 mm aggregate",
    "C35/45 XC4, 14 mm aggregate, 30 percent PFA",
    "C40/50 XC4 XF1, 20 mm aggregate",
)

# Pour locations, as an engineer would write them on the sheet.
_POUR_ELEMENTS: tuple[str, ...] = (
    "Level {level} slab, grid {grid}",
    "Core wall lift {lift}, {block}",
    "Pile cap PC{serial}, grid {grid}",
    "Ground bearing slab, bay {lift}, {block}",
    "Retaining wall panel R{serial}, {block}",
    "Columns C{serial} to C{serial2}, level {level}",
    "Stair flight {lift}, {block}",
)

# Pre-pour checks that can hold a pour, and the short reason that goes on the
# sheet beside the element. Kept short because the field it lands in is a
# single-line entry, not a notes box.
_POUR_HOLDS: tuple[tuple[str, str], ...] = (
    ("formwork", "formwork out of line at the west end"),
    ("reinforcement", "cover short to the bottom mat"),
    ("cast_in", "cast-in sockets missing against the setting-out"),
    ("access", "edge protection incomplete at the leading edge"),
)

# Rooms a handover check can walk, per project archetype. ``sanitary`` says
# whether the room has sanitary ware at all - a room that has none is recorded
# as n/a on that line rather than passed, which is what a real sheet shows.
_ROOMS_BY_ARCHETYPE: dict[str, tuple[tuple[str, bool], ...]] = {
    "residential": (
        ("Apartment {unit} - living room", False),
        ("Apartment {unit} - kitchen", True),
        ("Apartment {unit} - bathroom", True),
        ("Apartment {unit} - bedroom 1", False),
        ("Apartment {unit} - hallway", False),
        ("Communal stair, level {level}", False),
    ),
    "condo": (
        ("Suite {unit} - living room", False),
        ("Suite {unit} - kitchen", True),
        ("Suite {unit} - ensuite", True),
        ("Suite {unit} - bedroom 2", False),
        ("Lobby, level {level}", False),
    ),
    "school": (
        ("Classroom {unit}", False),
        ("Science laboratory {level}", True),
        ("Gymnasium", False),
        ("Canteen and servery", True),
        ("Staff room, level {level}", False),
        ("Pupil WC block, level {level}", True),
    ),
    "medical": (
        ("Ward bay {unit}", True),
        ("Consulting room {unit}", True),
        ("Imaging room {level}", False),
        ("Nurse station, level {level}", True),
        ("Clean utility, level {level}", True),
        ("Waiting area, level {level}", False),
    ),
    "warehouse": (
        ("Gatehouse", True),
        ("Welfare block, level {level}", True),
        ("Office suite {unit}", False),
        ("Plant room {level}", False),
        ("Loading dock office", False),
    ),
    "retail": (
        ("Sales floor, zone {level}", False),
        ("Back of house store {unit}", False),
        ("Staff welfare", True),
        ("Chiller room {level}", False),
        ("Customer WC block", True),
    ),
}
_DEFAULT_ROOMS: tuple[tuple[str, bool], ...] = (
    ("Office suite {unit}, level {level}", False),
    ("Meeting room {unit}", False),
    ("WC core, level {level}", True),
    ("Reception, ground floor", False),
    ("Tea point, level {level}", True),
)

# Snags a room can carry, written the way a snagging sheet is written.
_SNAG_NOTES: tuple[str, ...] = (
    "Paint touch-up needed around the door lining.",
    "Skirting short at the internal corner.",
    "Door closer needs adjusting, door binds on the frame.",
    "Sealant to the basin missing on the left return.",
    "Socket plate not flush with the wall finish.",
    "Ceiling tile marked, replace before handover.",
    "Ironmongery loose on the cupboard door.",
    "Floor finish scuffed at the threshold.",
    "Vision panel gasket not seated.",
    "Final clean not done, protection still in place.",
)

# Restrictions an induction can record. Never a claim about a qualification the
# worker holds, only a limit the site is placing on them until something is done.
_INDUCTION_RESTRICTIONS: tuple[str, ...] = (
    "Not to operate plant on site until the ticket has been checked at the office.",
    "No work at height until the site-specific harness brief has been given.",
    "Escorted access only until the buddy period is complete.",
    "Not to enter the basement until the confined-space brief has been given.",
)

# Answers a completed induction records against the card-verified question.
_CARD_ANSWERS: tuple[str, ...] = ("Yes", "Yes", "Yes", "Yes", "Exempt")


class _Parties(NamedTuple):
    """The people and firms these forms name, read from the demo's own rows.

    Nothing here is invented: the workers and signatories are people the demo
    directory already carries and the firms are its own contact companies, so a
    form never names somebody who exists nowhere else in the product.
    """

    people: tuple[str, ...]
    firms: tuple[str, ...]
    staff: tuple[tuple[uuid.UUID, str], ...]


def _rng_for(project_id: uuid.UUID) -> random.Random:
    """A deterministic RNG per project, so a re-seed reproduces the list."""
    return random.Random(f"{_SEED}:{project_id}")


def _max_level(demo_id: str) -> int:
    """Storey ceiling for the archetype behind a demo id."""
    return _MAX_LEVEL_BY_ARCHETYPE.get(_archetype(demo_id), _DEFAULT_MAX_LEVEL)


def _archetype(demo_id: str) -> str:
    """Leading word of a demo id (``residential-berlin`` -> ``residential``)."""
    return str(demo_id or "").split("-", 1)[0].lower()


def _iso(day: date) -> str:
    """A calendar date as the ISO string a JSON answer column can hold."""
    return day.isoformat()


def _fillable(fields: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The fields a person actually answers - no section headers, no formulas."""
    return [f for f in fields if str(f.get("type", "")) not in LAYOUT_TYPES | COMPUTED_TYPES]


def _has_required_photo(fields: Sequence[dict[str, Any]]) -> bool:
    """Whether the template demands a photo we would have to invent to supply.

    Seeded evidence has to be real: rather than pointing a required photo field
    at a file that is not there, the template is skipped for the demo.
    """
    return any(str(f.get("type", "")) == "photo" and bool(f.get("required")) for f in fields)


def _generic_answer(rng: random.Random, field: dict[str, Any], today: date, signer: str) -> Any:
    """A well-formed answer for a field this seeder has no specific value for.

    Every branch produces a value the module's own validator accepts for that
    type, so a starter template that grows a field still completes rather than
    failing halfway through a project.
    """
    ftype = str(field.get("type", ""))
    options = [str(o) for o in (field.get("options") or []) if str(o).strip()]
    if ftype == "checkbox":
        return True
    if ftype == "pass_fail_na":
        return "pass"
    if ftype == "single_choice":
        return options[0] if options else ""
    if ftype == "multi_choice":
        return options[:1]
    if ftype == "number":
        low = field.get("min")
        high = field.get("max")
        value = rng.randint(1, 20)
        if isinstance(low, (int, float)):
            value = max(value, int(low))
        if isinstance(high, (int, float)):
            value = min(value, int(high))
        return value
    if ftype == "rating":
        scale = int(field.get("max_rating") or 5)
        return rng.randint(max(1, scale - 1), scale)
    if ftype == "date":
        return _iso(today - timedelta(days=rng.randint(1, 30)))
    if ftype == "signature":
        # A signature is only "present" when it carries a signer, so an empty
        # name here would read as an unanswered required field.
        return {"name": signer, "date": _iso(today)}
    if ftype == "long_text":
        return "Recorded on site at the time of the check."
    return "Recorded on site"


def _complete_answers(
    rng: random.Random,
    fields: Sequence[dict[str, Any]],
    specific: dict[str, Any],
    today: date,
    signer: str,
) -> dict[str, Any]:
    """Merge the semantic answers with a generic fill for anything still required.

    The specific values are what makes a form read like a site record; the
    generic pass is what keeps it completable when a template carries a field
    this seeder has never heard of. Optional fields with no specific value are
    left blank, exactly as a real sheet leaves them.
    """
    answers = {key: value for key, value in specific.items() if value is not None}
    for field in _fillable(fields):
        key = str(field.get("key", ""))
        if not key or key in answers:
            continue
        if bool(field.get("required")):
            answers[key] = _generic_answer(rng, field, today, signer)
    return answers


def _draft_answers(
    fields: Sequence[dict[str, Any]],
    answers: dict[str, Any],
) -> dict[str, Any]:
    """Cut a full answer set down to what a half-filled sheet would hold.

    The person filling it in got partway down the form and stopped, so the
    answers that survive are a prefix of the fields in order. Every one of them
    is still a valid answer for its field - a draft is incomplete, never wrong.
    """
    keys = [str(f.get("key", "")) for f in _fillable(fields)]
    kept = set(keys[: max(1, int(len(keys) * _DRAFT_PROGRESS))])
    return {key: value for key, value in answers.items() if key in kept}


def _induction_answers(
    rng: random.Random,
    parties: _Parties,
    *,
    when: date,
) -> tuple[dict[str, Any], str, str]:
    """One worker's site induction. Returns ``(answers, title, location)``."""
    worker = rng.choice(parties.people) if parties.people else "Site operative"
    firm = rng.choice(parties.firms) if parties.firms else "Subcontractor"
    inductor = rng.choice(parties.staff)[1] if parties.staff else worker
    answers: dict[str, Any] = {
        "worker_name": worker,
        "company_trade": f"{firm} - {rng.choice(_TRADES)}",
        "induction_date": _iso(when),
        "site_rules": True,
        "emergency": True,
        "ppe": True,
        "permits": True,
        "card_verified": rng.choice(_CARD_ANSWERS),
        "worker_signature": {"name": worker, "date": _iso(when)},
        "inductor_signature": {"name": inductor, "date": _iso(when)},
    }
    if rng.random() < 0.35:
        answers["restrictions"] = rng.choice(_INDUCTION_RESTRICTIONS)
    return answers, f"Site induction - {worker}"[:300], "Site office, main compound"


def _pour_answers(
    rng: random.Random,
    parties: _Parties,
    *,
    when: date,
    max_level: int,
    held: bool,
) -> tuple[dict[str, Any], str, str]:
    """One concrete pour acceptance. Returns ``(answers, title, location)``.

    A held pour is coherent end to end: the check that failed is the reason the
    pour was not approved, and the reason is on the sheet. A pour approved over
    a failed pre-pour check is the kind of row a reader catches immediately, so
    it is never produced.
    """
    block = rng.choice(_BLOCKS)
    element = rng.choice(_POUR_ELEMENTS).format(
        level=rng.randint(1, max_level),
        grid=rng.choice(_GRIDS),
        block=block,
        lift=rng.randint(1, 6),
        serial=f"{rng.randint(1, 48):02d}",
        serial2=f"{rng.randint(49, 96):02d}",
    )
    engineer = rng.choice(parties.staff)[1] if parties.staff else "Site engineer"
    checks = {"formwork": "pass", "reinforcement": "pass", "cast_in": "pass", "access": "pass"}
    approved = "pass"
    if held:
        # The check that failed is the reason the pour was not approved, and the
        # reason is written on the sheet. A pour approved over a failed pre-pour
        # check is the kind of row a reader catches at once, so it is never
        # produced.
        failed_key, reason = rng.choice(_POUR_HOLDS)
        checks[failed_key] = "fail"
        approved = "fail"
        element = f"{element} (held: {reason})"

    answers: dict[str, Any] = {
        "element": element,
        "mix": rng.choice(_MIXES),
        "planned_volume": rng.randint(12, 160),
        "pour_date": _iso(when),
        **checks,
        "docket": f"DK-{rng.randint(40000, 89999)}",
        "slump": rng.choice((90, 100, 110, 120, 130, 140, 150, 160)),
        "temperature": rng.randint(12, 28),
        "approved": approved,
        "engineer_signature": {"name": engineer, "date": _iso(when)},
    }
    return answers, f"Pour acceptance - {element}"[:300], f"{block}, level {rng.randint(1, max_level)}"


def _handover_answers(
    rng: random.Random,
    parties: _Parties,
    *,
    when: date,
    demo_id: str,
    max_level: int,
    snagged: bool,
) -> tuple[dict[str, Any], str, str]:
    """One room's handover check. Returns ``(answers, title, location)``.

    A room that failed anything carries the snag list that says what failed and
    a readiness rating that reflects it; a room that passed everything is not
    given snags it does not have.
    """
    rooms = _ROOMS_BY_ARCHETYPE.get(_archetype(demo_id), _DEFAULT_ROOMS)
    template, has_sanitary = rng.choice(rooms)
    level = rng.randint(1, max_level)
    unit = f"{level}.{rng.randint(1, 9):02d}"
    room = template.format(unit=unit, level=level)
    inspector = rng.choice(parties.staff)[1] if parties.staff else "Site manager"

    checks = {
        "walls_ceilings": "pass",
        "floors": "pass",
        "doors_windows": "pass",
        # A room with no sanitary ware is n/a on that line, not a pass.
        "sanitary": "pass" if has_sanitary else "na",
        "electrical": "pass",
        "cleaning": "pass",
    }
    snags: list[str] = []
    if snagged:
        failable = [key for key, value in checks.items() if value == "pass"]
        for key in rng.sample(failable, k=rng.randint(1, 2)):
            checks[key] = "fail"
        snags = rng.sample(_SNAG_NOTES, k=rng.randint(1, 3))

    answers: dict[str, Any] = {
        "room": room,
        "unit": f"Plot {unit}" if _archetype(demo_id) in ("residential", "condo") else f"Unit {unit}",
        "inspection_date": _iso(when),
        **checks,
        "readiness": rng.randint(2, 3) if snags else rng.randint(4, 5),
        "inspected_by": {"name": inspector, "date": _iso(when)},
    }
    if snags:
        answers["snags"] = "\n".join(snags)
    return answers, f"Handover check - {room}"[:300], f"{rng.choice(_BLOCKS)}, level {level}"


async def _read_parties(session: AsyncSession) -> _Parties:
    """Collect the people, firms and staff these forms name from the demo's rows."""
    people: list[str] = []
    firms: list[str] = []
    try:
        from app.modules.contacts.models import Contact

        rows = (
            await session.execute(
                select(Contact.company_name, Contact.first_name, Contact.last_name)
                .where(Contact.is_active.is_(True))
                .order_by(Contact.company_name),
            )
        ).all()
    except Exception:
        logger.debug("Contact directory unavailable; seeded forms fall back to role labels")
        rows = []
    seen_people: set[str] = set()
    seen_firms: set[str] = set()
    for company_name, first_name, last_name in rows:
        company = str(company_name or "").strip()
        if company and company not in seen_firms:
            seen_firms.add(company)
            firms.append(company)
        person = " ".join(part for part in (str(first_name or "").strip(), str(last_name or "").strip()) if part)
        if person and person not in seen_people:
            seen_people.add(person)
            people.append(person)

    staff: list[tuple[uuid.UUID, str]] = []
    try:
        from app.modules.users.models import User

        user_rows = (
            await session.execute(
                select(User.id, User.full_name).where(User.is_active.is_(True)).order_by(User.email),
            )
        ).all()
    except Exception:
        logger.debug("User table unavailable; seeded forms are signed by a contact instead")
        user_rows = []
    for user_id, full_name in user_rows:
        name = str(full_name or "").strip()
        if name:
            staff.append((user_id, name))

    return _Parties(people=tuple(people), firms=tuple(firms), staff=tuple(staff))


async def _demo_projects(
    session: AsyncSession,
    project_ids: Sequence[uuid.UUID],
) -> list[tuple[uuid.UUID, str]]:
    """Return ``(project_id, demo_id)`` for the demo projects among ``project_ids``.

    A customer's live project must not be handed a register of forms nobody
    filled in, so the marker the demo installer writes onto its own projects is
    what admits a project here. The filter runs in Python because a JSON
    ``contains`` compiles to a string LIKE on this stack rather than to real
    containment.

    The caller's order is preserved rather than the database's, because a
    project's position in this list decides how many of each form it gets, and
    an unordered ``IN`` would hand that to whatever order the rows came back in.
    """
    from app.modules.projects.models import Project

    rows = (await session.execute(select(Project.id, Project.metadata_).where(Project.id.in_(list(project_ids))))).all()
    demo: dict[uuid.UUID, str] = {}
    for project_id, metadata in rows:
        meta = metadata if isinstance(metadata, dict) else {}
        # ``demo_id`` is the marker, not ``is_demo``. The ten template projects
        # stamp both, but the flagship reference project is installed from its
        # own baked fixture and carries only ``demo_id``, so a gate on
        # ``is_demo`` skips the one project users actually land on.
        demo_id = str(meta.get("demo_id") or "").strip()
        if demo_id:
            demo[project_id] = demo_id
    out: list[tuple[uuid.UUID, str]] = []
    seen: set[uuid.UUID] = set()
    for project_id in project_ids:
        if project_id in demo and project_id not in seen:
            seen.add(project_id)
            out.append((project_id, demo[project_id]))
    return out


async def _starter_templates(session: AsyncSession) -> list[FormTemplate]:
    """The built-in starter templates, which every project can fill in.

    Only the seeded, organisation-wide (null project) templates are used: a
    template a user authored is theirs, and inventing submissions against it
    would put words in their form.
    """
    stmt = (
        select(FormTemplate)
        .where(
            FormTemplate.is_seed.is_(True),
            FormTemplate.project_id.is_(None),
            FormTemplate.status == "published",
        )
        .order_by(FormTemplate.category, FormTemplate.name)
    )
    return list((await session.execute(stmt)).scalars().all())


def _build_one(
    rng: random.Random,
    category: str,
    parties: _Parties,
    *,
    when: date,
    demo_id: str,
    max_level: int,
    failing: bool,
) -> tuple[dict[str, Any], str, str]:
    """Semantic answers, title and location for one submission of ``category``."""
    if category == "safety":
        return _induction_answers(rng, parties, when=when)
    if category == "quality":
        return _pour_answers(rng, parties, when=when, max_level=max_level, held=failing)
    if category == "handover":
        return _handover_answers(
            rng,
            parties,
            when=when,
            demo_id=demo_id,
            max_level=max_level,
            snagged=failing,
        )
    return {}, "Site record", "On site"


async def _seed_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    demo_id: str,
    ordinal: int,
    templates: Sequence[FormTemplate],
    parties: _Parties,
) -> dict[str, int]:
    """Seed one project's submissions. Returns per-entity counts (zeros when skipped)."""
    empty = {"projects": 0, "submissions": 0, "completed": 0, "drafts": 0}

    already = (
        (
            await session.execute(
                select(FormSubmission.id).where(FormSubmission.project_id == project_id).limit(1),
            )
        )
        .scalars()
        .first()
    )
    if already is not None:
        return empty

    rng = _rng_for(project_id)
    today = datetime.now(UTC).date()
    max_level = _max_level(demo_id)
    service = FormsService(session)
    repo = FormsRepository(session)
    signer = str(parties.staff[0][0]) if parties.staff else None
    signer_name = parties.staff[0][1] if parties.staff else "Site manager"
    counts = {"projects": 1, "submissions": 0, "completed": 0, "drafts": 0}

    for template in templates:
        fields = list(template.fields_data or [])
        if not fields or _has_required_photo(fields):
            logger.debug("Skipping template %r for project %s (no fillable evidence)", template.name, project_id)
            continue
        category = str(template.category or "custom")
        counts_for = _COUNTS_BY_CATEGORY.get(category, _DEFAULT_COUNTS)
        total = counts_for[ordinal % len(counts_for)]
        draft_from = total - max(1, round(total * _DRAFT_SHARE))
        fail_every = _FAIL_EVERY.get(category, 0)

        for index in range(total):
            is_draft = index >= draft_from
            # Completed sheets run back over the last few months; the drafts are
            # this week's, which is why they are not finished yet.
            when = today - timedelta(days=rng.randint(1, 6) if is_draft else rng.randint(7, 130))
            answers, title, location = _build_one(
                rng,
                category,
                parties,
                when=when,
                demo_id=demo_id,
                max_level=max_level,
                failing=(not is_draft) and bool(fail_every) and index % fail_every == _FAIL_OFFSET,
            )
            full = _complete_answers(rng, fields, answers, today, signer_name)
            submission = await service.create_submission(
                SubmissionCreate(
                    project_id=project_id,
                    template_id=template.id,
                    title=title,
                    location=location,
                    answers=_draft_answers(fields, full) if is_draft else full,
                    metadata={"seed": True, "demo": True},
                ),
                signer,
            )
            counts["submissions"] += 1
            if is_draft:
                counts["drafts"] += 1
                continue
            # Completing runs the module's own answer validation, so a sheet
            # whose answers did not match its template raises here rather than
            # landing in the list looking fine.
            await service.complete_submission(submission.id, None, signer)
            # The service stamps "now" on the completion, which is right for a
            # form finished today and wrong for one finished three months ago.
            # Move it onto the day the sheet itself records.
            await repo.update_submission_fields(
                submission.id,
                completed_at=f"{when.isoformat()}T{rng.randint(11, 18):02d}:{rng.randint(0, 59):02d}:00Z",
            )
            counts["completed"] += 1

    return counts


async def seed_forms_submissions_demo(
    session: AsyncSession,
    project_ids: Iterable[uuid.UUID],
) -> dict[str, int]:
    """Fill in the starter forms on every demo project.

    Afterwards the forms screen on each demo project lists fifteen to
    twenty-five submissions instead of an empty state: site inductions naming a
    worker, a firm and a trade, concrete pour acceptances carrying a mix, a
    volume and a delivery docket, and room-by-room handover checks with a
    readiness rating - most completed with a pass, fail or n/a result, a handful
    still draft because the sign-off has not been reached.

    Args:
        session: Async DB session. The caller commits.
        project_ids: Projects to consider. A project is skipped unless it carries
            the demo marker, and skipped again if it already holds any
            submission, so a re-run never doubles the list and a project somebody
            is really using is never touched.

    Returns:
        Dict with per-entity insert counts across every project seeded.
    """
    totals = {"projects": 0, "submissions": 0, "completed": 0, "drafts": 0}
    ids = list(project_ids)
    if not ids:
        return totals

    targets = await _demo_projects(session, ids)
    if not targets:
        return totals

    templates = await _starter_templates(session)
    if not templates:
        # The starter templates are seeded by the forms module's own startup
        # hook, which runs before this does. Finding none means the library is
        # genuinely empty, and inventing templates here is not this seeder's job.
        logger.info("No starter form templates found; forms submissions demo seed skipped")
        return totals

    parties = await _read_parties(session)

    for ordinal, (project_id, demo_id) in enumerate(targets):
        try:
            # A SAVEPOINT per project, so one project that cannot be seeded costs
            # only its own rows. Catching the exception is not enough on
            # PostgreSQL: a failed statement aborts the whole transaction, and
            # every later project would then fail on a poisoned session rather
            # than on anything wrong with itself.
            async with session.begin_nested():
                counts = await _seed_project(session, project_id, demo_id, ordinal, templates, parties)
        except Exception:
            logger.warning("Forms submissions demo seed skipped for project=%s (non-fatal)", project_id, exc_info=True)
            continue
        for key, value in counts.items():
            totals[key] += value
    return totals
