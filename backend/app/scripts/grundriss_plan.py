# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
"""Single source of truth for the demo German floor plan (Grundriss Erdgeschoss).

This module owns the GEOMETRY of the vector reference plan that ships as
``flagship_assets/grundriss_erdgeschoss.pdf`` (index A) and
``flagship_assets/grundriss_erdgeschoss_index_b.pdf`` (index B):

* :mod:`app.scripts.generate_grundriss_pdf` renders the PDFs from these numbers
  (run it to regenerate the fixtures deterministically), and
* :mod:`app.modules.takeoff.seed` derives measurement polygons / polylines /
  count markers from the same numbers, so a seeded measurement always encloses
  exactly the room it names and its value recomputes from its own points.

Keeping both consumers on one dataclass table is deliberate: a copied
coordinate that drifts stays green in every gate, a shared one cannot drift.

The sheet exists in two issues (:data:`REVISION_A`, :data:`REVISION_B`), which
is what a revision compare needs: index B widens the corridor from 2.00 m to
2.50 m for the escape route and adds a second door to the meeting room, so a
handful of quantities really move while the rest stay put. Both issues are the
SAME :class:`Revision` shape, so no revision can carry a number the other
computed differently.

Coordinate systems
------------------
* Plan space: metres, origin at the building's OUTER south-west corner,
  x to the east, y to the north.
* PDF space (reportlab): points (1/72 inch), origin bottom-left of the page.
* Viewer space (what ``TakeoffMeasurement.points`` stores): PDF user units at
  zoom 1 with the origin at the TOP-left of the page and y growing downwards -
  the space PDF.js viewports and the takeoff overlay canvas share (see
  ``frontend/src/features/takeoff/lib/takeoff-viewport.ts``).

The plan is drawn at M 1:100 on DIN A3 landscape, so one metre of building is
``72 / (0.0254 * 100)`` PDF points on paper - the same "pixels per unit" ratio
the frontend's 1:100 scale preset produces, which makes the seeded
``scale_pixels_per_unit`` literally the preset value.
"""

from __future__ import annotations

from dataclasses import dataclass

# --- page & scale ----------------------------------------------------------

#: DIN A3 landscape in PDF points (420 x 297 mm).
PAGE_W_PT: float = 1190.5511811023622
PAGE_H_PT: float = 841.8897637795275

#: Drawing scale denominator (M 1:100).
SCALE_RATIO: int = 100

#: PDF points per real-world metre at M 1:100 (equals the frontend preset:
#: ``72 / (0.0254 * ratio)``).
PT_PER_M: float = 72.0 / (0.0254 * SCALE_RATIO)

#: Building outer south-west corner on the page, in PDF points (bottom-left
#: origin). Leaves room for dimension chains below/left and the title block.
ORIGIN_X_PT: float = 150.0
ORIGIN_Y_PT: float = 200.0

# --- building envelope (metres) -------------------------------------------

BUILDING_W_M: float = 28.24  #: outer width (west-east)
BUILDING_D_M: float = 14.36  #: outer depth (south-north)
EXT_WALL_M: float = 0.365  #: exterior wall thickness
INT_WALL_M: float = 0.115  #: partition thickness

#: Corridor (Flur) clear band along y, full inner width along x.
CORRIDOR_Y0_M: float = 5.995
CORRIDOR_Y1_M: float = 7.995

#: Inner envelope (clear face of the exterior wall).
INNER_X0_M: float = EXT_WALL_M
INNER_X1_M: float = BUILDING_W_M - EXT_WALL_M
INNER_Y0_M: float = EXT_WALL_M
INNER_Y1_M: float = BUILDING_D_M - EXT_WALL_M

DOOR_W_M: float = 0.885  #: single interior door opening
WINDOW_W_M: float = 1.51  #: window opening in exterior walls


@dataclass(frozen=True)
class Room:
    """One labelled room: clear (inner-face) rectangle in plan metres."""

    number: str
    name: str
    x: float
    y: float
    w: float
    d: float

    @property
    def area_m2(self) -> float:
        return self.w * self.d

    @property
    def label(self) -> str:
        return f"{self.name} {self.number}"


#: South row, north row: (number, name, x, width). Widths + partitions sum
#: exactly to the inner envelope on both rows. Only the corridor's NORTH wall
#: ever moves between issues, so the rows' y and depth are derived from it
#: rather than written down twice.
_SOUTH_ROW: tuple[tuple[str, str, float, float], ...] = (
    ("1.01", "Büro", 0.365, 5.39),
    ("1.02", "Büro", 5.870, 5.38),
    ("1.03", "Besprechung", 11.365, 6.59),
    ("1.04", "Teeküche", 18.070, 3.98),
    ("1.05", "Technik", 22.165, 5.71),
)
_NORTH_ROW: tuple[tuple[str, str, float, float], ...] = (
    ("1.06", "Großraumbüro", 0.365, 10.89),
    ("1.07", "WC Herren", 11.370, 3.19),
    ("1.08", "WC Damen", 14.675, 3.21),
    ("1.09", "Kopierraum", 18.000, 4.05),
    ("1.10", "Lager", 22.165, 5.71),
)


