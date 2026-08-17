"""Read a DXF into the Excel shape the DDC converters produce.

Why this exists: an upload of ``.dxf`` was resolved through a format alias to
the DWG converter, a proprietary binary published for x86-64 only. The drawing
data never needed that binary, only the DWG container does, and the platform
already reads DXF in pure Python for the takeoff module. On a host with no
converter for its CPU architecture that alias was the entire reason a DXF could
not be opened at all.

The output is deliberately the same table a converter would have produced, one
row per entity, so every downstream consumer works unchanged:
``parse_cad_excel`` lowercases the header row, ``group_cad_elements`` reads
exactly ``category``, ``type name``, ``count``, ``length`` and ``area``, and the
column picker classifies whatever else is there.

Lengths are metres and areas are square metres, because ``group_cad_elements``
sums them into ``length_m`` and ``area_m2`` without ever asking what unit they
arrived in. A drawing whose unit cannot be established leaves both cells empty
rather than passing raw drawing units off as metres: a blank tells the estimator
to set the scale, a number that is 1000x wrong does not.
"""

from __future__ import annotations

import logging
import math
from decimal import Decimal
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

#: Extensions the platform reads with no converter binary at all. Callers that
#: gate an upload on converter availability must consult this first, otherwise
#: they reject a file the very next call would have read successfully.
NATIVE_CAD_FORMATS = frozenset({"dxf"})

# The header row, in the shape the consumers actually read. ``parse_cad_excel``
# lowercases these, then ``group_cad_elements`` looks for the bare words
# ``length`` and ``area`` (``area (m2)`` is also accepted, ``length (m)`` is
# NOT), and treats ``count`` as a per-row multiplier. Renaming a column here
# silently zeroes the quantity it carries, so keep them literal.
_HEADERS: tuple[str, ...] = (
    "Category",
    "Type Name",
    "Count",
    "Length",
    "Area",
    "Source Units",
)

#: Entity types that enclose a face worth reporting as an area. A closed
#: polyline is a room, a slab or a hatch boundary; a circle is a column or a
#: pipe. An open polyline encloses nothing and gets length only.
_AREA_TYPES = frozenset({"LWPOLYLINE", "POLYLINE", "CIRCLE"})

#: ezdxf names the modelspace layout ``Model`` on every document it opens,
#: whatever the file called it. Everything else in ``doc.layouts`` is a sheet.
_MODELSPACE = "Model"


def is_natively_readable(extension: str) -> bool:
    """True when this extension is read in-process, with no converter binary.

    Args:
        extension: File extension, with or without a leading dot, any case.
    """
    return extension.lstrip(".").lower() in NATIVE_CAD_FORMATS


def _polygon_area(points: list[dict[str, float]]) -> float:
    """Shoelace area of a ring, in drawing units squared.

    Returns zero for a degenerate ring rather than raising, so one malformed
    polyline cannot abort a whole drawing.
    """
    if len(points) < 3:
        return 0.0
    total = 0.0
    for index, current in enumerate(points):
        nxt = points[(index + 1) % len(points)]
        total += float(current.get("x", 0.0)) * float(nxt.get("y", 0.0)) - float(nxt.get("x", 0.0)) * float(
            current.get("y", 0.0)
        )
    return abs(total) / 2.0


def _entity_area(entity: dict[str, Any]) -> float:
    """Enclosed area of one serialized entity, in drawing units squared."""
    entity_type = entity.get("entity_type", "")
    if entity_type not in _AREA_TYPES:
        return 0.0
    geometry = entity.get("geometry_data", {}) or {}

    if entity_type == "CIRCLE":
        radius = float(geometry.get("radius", 0.0) or 0.0)
        return math.pi * radius * radius

    if not geometry.get("closed", False):
        return 0.0
    return _polygon_area(list(geometry.get("points", []) or []))


def _scale_factors(units: str | None) -> tuple[Decimal, Decimal] | None:
    """Exact (length, area) factors from drawing units to metres and m2.

    Returns ``None`` when the drawing carries no usable unit, which is the
    signal to leave the measurement cells empty. The area factor is the square
    of the length factor rather than a second table lookup, so a unit with no
    squared spelling (miles) still converts.
    """
    if not units or units == "unitless":
        return None
    try:
        from app.modules.dwg_takeoff.intl import convert_to_canonical

        length_factor = convert_to_canonical(1, units).factor
    except (ImportError, ValueError):
        logger.info("DXF carries unit %r, which does not resolve to a metric factor.", units)
        return None
    return length_factor, length_factor * length_factor


def _quantity(raw: float, factor: Decimal | None) -> float | None:
    """Scale one raw measurement, or ``None`` when the scale is unknown."""
    if factor is None or raw <= 0:
        return None
    return float(Decimal(str(raw)) * factor)


