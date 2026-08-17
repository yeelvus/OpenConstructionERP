# DDC-CWICR-OE: DataDrivenConstruction - OpenConstructionERP
"""Point-cloud demo seed - a scan register with clouds that really open.

Opens the Point Cloud page on a register of capture campaigns a site would
actually have run: a few terrestrial scans of the tight interior spaces, some
handheld SLAM walks of the floor plates, drone photogrammetry over the open
ground, and one upload that failed. Most carry a registration against the
design model with its residual error, coverage and occlusion recorded next to
it, which is what lets a reader see at a glance which scans may be trusted for
dimensional work.

Every scan that says it is ready has a real container behind it. The seeder
synthesises a small LAS/LAZ cloud (a ground surface plus a wall face, carrying
intensity and LAS classification, plus colour where the capture method would
produce colour), writes it under the module's own tenant-namespaced upload key,
and then reads the stored file back through the service's own header sniff.
So ``point_count``, ``bbox_json`` and ``scan_metadata`` are measured off the
bytes rather than declared here, and the page lands in a working 3D viewer
instead of an error card - which is what it would show for a row whose blob
does not exist.

The one scan per project in ``failed`` never got its bytes, and carries no
count, no extents and no registration - the honest shape of an upload that
did not finish.

Internal consistency, which the tests pin:

* point density agrees with the capture method - a terrestrial scan of a plant
  room is dense, a drone pass over the site is sparse, and each stays inside
  the band its method really produces;
* a registration's residual error is inside its scan's USIBD accuracy-tier
  tolerance exactly when the scan says ``registered``, and outside it exactly
  when the scan says ``failed`` - checked through the module's own
  ``rms_within_tier`` rather than by restating the inequality;
* the occlusion area follows from the coverage percentage and the surface the
  scan was aimed at, so the two figures cannot tell different stories.

Unlike a register of rows, every scan here also writes a container to storage,
so this seeder has a disk cost that most do not - roughly 1.1 MB per project.
What bounds that is the demo-project gate rather than a number: the caller
hands over every project in the database, and only the ones carrying a
``demo_id`` are touched. A literal cap was tried and removed. It sat at the
same size as the demo set, so the day a project was added to that set the cap
would have silently dropped one, and a single project photographing as an
empty register is the defect this seeder exists to remove.

Dates come from the run, never hardcoded. Idempotent per project: a project
that already carries a scan is left untouched.
"""

from __future__ import annotations

import asyncio
import io
import logging
import math
import random
import uuid
from decimal import Decimal
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.pointcloud.models import ScanDataset, ScanRegistration
from app.modules.pointcloud.validators import LOA_TOLERANCE_MM

logger = logging.getLogger(__name__)

_SEED = 42

# Namespace for the deterministic scan ids. The upload key is derived from the
# scan id, so a random id would mean a re-run writes its containers under fresh
# keys: an enrichment run that fails to commit after the bytes have landed
# would leave the old ones behind with nothing pointing at them and no way to
# reclaim them. Deriving the id from the project makes a re-run overwrite the
# same keys instead.
_SCAN_NS = uuid.UUID("2b7c4e90-8a15-4c63-9f0e-51d8a6b2c740")

# How many scans a project's register carries, indexed by the project's
# position in the seeding call so two demo projects are never the same size.
_REGISTER_SIZES = (9, 8, 11, 10)
_SIZE_SPAN = max(_REGISTER_SIZES) - min(_REGISTER_SIZES) + 1

# One capture campaign per entry:
#   (source_type, accuracy_tier, container format, (width_m, depth_m),
#    height_m, points per square metre of footprint)
#
# The densities are what each method really delivers into a project deliverable
# once decimated for distribution: terrestrial scanning gives hundreds to
# thousands of points per square metre, a SLAM walk a few hundred, a drone pass
# over open ground tens. The counts stay small enough that a whole demo estate
# of containers is a few megabytes.
_CAMPAIGNS: tuple[tuple[str, str, str, tuple[float, float], float, int], ...] = (
    ("laser_scan", "survey", "laz", (4.0, 5.0), 3.2, 700),
    ("photogrammetry", "standard", "laz", (48.0, 32.0), 6.5, 12),
    ("lidar", "standard", "laz", (14.0, 9.5), 3.0, 130),
    # Uncompressed LAS costs about six times what the same cloud costs as LAZ,
    # so the one campaign that shows the format is a single small setup.
    ("laser_scan", "survey", "las", (3.0, 2.5), 3.1, 700),
    ("photogrammetry", "standard", "laz", (60.0, 40.0), 9.0, 8),
    ("lidar", "coarse", "laz", (9.0, 7.0), 2.9, 180),
    ("laser_scan", "survey", "laz", (7.5, 6.0), 3.4, 420),
    ("lidar", "standard", "laz", (18.0, 11.0), 3.2, 95),
    ("photogrammetry", "standard", "laz", (36.0, 26.0), 5.5, 18),
    ("laser_scan", "survey", "laz", (5.0, 4.0), 3.1, 620),
    ("lidar", "standard", "laz", (12.0, 8.0), 3.0, 150),
)

