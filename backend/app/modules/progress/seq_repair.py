# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
"""Startup fixup: put a heal-numbered ``oe_progress_entry.seq`` back in observation order.

``seq`` decides "latest wins" for every progress reading (see
:func:`app.modules.progress.repository._latest_first`), and the two schema paths
that can add the column number the pre-existing rows differently:

* the Alembic migration ``v3258_progress_entry_seq`` backfills with an explicit
  ``ORDER BY recorded_at, created_at, id`` - observation order, the best order
  the historical data can still be said to have;
* the boot-time heal ``app.core.postgres_migrator.postgres_auto_migrate`` emits
  ``ALTER TABLE ... ADD COLUMN seq BIGINT NOT NULL DEFAULT nextval(...)``, and
  PostgreSQL evaluates that default while rewriting the table, so the rows are
  numbered in HEAP order - where they happen to sit on disk.

Same rows, same product, different winner depending on which path built the
schema. Measured: three rows lying physically 90/10/50 with ``recorded_at``
running 10-50-90 come out numbered 10,50,90 by Alembic and 90,10,50 by the heal.
Only rows that predate the column can be numbered this way; everything written
afterwards gets ``seq`` from ``nextval`` at INSERT, which is insertion order by
construction.

This runs after the heal, at both places that call it - every boot, and
``init-db``. That is the reverse of ``app.modules.takeoff.dedup``, which runs
before it, and the asymmetry is deliberate: takeoff's merge has to clear the way
for an index the heal creates, while the column this repairs is one the heal
itself creates, so going first would leave a boot-long window in which the
module answers with the wrong reading.

Detection is a single index-ordered scan, and it looks for STRICT descents only:
a pair where the later ``seq`` carries a strictly earlier ``(recorded_at,
created_at)``. Rows that tie on both timestamps are not a descent, so a batch
written inside one transaction - every timestamp identical, ``seq`` the only
thing separating them - never triggers a renumber. That matters: the renumber
applies the canonical key globally, ``id`` included, so a triggered repair also
re-sorts tied groups into uuid order, exactly as the migration would have. The
gate is what keeps that off a database which never diverged.

Idempotent: after a renumber the table is in observation order, so the next boot
finds no descent and does nothing.
"""

import logging

from sqlalchemy import inspect, text
from sqlalchemy.ext.asyncio import AsyncConnection

logger = logging.getLogger(__name__)

_TABLE = "oe_progress_entry"
_COLUMN = "seq"
# Mirrors ``_SEQUENCE_NAME`` in models.py and ``_SEQUENCE`` in the migration.
_SEQUENCE = "oe_progress_entry_seq_seq"

# Counts the pairs where seq order contradicts observation order. A sequence is
# sorted exactly when no ADJACENT pair is out of order, so scanning neighbours in
# seq order is not an approximation of a full pairwise comparison, it is the same
# answer for one pass instead of a sort. The row-wise comparison is NULL for the
# first row (no predecessor) and therefore not counted.
_DESCENTS = f"""
    SELECT count(*)
    FROM (
        SELECT recorded_at,
               created_at,
               lag(recorded_at) OVER w AS prev_recorded_at,
               lag(created_at) OVER w AS prev_created_at
        FROM {_TABLE}
        WINDOW w AS (ORDER BY {_COLUMN})
    ) AS scanned
    WHERE (recorded_at, created_at) < (prev_recorded_at, prev_created_at)
"""  # noqa: S608 - fixed table/column names, no user input

# Renumbering is a permutation of the values already in a UNIQUE column, so it
# cannot be done in place: PostgreSQL checks a non-deferrable unique constraint
# per row, and the first row that lands on a number another row still holds
# aborts the statement. Numbering from above the current maximum keeps every
# assignment collision-free in one pass. The values jump, which costs nothing -
# seq is internal, never exposed by the API, and only ever read as an order.
_RENUMBER = f"""
    UPDATE {_TABLE} AS e
    SET {_COLUMN} = ranked.rn + :offset
    FROM (
        SELECT id,
               row_number() OVER (ORDER BY recorded_at, created_at, id) AS rn
        FROM {_TABLE}
    ) AS ranked
    WHERE e.id = ranked.id
"""  # noqa: S608 - fixed table/column names, no user input


async def repair_progress_entry_seq(conn: AsyncConnection) -> int:
    """Renumber ``seq`` into observation order when the heal numbered it by heap.

    Args:
        conn: An open async PostgreSQL connection (inside a transaction).

    Returns:
        The number of rows renumbered (0 when the table, the column or the
        divergence is absent - the common case on every boot).
    """
    has_table = await conn.run_sync(lambda c: inspect(c).has_table(_TABLE))
    if not has_table:
        # Fresh database: create_all has not built the table yet, and it will
        # build it with the column, so there is nothing to number.
        return 0

    columns = await conn.run_sync(lambda c: {col["name"] for col in inspect(c).get_columns(_TABLE)})
    if _COLUMN not in columns:
        # The heal could not add the column (a role without DDL rights, or a
        # lock timeout). Numbering rows of a column that is not there is not
        # this function's problem to solve.
        return 0

    descents = (await conn.execute(text(_DESCENTS))).scalar() or 0
    if not descents:
        return 0

    offset = (await conn.execute(text(f"SELECT COALESCE(MAX({_COLUMN}), 0) FROM {_TABLE}"))).scalar() or 0  # noqa: S608
    result = await conn.execute(text(_RENUMBER), {"offset": int(offset)})
    renumbered = result.rowcount

    await _advance_sequence(conn)

    logger.info(
        "progress.seq_repair: renumbered %d entries into observation order (%d out-of-order pair(s) found)",
        renumbered,
        descents,
    )
    return renumbered


async def _advance_sequence(conn: AsyncConnection) -> None:
    """Park the sequence above every renumbered row, and never below where it was.

    The renumber lifts the highest ``seq`` above the number the sequence has
    reached, so the next INSERT would collide with a row that already exists
    unless the sequence is moved up. Moving it DOWN is the other half of the
    same trap: a sequence that has handed out numbers to rolled-back inserts
    stands above ``MAX(seq)``, and rewinding it to ``MAX(seq) + 1`` would hand
    those numbers out a second time. Take whichever is higher.
    """
    sequence = (await conn.execute(text("SELECT to_regclass(:s)"), {"s": _SEQUENCE})).scalar()
    if sequence is None:
        # The column exists without its sequence - a shape this repair did not
        # create and cannot make sense of. Leave it to the schema heal.
        return

    state = (await conn.execute(text(f"SELECT last_value, is_called FROM {_SEQUENCE}"))).one()  # noqa: S608
    # ``is_called`` false means last_value has not been handed out yet, so it is
    # itself the next free number.
    next_free = int(state.last_value) + (1 if state.is_called else 0)
    highest = (await conn.execute(text(f"SELECT COALESCE(MAX({_COLUMN}), 0) FROM {_TABLE}"))).scalar() or 0  # noqa: S608

    # The third argument false makes the NEXT nextval() return exactly this
    # number, matching how the migration positions the same sequence.
    await conn.execute(
        text(f"SELECT setval('{_SEQUENCE}', :v, false)"),
        {"v": max(next_free, int(highest) + 1)},
    )