def rooms_for_corridor(corridor_y1_m: float) -> dict[str, Room]:
    """Room table for a corridor whose north wall's clear face sits at ``y``.

    The south row and the corridor's south face never move; the north row
    starts behind the corridor's north partition and runs to the exterior
    wall, so widening the corridor takes that depth off the north rooms.
    """
    south_d = CORRIDOR_Y0_M - INT_WALL_M - INNER_Y0_M
    north_y = corridor_y1_m + INT_WALL_M
    north_d = INNER_Y1_M - north_y
    rooms = [Room(number, name, x, INNER_Y0_M, w, south_d) for number, name, x, w in _SOUTH_ROW]
    rooms += [Room(number, name, x, north_y, w, north_d) for number, name, x, w in _NORTH_ROW]
    rooms.append(
        Room("1.11", "Flur", INNER_X0_M, CORRIDOR_Y0_M, INNER_X1_M - INNER_X0_M, corridor_y1_m - CORRIDOR_Y0_M)
    )
    return {r.number: r for r in rooms}


#: Rooms of the first issue, keyed by room number.
ROOMS: dict[str, Room] = rooms_for_corridor(CORRIDOR_Y1_M)


@dataclass(frozen=True)
class Door:
    """Interior door in a corridor wall: opening centre + which wall."""

    room_number: str
    cx: float  #: opening centre x, metres
    south_wall: bool  #: True = corridor SOUTH wall, False = corridor NORTH wall
    t30: bool = False  #: fire-rated door (T30), labelled on the plan


#: One door per room, opening off the corridor. Technik and Lager get T30
#: fire doors (referenced by the retail demo's T30 BOQ position). A door in
#: the corridor's north wall travels with that wall, so its centre line is
#: read off the issue it belongs to (:meth:`Revision.door_center_y`) and
#: never off the module constants.
DOORS: list[Door] = [
    Door("1.01", 5.00, south_wall=True),
    Door("1.02", 6.70, south_wall=True),
    Door("1.03", 12.20, south_wall=True),
    Door("1.04", 18.90, south_wall=True),
    Door("1.05", 23.00, south_wall=True, t30=True),
    Door("1.06", 1.20, south_wall=False),
    Door("1.07", 12.20, south_wall=False),
    Door("1.08", 15.50, south_wall=False),
    Door("1.09", 18.80, south_wall=False),
    Door("1.10", 23.00, south_wall=False, t30=True),
]

#: Entrance (double door) opening in the WEST exterior wall, y-range in metres.
ENTRANCE_Y0_M: float = 6.115
ENTRANCE_Y1_M: float = 7.875

#: Window opening centres in the exterior walls: (centre x, on_south_wall).
WINDOWS: list[tuple[float, bool]] = [
    # south facade
    (1.85, True),
    (4.25, True),
    (7.35, True),
    (9.75, True),
    (12.55, True),
    (14.65, True),
    (16.75, True),
    (19.90, True),
    (24.50, True),
    # north facade
    (1.80, False),
    (4.30, False),
    (6.80, False),
    (9.30, False),
    (12.90, False),
    (16.20, False),
    (19.90, False),
    (24.50, False),
]


def window_wall_center_y(south: bool) -> float:
    """Centre-line y of the exterior wall a window sits in, metres."""
    return EXT_WALL_M / 2.0 if south else BUILDING_D_M - EXT_WALL_M / 2.0


# --- coordinate transforms -------------------------------------------------


def to_pdf_xy(x_m: float, y_m: float) -> tuple[float, float]:
    """Plan metres -> PDF points (bottom-left origin, y up). For reportlab."""
    return (ORIGIN_X_PT + x_m * PT_PER_M, ORIGIN_Y_PT + y_m * PT_PER_M)


def to_viewer_xy(x_m: float, y_m: float) -> tuple[float, float]:
    """Plan metres -> takeoff viewer coordinates (top-left origin, y down)."""
    x_pt, y_pt = to_pdf_xy(x_m, y_m)
    return (x_pt, PAGE_H_PT - y_pt)


def viewer_points(points_m: list[tuple[float, float]]) -> list[dict[str, float]]:
    """Convert plan-space vertices to the ``points`` JSON the viewer stores."""
    out: list[dict[str, float]] = []
    for x_m, y_m in points_m:
        x, y = to_viewer_xy(x_m, y_m)
        out.append({"x": round(x, 3), "y": round(y, 3)})
    return out