# Point density each capture method plausibly delivers, in points per square
# metre of footprint. Wide enough to cover a decimated deliverable and a raw
# export, narrow enough that a drone pass can never be mistaken for a
# terrestrial setup. This is the band the seeded campaigns are checked against.
_DENSITY_BANDS: dict[str, tuple[int, int]] = {
    "laser_scan": (300, 40_000),
    "lidar": (60, 8_000),
    "photogrammetry": (5, 1_500),
    "other": (1, 100_000),
}

# LAS standard classification codes used by the synthesised clouds.
_CLASS_GROUND = 2
_CLASS_BUILDING = 6

# Share of a synthesised cloud that lands on the ground surface; the rest is
# the wall face, which is what gives the cloud a real Z extent.
_GROUND_SHARE = 0.62

# Colour is a property of the capture method, not a decoration: photogrammetry
# reconstructs from photographs and always carries RGB, a terrestrial or SLAM
# scanner records intensity and may carry none.
_RGB_METHODS = frozenset({"photogrammetry"})

# LAS point formats: 6 carries intensity + classification, 7 adds RGB. Both are
# LAS 1.4 formats, which is what a current scanner or SfM package exports.
_POINT_FORMAT_PLAIN = 6
_POINT_FORMAT_RGB = 7

# Residual alignment error as a fraction of the tier's tolerance bound. A
# registration that passed sits comfortably inside its bound; the one that
# failed sits just outside it, which is what a real marginal registration looks
# like - not an error figure no scanner could produce.
_RMS_PASS_RANGE = (0.28, 0.86)
_RMS_FAIL_RANGE = (1.08, 1.45)

# How much of the target surface a scan sees, and how much of the cloud lands
# outside the deviation tolerance band.
_COVERAGE_RANGE = (Decimal("78.5"), Decimal("96.8"))
_OUT_OF_TOLERANCE_SHARE = (0.002, 0.038)
_CONFIDENCE_RANGE = (Decimal("0.812"), Decimal("0.991"))


def _is_demo_project(metadata: Any) -> bool:
    """Whether a project row's metadata marks it as a demo project.

    Both installers that create demo projects stamp ``demo_id``: the showcase
    templates in ``app/core/demo_projects.py`` and the flagship in
    ``app/scripts/seed_flagship.py``. Nothing else writes that key, so its
    presence is what separates a project we may fill with invented surveys from
    a project somebody is actually building. Read ``demo_id`` and not
    ``is_demo``: the flagship carries the former and not the latter.
    """
    return isinstance(metadata, dict) and bool(str(metadata.get("demo_id") or "").strip())


def _rng_for(project_id: uuid.UUID) -> random.Random:
    """A deterministic RNG per project, so a re-seed reproduces the register."""
    return random.Random(f"{_SEED}:{project_id}")


def _decimal_between(rng: random.Random, low: Decimal, high: Decimal, places: str) -> Decimal:
    """Draw a Decimal in ``[low, high]`` quantised to ``places``."""
    span = float(high - low)
    return (low + Decimal(str(rng.random() * span))).quantize(Decimal(places))


