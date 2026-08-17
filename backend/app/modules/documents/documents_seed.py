# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""Documents demo seed - a project document register backed by real files.

What the file manager calls a folder
------------------------------------
``/files`` builds its left pane from one node per *file kind* - documents,
photos, sheets, BIM models, DWG drawings, takeoffs, reports, markups - and the
documents table tracks no sub-folder path of its own (``kind_and_path_for_document``
in ``folder_permissions_service`` states this outright). Inside the document
kind the folder is therefore the ``category`` column, and that column has a
fixed vocabulary: drawing, contract, specification, photo, correspondence,
reality_capture, other. So "a folder structure a construction project would
actually have" means coverage across those categories, plus the ISO 19650
revision chain the columns already carry - not a nested tree, which the storage
layer cannot express.

Real bytes, real sizes
----------------------
The file manager reports ``Document.file_size`` when it is non-zero and only
falls back to ``os.stat``. A row with an invented size and a path pointing at
nothing therefore shows a plausible size next to a download that 404s. Every
document written here is a file that exists: the committed reference PDFs are
copied into the same store an upload writes to, the narrative documents are
authored as real PDFs, and ``file_size`` is read back off the file on disk.
A document whose bytes cannot be produced is not written at all.

``photo`` and ``reality_capture`` are deliberately left empty. Photos are their
own file kind (and the documents service already cross-links a photo row to a
document row by shared path, so a seeded photo-category document would double up
in the tree); reality capture means scan data, and there is no scan asset to
stand behind such a row.

