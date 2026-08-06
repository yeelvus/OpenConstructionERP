# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Turn a stored party id into the name a person expects to read.

Several registers store *who* as a bare 36-character string: the inspector on a
quality inspection, the assignee on a punch item, the technician on a service
call. The column carries no foreign key, and the value it holds depends on who
wrote the row:

* the demo seeder writes a :class:`Contact` id, because these registers are
  about an external party (a consultant, a subcontractor's engineer);
* a picker in the UI writes a :class:`User` id, because the person is on the
  team;
* a plain text input writes whatever was typed, which is usually a name.

Reading any one of those as if it were the others is what put a raw UUID in an
INSPECTOR column on screen. So the resolution has to try both tables and then
give up gracefully, and the caller has to keep the stored value as the fallback
rather than blanking the cell: on a hand-typed row the stored value already
*is* the name, and on a deleted party it is the only trace left.

This exists as a core helper rather than per module because the same three-way
ambiguity appears on at least inspections, punch list, service, commissioning
and close-out. Resolving it once per module is how they drifted apart in the
first place - one of them resolves against users only, and therefore prints a
false "Unassigned" for every seeded row.
"""

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.contacts.models import Contact
from app.modules.users.models import User

__all__ = ["contact_display_name", "resolve_party_names", "user_display_name"]


def contact_display_name(c: Contact) -> str:
    """Company first, then a person's full name, then the email.

    Same order as ``Contact.__repr__`` and as procurement's vendor label, so a
    party reads identically wherever it appears. The email column is
    ``primary_email``; there is no plain ``email`` on this model.
    """
    if c.company_name:
        return c.company_name
    full = f"{c.first_name or ''} {c.last_name or ''}".strip()
    return full or c.primary_email or ""


def user_display_name(u: User) -> str:
    """A user's own full name, falling back to the email they sign in with."""
    return (u.full_name or "").strip() or u.email or ""


async def resolve_party_names(session: AsyncSession, ids: Iterable[str | None]) -> dict[str, str]:
    """Resolve party ids to display names in at most two round trips.

    Contacts are looked up first and users only for whatever is left over, so a
    register whose rows are all seeded costs exactly one query. Ids that match
    nothing are simply absent from the result; the caller is expected to fall
    back to the stored value, which is either a typed name or the last trace of
    a deleted party.

    Values that cannot be a party id at all - a typed name, an empty string -
    are filtered out before the query rather than passed to the database, which
    would otherwise reject them on a UUID-typed column.
    """
    wanted = {str(i).strip() for i in ids if i and str(i).strip()}
    # A stored name is not an id and must never reach the WHERE clause: on
    # PostgreSQL a uuid column compared against 'Jane Cooper' raises, which
    # would turn a cosmetic lookup into a 500 on the whole list endpoint.
    candidates = {i for i in wanted if _looks_like_an_id(i)}
    if not candidates:
        return {}

    rows = (await session.execute(select(Contact).where(Contact.id.in_(candidates)))).scalars().all()
    names = {str(c.id): contact_display_name(c) for c in rows}

    remaining = candidates - set(names)
    if remaining:
        users = (await session.execute(select(User).where(User.id.in_(remaining)))).scalars().all()
        for u in users:
            names[str(u.id)] = user_display_name(u)

    # An empty display name is worse than no entry: it would blank a cell that
    # still has an id to show. Drop those so the caller's fallback takes over.
    return {k: v for k, v in names.items() if v}


def _looks_like_an_id(value: str) -> bool:
    """Cheap shape test for a 36-character hyphenated UUID.

    Deliberately not ``uuid.UUID(value)``: this runs per row on a list endpoint
    and the only thing it has to separate is "id" from "somebody's name".
    """
    if len(value) != 36:
        return False
    return value[8] == value[13] == value[18] == value[23] == "-"