def _build_cloud(
    *,
    footprint: tuple[float, float],
    height: float,
    point_count: int,
    with_rgb: bool,
    compress: bool,
    seed: int,
) -> bytes:
    """Synthesise a small LAS/LAZ container: a ground surface and a wall face.

    Runs off the event loop (the caller uses a thread). Returns the encoded
    container bytes, ready to be written under the scan's upload key. The cloud
    is deliberately modest - a demo estate of these is a few megabytes - but it
    is a real container with a real header, so everything the platform reads
    back from it is measured rather than declared.
    """
    import laspy
    import numpy as np

    rng = np.random.default_rng(seed)
    width, depth = footprint
    ground_count = max(1, int(point_count * _GROUND_SHARE))
    wall_count = max(1, point_count - ground_count)

    # Ground surface: a plane with survey-scale roughness on it.
    gx = rng.uniform(0.0, width, ground_count)
    gy = rng.uniform(0.0, depth, ground_count)
    gz = rng.normal(0.0, 0.012, ground_count)
    # Wall face standing on the y = 0 edge, which gives the cloud its height.
    wx = rng.uniform(0.0, width, wall_count)
    wy = rng.normal(0.0, 0.008, wall_count)
    wz = rng.uniform(0.0, height, wall_count)

    xs = np.concatenate([gx, wx])
    ys = np.concatenate([gy, wy])
    zs = np.concatenate([gz, wz])
    total = xs.shape[0]

    point_format = _POINT_FORMAT_RGB if with_rgb else _POINT_FORMAT_PLAIN
    header = laspy.LasHeader(point_format=point_format, version="1.4")
    header.scales = np.array([0.001, 0.001, 0.001])
    header.offsets = np.array([0.0, 0.0, 0.0])
    las = laspy.LasData(header)
    las.x = xs
    las.y = ys
    las.z = zs
    # Return intensity falls off with range and differs by surface, so it is
    # derived from where the point is rather than drawn at random. That is what
    # a scanner records, and it is also why a real cloud compresses: neighbours
    # carry similar values, and uncorrelated noise would inflate every
    # container here several times over.
    reach = np.sqrt((xs - width / 2.0) ** 2 + (ys - depth / 2.0) ** 2) + 1.0
    intensity = np.concatenate(
        [np.full(ground_count, 2600.0), np.full(wall_count, 3400.0)],
    ) / np.sqrt(reach / 4.0)
    las.intensity = np.clip(intensity + rng.integers(-90, 90, total), 60, 6000).astype(np.uint16)
    las.classification = np.concatenate(
        [
            np.full(ground_count, _CLASS_GROUND, dtype=np.uint8),
            np.full(wall_count, _CLASS_BUILDING, dtype=np.uint8),
        ],
    )
    if with_rgb:
        # Concrete grey, shaded by height the way photo-textured colour is,
        # with a little sensor noise on top.
        span = max(float(zs.max() - zs.min()), 1e-6)
        shade = 27000.0 + 7000.0 * (zs - zs.min()) / span
        base = np.clip(shade + rng.integers(-450, 450, total), 0, 65535)
        las.red = base.astype(np.uint16)
        las.green = np.clip(base - 420 + rng.integers(-200, 200, total), 0, 65535).astype(np.uint16)
        las.blue = np.clip(base - 980 + rng.integers(-200, 200, total), 0, 65535).astype(np.uint16)

    buffer = io.BytesIO()
    if compress:
        las.write(buffer, do_compress=True, laz_backend=laspy.LazBackend.Lazrs)
    else:
        las.write(buffer)
    return buffer.getvalue()


def _transform_matrix(rng: random.Random) -> list[float]:
    """A real 4x4 rigid-body transform, row-major, as the column stores it.

    A small yaw plus a translation - the shape an alignment onto a design datum
    actually produces. Kept a proper rotation (orthonormal, determinant one) so
    a consumer that multiplies by it gets a rigid motion rather than a shear.
    """
    angle = rng.uniform(-0.06, 0.06)
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    tx, ty, tz = (round(rng.uniform(-2.5, 2.5), 4) for _ in range(3))
    return [
        round(cos_a, 8),
        round(-sin_a, 8),
        0.0,
        tx,
        round(sin_a, 8),
        round(cos_a, 8),
        0.0,
        ty,
        0.0,
        0.0,
        1.0,
        tz,
        0.0,
        0.0,
        0.0,
        1.0,
    ]


def _upload_key(tenant_id: uuid.UUID, project_id: uuid.UUID, scan_id: uuid.UUID, fmt: str) -> str:
    """The scan's storage key, built the way the service builds it.

    Delegates to :meth:`PointCloudService._upload_key` so a seeded scan is
    stored exactly where an uploaded one would be; a key shaped by hand here
    would drift the day that convention changes.
    """
    from app.modules.pointcloud.service import PointCloudService

    return PointCloudService._upload_key(tenant_id, project_id, scan_id, fmt)  # noqa: SLF001 - same module


async def _design_target(session: AsyncSession, project_id: uuid.UUID) -> str | None:
    """Return the id of a design model this project's scans were aligned to.

    A registration's target is what the scan was compared against. Where the
    project carries a BIM model that is the honest answer; where it does not,
    the caller falls back to aligning a scan onto the previous scan, which is
    what a surveyor does on a site with no federated model.
    """
    try:
        from app.modules.bim_hub.models import BIMModel

        stmt = select(BIMModel.id).where(BIMModel.project_id == project_id).order_by(BIMModel.name).limit(1)
        model_id = (await session.execute(stmt)).scalars().first()
    except Exception:
        logger.debug("BIM model lookup unavailable for project=%s", project_id)
        return None
    return str(model_id) if model_id is not None else None