Idempotent per project on this seeder's own marker. A plain "the project has no
documents" test would never fire, because the demo install already writes a
handful of document rows before this ever runs.
"""

from __future__ import annotations

import logging
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.documents.models import Document

logger = logging.getLogger(__name__)

# Marks the rows this seeder owns, so a re-run recognises its own work rather
# than the documents the demo install writes.
_SEED_SOURCE = "documents_demo_seed"

# Committed reference PDFs, already used by the takeoff and markups seeds.
_ASSET_DIR = Path(__file__).resolve().parents[2] / "scripts" / "flagship_assets"
_PLAN_SET = "house_plans.pdf"
_STANDARDS = "housing_standards.pdf"

_PDF_MIME = "application/pdf"


@dataclass(frozen=True)
class _DocSpec:
    """One document in the seeded register.

    ``asset`` names a committed PDF to copy; when it is None the document's own
    ``body`` is rendered into a PDF instead. A spec with neither is not written.
    """

    key: str
    name: str
    description: str
    category: str
    tags: list[str]
    asset: str | None = None
    body: tuple[str, ...] = ()
    discipline: str | None = None
    drawing_number: str | None = None
    revision_code: str | None = None
    cde_state: str | None = None
    suitability_code: str | None = None
    is_current_revision: bool = True
    # Key of the document this one supersedes, resolved to an id after that
    # document has been written.
    supersedes: str | None = None
    metadata: dict = field(default_factory=dict)


# The register. Ten documents across five folders, with one drawing carried
# through a full revision: the superseded issue is archived and flagged as no
# longer current, and the current issue points back at it.
_REGISTER: tuple[_DocSpec, ...] = (
    _DocSpec(
        key="ga-p01",
        name="General arrangement - Level 00 (P.01.01).pdf",
        description="Preliminary general arrangement issued for coordination. Superseded.",
        category="drawing",
        tags=["general arrangement", "level 00", "superseded"],
        asset=_PLAN_SET,
        discipline="architectural",
        drawing_number="A-10-001",
        revision_code="P.01.01",
        cde_state="archived",
        suitability_code="AR",
        is_current_revision=False,
    ),
    _DocSpec(
        key="ga-c01",
        name="General arrangement - Level 00 (C.01).pdf",
        description="General arrangement approved for construction. Supersedes P.01.01.",
        category="drawing",
        tags=["general arrangement", "level 00", "for construction"],
        asset=_PLAN_SET,
        discipline="architectural",
        drawing_number="A-10-001",
        revision_code="C.01",
        cde_state="published",
        suitability_code="A1",
        supersedes="ga-p01",
    ),
    _DocSpec(
        key="framing",
        name="Structural framing plan.pdf",
        description="Framing layout issued for coordination with the services model.",
        category="drawing",
        tags=["structure", "framing", "coordination"],
        asset=_PLAN_SET,
        discipline="structural",
        drawing_number="S-20-001",
        revision_code="P.02.01",
        cde_state="shared",
        suitability_code="S1",
    ),
    _DocSpec(
        key="spec-concrete",
        name="Specification - Concrete works.pdf",
        description="Materials, tolerances and testing regime for in-situ concrete.",
        category="specification",
        tags=["specification", "concrete", "testing"],
        asset=_STANDARDS,
        discipline="structural",
        revision_code="C.01",
        cde_state="published",
        suitability_code="A3",
    ),
    _DocSpec(
        key="spec-mep",
        name="Specification - Mechanical and electrical installations.pdf",
        description="Performance requirements for the services installation. Work in progress.",
        category="specification",
        tags=["specification", "mep", "draft"],
        asset=_STANDARDS,
        discipline="mechanical",
        revision_code="P.01.01",
        cde_state="wip",
        suitability_code="S0",
    ),
    _DocSpec(
        key="contract-main",
        name="Main contract - scope and conditions.pdf",
        description="Executed main contract: scope, programme obligations and payment terms.",
        category="contract",
        tags=["contract", "main", "executed"],
        body=(
            "Main contract - scope and conditions",
            "",
            "1. Scope of works",
            "The contractor carries out the whole of the permanent works described in "
            "the contract drawings and specification, together with the temporary works "
            "needed to build them.",
            "",
            "2. Programme",
            "The works are carried out in the sections set out in the accepted "
            "programme. Each section has its own completion date, and sectional "
            "completion is certified section by section.",
            "",
            "3. Payment",
            "Payment is applied for monthly against work properly executed and "
            "materials on site. Each application is valued, certified and paid within "
            "the periods stated in the contract particulars.",
            "",
            "4. Variations",
            "A variation is instructed in writing before the work is carried out. "
            "Where no rate in the bill applies, the work is valued using rates for "
            "comparable work, or as daywork where no comparable rate exists.",
            "",
            "5. Retention and defects",
            "Retention is held at the stated percentage and released in two moieties: "
            "on completion of a section and on issue of the certificate confirming "
            "that defects have been made good.",
        ),
        cde_state="published",
        suitability_code="A3",
        revision_code="C.01",
    ),
    _DocSpec(
        key="contract-groundworks",
        name="Subcontract - groundworks package.pdf",
        description="Groundworks package subcontract issued for stage approval.",
        category="contract",
        tags=["contract", "subcontract", "groundworks"],
        body=(
            "Subcontract - groundworks package",
            "",
            "1. Package scope",
            "Site clearance, bulk excavation, reduced-level dig, formation "
            "preparation, drainage below slab and backfill to the underside of the "
            "ground-bearing slab.",
            "",
            "2. Interfaces",
            "The package ends at the underside of the slab. Slab reinforcement and "
            "concrete are in the concrete frame package; ducting beyond the building "
            "line is in the external works package.",
            "",
            "3. Measurement",
            "Excavation is measured net in place, with no allowance for bulking. "
            "Disposal is measured on the same net quantities. Working space is "
            "included in the rates and is not measured separately.",
            "",
            "4. Attendance",
            "The main contractor provides site access, welfare and the setting-out "
            "grid. The subcontractor provides all plant, small tools and its own "
            "temporary works design.",
        ),
        cde_state="shared",
        suitability_code="S4",
        revision_code="P.01.02",
    ),
    _DocSpec(
        key="letter-instruction",
        name="Site instruction 014 - revised door schedule.pdf",
        description="Instruction issued to the contractor covering the revised door schedule.",
        category="correspondence",
        tags=["instruction", "doors", "issued"],
        body=(
            "Site instruction 014 - revised door schedule",
            "",
            "The door schedule has been revised following the fire strategy review. "
            "Doors on the protected corridor are now specified with a thirty-minute "
            "fire rating and cold-smoke seals.",
            "",
            "Please carry out the work described in the revised schedule issued with "
            "this instruction. The change affects ironmongery sets on the corridor "
            "doors only; the leaf sizes and structural openings are unchanged.",
            "",
            "Any cost or time consequence is to be notified within the period set out "
            "in the contract, with a build-up of the quantities affected.",
        ),
    ),
    _DocSpec(
        key="letter-early-warning",
        name="Early warning - late release of the facade design.pdf",
        description="Early warning raised on the facade design release date.",
        category="correspondence",
        tags=["early warning", "facade", "programme"],
        body=(
            "Early warning - late release of the facade design",
            "",
            "The facade design package has not yet been released for construction. "
            "The procurement route for the unitised panels needs a firm design a "
            "minimum of twelve weeks before the first delivery to site.",
            "",
            "On the current programme the first panel delivery is inside that window, "
            "so a further delay to the design release moves the start of the facade "
            "installation and, with it, the date the building becomes weathertight.",
            "",
            "This notice is issued so the matter can be discussed at the next risk "
            "reduction meeting and the options recorded before any cost is committed.",
        ),
    ),
    _DocSpec(
        key="method-facade",
        name="Method statement - facade installation.pdf",
        description="Sequence, plant and controls for installing the facade panels.",
        category="other",
        tags=["method statement", "facade", "safety"],
        body=(
            "Method statement - facade installation",
            "",
            "1. Sequence",
            "Panels are installed floor by floor, working from the lowest level "
            "upwards and from one end of each elevation to the other, so that the "
            "installed run is always closed and never leaves an open pocket.",
            "",
            "2. Plant",
            "Panels are lifted by the tower crane using a purpose-made spreader beam "
            "and vacuum lifters. A mast climbing platform provides the working "
            "position at the face.",
            "",
            "3. Controls",
            "The lifting zone is barriered at ground level for the duration of each "
            "lift. Lifts are stopped when the wind speed at the crane exceeds the "
            "limit given in the lift plan.",
            "",
            "4. Inspection",
            "Each completed bay is inspected for panel alignment, gasket seating and "
            "sealed joints before the access platform moves on, and the result is "
            "recorded against the inspection plan.",
        ),
        discipline="architectural",
    ),
)


def _safe_name(name: str) -> str:
    """A storage-safe filename, mirroring how an upload names its stored file."""
    return "".join(ch if (ch.isalnum() or ch in "-_.") else "-" for ch in name)


def _write_pdf(path: Path, lines: Iterable[str]) -> bool:
    """Author a real PDF whose text is ``lines``. False when unavailable.

    Uses reportlab, a declared base dependency. The text is the document's own
    content, so the file that lands on disk really is the document the register
    names - not a placeholder sized to look plausible.
    """
    try:
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.units import mm
        from reportlab.pdfgen import canvas
    except ImportError:
        logger.info("documents seed: reportlab unavailable - narrative documents skipped")
        return False

    try:
        width, height = A4
        left = 20 * mm
        top = height - 25 * mm
        bottom = 25 * mm
        leading = 6 * mm
        wrap_at = 88

        pdf = canvas.Canvas(str(path), pagesize=A4)
        pdf.setFont("Helvetica", 10)
        cursor = top
        for raw in lines:
            chunks = _wrap(raw, wrap_at) or [""]
            for chunk in chunks:
                if cursor < bottom:
                    pdf.showPage()
                    pdf.setFont("Helvetica", 10)
                    cursor = top
                pdf.drawString(left, cursor, chunk)
                cursor -= leading
        pdf.save()
        return True
    except Exception:  # noqa: BLE001 - a seed must never break a boot
        logger.warning("documents seed: failed to author %s", path, exc_info=True)
        return False


def _wrap(text: str, width: int) -> list[str]:
    """Wrap one paragraph to ``width`` characters, preserving blank lines."""
    if not text.strip():
        return [""]
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) > width and current:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


def _store(project_id: uuid.UUID, spec: _DocSpec) -> tuple[str, int] | None:
    """Materialise a document's bytes in the upload store.

    Returns ``(file_path, size_bytes)`` read back off the file that was written,
    or None when the bytes could not be produced - in which case the caller
    writes no row at all rather than a row whose size contradicts the disk.
    """
    from app.modules.documents.service import UPLOAD_BASE

    upload_dir = Path(UPLOAD_BASE) / str(project_id)
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest = upload_dir / f"{uuid.uuid4().hex[:12]}_{_safe_name(spec.name)}"

    if spec.asset:
        source = _ASSET_DIR / spec.asset
        if not source.exists():
            logger.warning("documents seed: asset missing %s", source)
            return None
        shutil.copyfile(source, dest)
    elif spec.body:
        if not _write_pdf(dest, spec.body):
            return None
    else:
        return None

    if not dest.exists():
        return None
    return str(dest), dest.stat().st_size


def _check_suitability(spec: _DocSpec) -> bool:
    """True when the spec's suitability code is legal for its CDE state.

    Checked against the ISO 19650 table the API itself validates against, so a
    row written straight through the ORM can never carry a combination the
    product would reject on a PATCH.
    """
    if not spec.cde_state or not spec.suitability_code:
        return True
    from app.modules.cde.suitability import validate_suitability_for_state

    ok, reason = validate_suitability_for_state(spec.suitability_code, spec.cde_state)
    if not ok:
        logger.warning("documents seed: %s has an illegal suitability code (%s)", spec.key, reason)
    return ok


async def _already_seeded(session: AsyncSession, project_id: uuid.UUID) -> bool:
    """True when this seeder has already written to the project.

    Read back and matched in Python: the demo install writes its own document
    rows first, so "the project has no documents" would never be true, and a
    JSON predicate against the metadata column compiles to a string LIKE on
    PostgreSQL.
    """
    stmt = select(Document.metadata_).where(Document.project_id == project_id)
    for metadata in (await session.execute(stmt)).scalars().all():
        if (metadata or {}).get("source") == _SEED_SOURCE:
            return True
    return False


async def _seed_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    owner_id: uuid.UUID,
) -> dict[str, int]:
    """Write one project's document register."""
    empty = {"projects": 0, "documents": 0, "bytes": 0}

    if await _already_seeded(session, project_id):
        return empty

    counts = {"projects": 1, "documents": 0, "bytes": 0}
    by_key: dict[str, uuid.UUID] = {}

    for spec in _REGISTER:
        if not _check_suitability(spec):
            continue
        stored = _store(project_id, spec)
        if stored is None:
            continue
        file_path, size_bytes = stored

        parent_id = by_key.get(spec.supersedes) if spec.supersedes else None
        document = Document(
            project_id=project_id,
            name=spec.name,
            description=spec.description,
            category=spec.category,
            file_size=size_bytes,
            mime_type=_PDF_MIME,
            file_path=file_path,
            version=1,
            uploaded_by=str(owner_id),
            tags=list(spec.tags),
            cde_state=spec.cde_state,
            suitability_code=spec.suitability_code,
            revision_code=spec.revision_code,
            drawing_number=spec.drawing_number,
            is_current_revision=spec.is_current_revision,
            parent_document_id=parent_id,
            discipline=spec.discipline,
            metadata_={"source": _SEED_SOURCE, "seed": True, "demo": True, **spec.metadata},
        )
        session.add(document)
        await session.flush()
        by_key[spec.key] = document.id
        counts["documents"] += 1
        counts["bytes"] += size_bytes

    return counts