def measurable_entities(parsed: dict[str, Any]) -> list[dict[str, Any]]:
    """The entities that stand for real, once-built work.

    :func:`parse_dxf` serves a viewer, so it returns everything drawable: every
    layout, plus the contents of every block definition an INSERT references.
    Both are wrong to measure.

    A sheet layout shows the model again inside a titleblock. Measured with the
    model it reports a 50 m2 slab as 100 m2, and nothing about the table says so.

    A block definition is a template, not a placement. Its geometry is emitted
    once and carries ``block`` instead of ``layout``; the INSERTs that place it
    are separate entities and are already counted. Measuring the definition adds
    a door that was never built, whether the drawing places that block once or
    five hundred times.

    So: modelspace only, definitions dropped. The one concession is a drawing
    that put its geometry entirely on a single sheet and left the model empty,
    which some 2D exports do. With exactly one candidate there is nothing to
    double, so it is measured and said out loud. With several, none is, because
    guessing which sheet is the drawing is how the 100 m2 slab comes back.
    """
    placed = [entity for entity in parsed.get("entities", []) or [] if not entity.get("block")]
    model = [entity for entity in placed if entity.get("layout") == _MODELSPACE]
    if model:
        return model

    by_sheet: dict[str, list[dict[str, Any]]] = {}
    for entity in placed:
        by_sheet.setdefault(str(entity.get("layout") or ""), []).append(entity)
    if len(by_sheet) == 1:
        sheet, entities = next(iter(by_sheet.items()))
        logger.info("DXF modelspace is empty; measuring its only sheet layout %r instead.", sheet)
        return entities

    if by_sheet:
        logger.warning(
            "DXF modelspace is empty and its geometry is spread over %d sheet layouts (%s), "
            "so nothing was measured rather than measuring one of them twice.",
            len(by_sheet),
            ", ".join(sorted(by_sheet)),
        )
    return []


def build_rows(parsed: dict[str, Any]) -> list[tuple[Any, ...]]:
    """Turn a :func:`parse_dxf` result into converter-shaped spreadsheet rows.

    One row per entity, matching how a converter reports one physical element
    per row. The layer becomes the category because on a 2D drawing the layer
    is the semantic grouping an estimator already works in, and the DXF entity
    type becomes the type name.
    """
    units = parsed.get("units")
    factors = _scale_factors(units if isinstance(units, str) else None)
    length_factor = factors[0] if factors else None
    area_factor = factors[1] if factors else None
    # What the measurement columns are actually expressed in, recorded on every
    # row so a reader can audit the conversion instead of trusting it.
    units_label = str(units) if units else "unitless"

    rows: list[tuple[Any, ...]] = []
    for entity in measurable_entities(parsed):
        try:
            from app.modules.dwg_takeoff.dxf_processor import calculate_entity_measurement

            raw_length = float(calculate_entity_measurement(entity) or 0.0)
        except Exception:  # noqa: BLE001 - one bad entity must not lose the drawing
            raw_length = 0.0
        raw_area = _entity_area(entity)

        rows.append(
            (
                str(entity.get("layer", "") or "Other"),
                str(entity.get("entity_type", "") or "Unknown"),
                1,
                _quantity(raw_length, length_factor),
                _quantity(raw_area, area_factor),
                units_label,
            )
        )
    return rows


def convert_dxf_to_excel(input_path: Path, output_dir: Path) -> Path | None:
    """Read a DXF and write the Excel a DDC converter would have written.

    Args:
        input_path: The uploaded ``.dxf`` on disk.
        output_dir: Directory to write the workbook into.

    Returns:
        Path to the written workbook, or ``None`` on any failure, which is the
        same contract ``convert_cad_to_excel`` already gives its callers.
    """
    try:
        import openpyxl

        from app.modules.dwg_takeoff.dxf_processor import parse_dxf

        parsed = parse_dxf(str(input_path))
    except ImportError:
        logger.exception("Reading DXF natively needs ezdxf and openpyxl, both base dependencies.")
        return None
    except Exception:
        logger.exception("Could not parse %s as DXF.", input_path.name)
        return None

    rows = build_rows(parsed)
    if not rows:
        logger.warning("%s parsed cleanly but holds no entities to measure.", input_path.name)

    output_path = output_dir / (input_path.stem + ".xlsx")
    try:
        workbook = openpyxl.Workbook()
        # A fresh Workbook always has an active sheet; the fallback exists
        # because the attribute is typed optional, not because it can be None.
        sheet = workbook.active or workbook.create_sheet()
        sheet.title = "Elements"
        sheet.append(list(_HEADERS))
        for row in rows:
            sheet.append(list(row))
        workbook.save(output_path)
        workbook.close()
    except Exception:
        logger.exception("Could not write the DXF element table to %s.", output_path)
        return None

    # Both counts belong on this line. A drawing that measured 40 of its 900
    # entities produces a confident-looking table either way; the difference
    # between a deliberate drop and a parse failure is only visible here.
    logger.info(
        "Read %s natively: %d of %d entities measured, %d unreadable, units %r, no converter binary involved.",
        input_path.name,
        len(rows),
        int(parsed.get("entity_count") or 0),
        int(parsed.get("skipped_count") or 0),
        parsed.get("units"),
    )
    return output_path