async def _seed_project(
    session: AsyncSession,
    project_id: uuid.UUID,
    owner_id: uuid.UUID,
    ordinal: int,
) -> dict[str, int]:
    """Seed one project's scan register. Returns per-entity counts."""
    empty = {"projects": 0, "scans": 0, "registrations": 0, "bytes_written": 0}

    already = (
        (await session.execute(select(ScanDataset.id).where(ScanDataset.project_id == project_id).limit(1)))
        .scalars()
        .first()
    )
    if already is not None:
        return empty

    from app.modules.pointcloud.service import PointCloudService

    service = PointCloudService(session)
    storage = service.storage
    rng = _rng_for(project_id)
    slot = ordinal % len(_REGISTER_SIZES)
    size = _REGISTER_SIZES[slot] + (ordinal // len(_REGISTER_SIZES)) * _SIZE_SPAN
    # The tenant boundary is the project owner - the same resolution the
    # service does at register time, so a seeded scan is scoped like an
    # uploaded one and the tenant-scoped list query finds it.
    tenant_id = owner_id
    design_target = await _design_target(session, project_id)

    counts = {"projects": 1, "scans": 0, "registrations": 0, "bytes_written": 0}
    previous_scan_id: uuid.UUID | None = None

    for index in range(size):
        source_type, tier, fmt, footprint, height, density = _CAMPAIGNS[(index + ordinal) % len(_CAMPAIGNS)]
        scan_id = uuid.uuid5(_SCAN_NS, f"{project_id}:{index}")
        # The id has to exist before the row does: the upload key is built from
        # it, and the key is what the bytes are written under.
        key = _upload_key(tenant_id, project_id, scan_id, fmt)

        # One upload per project never finished. It carries no bytes, so it
        # carries no count, no extents and no registration either.
        failed = index == size - 2
        if failed:
            session.add(
                ScanDataset(
                    id=scan_id,
                    project_id=project_id,
                    tenant_id=tenant_id,
                    source_type=source_type,
                    original_format=fmt,
                    accuracy_tier=tier,
                    registration_status="unregistered",
                    upload_key=key,
                    status="failed",
                    retention_policy="keep_raw",
                    created_by=owner_id,
                ),
            )
            await session.flush()
            counts["scans"] += 1
            continue

        area = footprint[0] * footprint[1]
        point_count = max(2000, int(area * density))
        content = await asyncio.to_thread(
            _build_cloud,
            footprint=footprint,
            height=height,
            point_count=point_count,
            with_rgb=source_type in _RGB_METHODS,
            compress=fmt in ("laz", "copc"),
            seed=rng.randrange(1 << 30),
        )
        await storage.put(key, content)
        counts["bytes_written"] += len(content)

        # The newest scan has landed but has not been aligned yet; one older
        # scan was aligned and missed its tier. Everything else registered.
        if index == size - 1:
            registration_status = "unregistered"
        elif index == 1:
            registration_status = "failed"
        else:
            registration_status = "registered"

        scan = ScanDataset(
            id=scan_id,
            project_id=project_id,
            tenant_id=tenant_id,
            source_type=source_type,
            original_format=fmt,
            accuracy_tier=tier,
            registration_status=registration_status,
            upload_key=key,
            status="ready",
            retention_policy="keep_raw",
            created_by=owner_id,
        )
        session.add(scan)
        await session.flush()
        counts["scans"] += 1

        # Read the stored container back through the service's own header
        # sniff, so the count, the extents and the scalar-field summary are
        # measured off the bytes instead of being asserted here.
        fields = await service._sniff_header_fields(key, fmt, had_crs=False)  # noqa: SLF001 - same module
        if fields:
            await service.scans.update_fields(scan_id, **fields)

        if registration_status != "unregistered":
            bound = LOA_TOLERANCE_MM[tier]
            low, high = _RMS_PASS_RANGE if registration_status == "registered" else _RMS_FAIL_RANGE
            rms = (bound * Decimal(str(round(rng.uniform(low, high), 4)))).quantize(Decimal("0.0001"))
            coverage = _decimal_between(rng, *_COVERAGE_RANGE, places="0.001")
            # Surface the scan was aimed at: the ground it covered plus the
            # wall face it stood in front of. The occlusion area is the part of
            # that surface it never saw, so the two figures agree by
            # construction rather than by coincidence.
            target_area = Decimal(str(round(area + footprint[0] * height, 6)))
            hole_area = (target_area * (Decimal("100") - coverage) / Decimal("100")).quantize(Decimal("0.000001"))
            session.add(
                ScanRegistration(
                    scan_id=scan_id,
                    target_ref=design_target or (str(previous_scan_id) if previous_scan_id else str(project_id)),
                    transform_matrix=_transform_matrix(rng),
                    rms_error=rms,
                    # No deviation pass has run, so there is no colour map to
                    # point at. A URI here would name a blob that is not there.
                    deviation_map_uri=None,
                    out_of_tolerance_count=int(point_count * rng.uniform(*_OUT_OF_TOLERANCE_SHARE)),
                    coverage_pct=coverage,
                    hole_area=hole_area,
                    confidence=_decimal_between(rng, *_CONFIDENCE_RANGE, places="0.001"),
                ),
            )
            counts["registrations"] += 1
        previous_scan_id = scan_id

    await session.flush()
    return counts


async def seed_pointcloud_demo(
    session: AsyncSession,
    project_ids: Iterable[uuid.UUID],
) -> dict[str, int]:
    """Populate the reality-capture scan register for the given demo projects.

    Args:
        session: Async DB session. The caller commits. Storage writes are not
            transactional: a rolled back session leaves the written containers
            behind, which is harmless (they are only reachable through a scan
            row that no longer exists) but worth knowing.
        project_ids: Candidate projects. Anything that is not a demo project
            is skipped outright; a demo project is skipped when it already
            carries a scan. Every demo project given is seeded - there is no
            cap - and the tail is sorted so two identical installations draw
            the same campaigns for the same project.

    Returns:
        Dict with per-entity insert counts plus the total container bytes
        written, across every project seeded. Empty counts when no LAS reader
        is installed, because a scan whose container cannot be written is a row
        the viewer could only fail on.
    """
    totals = {"projects": 0, "scans": 0, "registrations": 0, "bytes_written": 0}
    ids = list(project_ids)
    if not ids:
        return totals
    # The caller puts the flagship first and the rest arrive in whatever order
    # the database returned them, which PostgreSQL does not promise to repeat.
    # Nothing is dropped on account of this order, but it decides which
    # campaigns and register size each project draws, so sorting the tail is
    # what makes two identical installations produce the same estate.
    ids = ids[:1] + sorted(ids[1:], key=str)

    try:
        import laspy  # noqa: F401 - probing availability, not using it here
    except ImportError:
        # Without the reader there is no way to write a container the platform
        # could later read. Seeding rows anyway would fill the register with
        # scans that open on an error, which is worse than an empty page.
        logger.info("Point cloud demo seed skipped: no LAS reader installed")
        return totals

    from app.modules.projects.models import Project

    # The caller hands us every project in the database, not only demo ones,
    # and the backfill around it re-runs once per app version - so it fires
    # again on every upgrade. That makes "carries no scan yet" the wrong gate
    # on its own: a real customer project that has commissioned no reality
    # capture is also empty of scans, and would receive a register of invented
    # surveys, with megabytes of synthetic point cloud written into their
    # storage, on their next upgrade. Demo projects are marked, so read the
    # marker. Emptiness stays on top of this as the idempotency guard.
    rows = (
        await session.execute(select(Project.id, Project.owner_id, Project.metadata_).where(Project.id.in_(ids)))
    ).all()
    owners: dict[uuid.UUID, Any] = {pid: owner for pid, owner, meta in rows if _is_demo_project(meta)}
    # Filtering before the enumerate keeps the ordinal dense, so the register
    # size a project draws never depends on how many projects that are not
    # being seeded happen to sort ahead of it.
    ids = [pid for pid in ids if pid in owners]
    if not ids:
        return totals
    # Every demo project gets its scans. There is no cap: a literal one would
    # sit beside a demo set of its own size and silently drop whichever project
    # was added last, and an empty register on one project out of ten is
    # exactly the defect this seeder exists to remove. The gate above is the
    # bound, so the disk cost tracks the demo set rather than the installation.
    logger.info("Point cloud demo seed: %d demo project(s) to fill", len(ids))

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
            logger.warning("Point cloud demo seed skipped for project=%s (non-fatal)", project_id, exc_info=True)
            continue
        for key, value in counts.items():
            totals[key] += value
    return totals