async def seed_documents_demo(
    session: AsyncSession,
    project_ids: Iterable[uuid.UUID],
) -> dict[str, int]:
    """Fill the document register for the demo projects.

    Only demo projects are touched: ``enrich_all`` hands this seeder every
    project in the database, including a customer's own. A project without
    ``metadata["demo_id"]`` is skipped outright - "this project has no documents"
    is not a gate, because a real project on which nobody has filed anything is
    empty by that test too.

    Args:
        session: Async DB session. The caller commits.
        project_ids: Candidate projects. Skipped when not a demo project or when
            this seeder has already written to it.

    Returns:
        Dict with the number of projects touched, documents written and the
        total bytes actually placed in the upload store.
    """
    totals = {"projects": 0, "documents": 0, "bytes": 0}
    ids = list(project_ids)
    if not ids:
        return totals

    from app.modules.projects.models import Project

    rows = (
        await session.execute(select(Project.id, Project.owner_id, Project.metadata_).where(Project.id.in_(ids)))
    ).all()

    for project_id, owner_id, metadata in rows:
        if not (metadata or {}).get("demo_id"):
            continue
        if owner_id is None:
            continue
        try:
            # A SAVEPOINT per project: on PostgreSQL a failed statement aborts
            # the whole transaction, so one project that cannot be seeded would
            # otherwise take every later project down with it.
            async with session.begin_nested():
                counts = await _seed_project(session, project_id, owner_id)
        except Exception:
            logger.warning("Documents demo seed skipped for project=%s (non-fatal)", project_id, exc_info=True)
            continue
        for key, value in counts.items():
            totals[key] += value
    return totals