def room_polygon(room: Room) -> list[tuple[float, float]]:
    """Clear-face rectangle of a room as a closed-ring vertex list (metres)."""
    return [
        (room.x, room.y),
        (room.x + room.w, room.y),
        (room.x + room.w, room.y + room.d),
        (room.x, room.y + room.d),
    ]


def building_outline_m(inset: float = 0.0) -> list[tuple[float, float]]:
    """Outer building rectangle, optionally inset (metres)."""
    return [
        (inset, inset),
        (BUILDING_W_M - inset, inset),
        (BUILDING_W_M - inset, BUILDING_D_M - inset),
        (inset, BUILDING_D_M - inset),
    ]


def format_area_de(value_m2: float) -> str:
    """German-style area label with a decimal comma, e.g. ``29,73 m²``."""
    return f"{value_m2:.2f}".replace(".", ",") + " m²"


def format_len_de(value_m: float) -> str:
    """German-style dimension label in metres with a decimal comma.

    Two decimals by default ("2,00", "5,39"), three when the value needs them
    ("0,115", "5,885") - matching how chains on German drawings are labelled.
    """
    if abs(value_m - round(value_m, 2)) < 5e-4:
        return f"{value_m:.2f}".replace(".", ",")
    return f"{value_m:.3f}".replace(".", ",")


# --- issues of the sheet (Index A / Index B) -------------------------------


@dataclass(frozen=True)
class Revision:
    """One issue of sheet A-2.01: its geometry plus what the index table says.

    Every consumer reads rooms and doors THROUGH the issue it renders or
    measures. A door in the corridor's north wall, for instance, travels with
    that wall, and reading its centre line off the module constants instead
    would leave index B's markers standing in index A's wall.
    """

    index: str  #: revision index letter as printed in the title block
    issued: str  #: issue date as printed, e.g. "07/2026"
    corridor_y1: float  #: clear face of the corridor's north wall, metres
    rooms: dict[str, Room]
    doors: tuple[Door, ...]
    #: Index table, newest issue first: (index, change note, date).
    history: tuple[tuple[str, str, str], ...]
    #: Revision cloud around the changed area, as a plan-metre bounding box
    #: (x0, y0, x1, y1). None on the first issue, which changed nothing.
    cloud: tuple[float, float, float, float] | None = None
    #: Centre line of the wall this issue moved away from, drawn dashed and
    #: labelled "Rückbau" so the sheet shows what leaves as well as what comes.
    demolished_wall_y: float | None = None

    def door_center_y(self, door: Door) -> float:
        """Centre-line y of the corridor wall a door sits in, metres."""
        if door.south_wall:
            return CORRIDOR_Y0_M - INT_WALL_M / 2.0
        return self.corridor_y1 + INT_WALL_M / 2.0

    def room_polygon_m(self, number: str) -> list[tuple[float, float]]:
        """Clear-face rectangle of one of this issue's rooms (metres)."""
        return room_polygon(self.rooms[number])

    def doors_for(self, room_number: str) -> list[Door]:
        """This issue's doors opening into one room, west to east."""
        return sorted((d for d in self.doors if d.room_number == room_number), key=lambda d: d.cx)


#: Corridor clear width of the second issue: the escape route was taken from
#: 2,00 m to 2,50 m, which is why the north row lost 50 cm of depth.
CORRIDOR_Y1_B_M: float = CORRIDOR_Y1_M + 0.5

#: Second door into Besprechung 1.03, required as a second exit once the
#: meeting room is used at full occupancy.
_SECOND_MEETING_DOOR = Door("1.03", 16.50, south_wall=True)

REVISION_A = Revision(
    index="A",
    issued="07/2026",
    corridor_y1=CORRIDOR_Y1_M,
    rooms=ROOMS,
    doors=tuple(DOORS),
    history=(("A", "Erstausgabe", "07.2026"),),
)

REVISION_B = Revision(
    index="B",
    issued="08/2026",
    corridor_y1=CORRIDOR_Y1_B_M,
    rooms=rooms_for_corridor(CORRIDOR_Y1_B_M),
    doors=(*DOORS, _SECOND_MEETING_DOOR),
    history=(
        ("B", "Flur 1.11 auf 2,50 m verbreitert (Rettungsweg), 2. Tür Besprechung 1.03", "08.2026"),
        ("A", "Erstausgabe", "07.2026"),
    ),
    # The cloud spans the corridor band across the full width plus the swing
    # of the new door, which is where every change of this issue sits.
    cloud=(-0.35, CORRIDOR_Y0_M - 1.45, BUILDING_W_M + 0.35, CORRIDOR_Y1_B_M + 0.45),
    demolished_wall_y=CORRIDOR_Y1_M + INT_WALL_M / 2.0,
)
