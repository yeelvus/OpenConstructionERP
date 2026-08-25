# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Demo payment clocks for the German demo projects.

Called from the demo project installer for projects whose address is in
Germany. Seeds a short run of interim payment invoices (Abschlagsrechnungen)
under the ``de_vob_b_abschlag`` regime, so the payment clock screen on a German
demo project shows the § 16 VOB/B arithmetic working on the day it is opened:
one invoice paid inside its 21 days, one past its final date with statutory
interest running, and one whose clock is still ticking.

Every date is anchored to the day the demo is installed rather than to a
constant. A payment clock is about deadlines relative to *now*, and a seed
anchored to a hardcoded date would drift: the "still ticking" invoice would be
months overdue within weeks of the constant being written.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, timedelta
from decimal import Decimal
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

DEMO_REGIME_CODE = "de_vob_b_abschlag"

# (reference, days since the Aufstellung reached the client, applied amount,
#  days from receipt to payment or None while unpaid, notes). The amounts are
# deliberately non-round: a demo invoice of exactly one million reads as a
# placeholder, not as a measured valuation. With the regime's 21-day final
# date, 63 days ago + paid on day 18 is a payment in time, 34 days ago and
# unpaid is 13 days over the final date (and past the 30-day outer default
# limit of § 16 Abs. 5 Nr. 3 VOB/B), and 8 days ago has 13 days left to run.
_DEMO_APPLICATIONS: tuple[tuple[str, int, str, int | None, str], ...] = (
    (
        "AZ-02",
        63,
        "1237842.19",
        18,
        "2. Abschlagsrechnung Rohbau: Baugrube, Verbau und Gründung. Zahlung fristgerecht eingegangen.",
    ),
    (
        "AZ-03",
        34,
        "941618.45",
        None,
        "3. Abschlagsrechnung Rohbau: Bodenplatte und Kelleraußenwände. "
        "Zahlung überfällig, Nachfrist nach § 16 Abs. 5 Nr. 3 VOB/B in Vorbereitung.",
    ),
    (
        "AZ-04",
        8,
        "1082309.77",
        None,
        "4. Abschlagsrechnung Rohbau: Kerne und Decken EG bis 2. OG. Zahlungsfrist läuft.",
    ),
)


async def seed_demo_payment_clocks(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    created_by: str | None = None,
    today: date | None = None,
) -> int:
    """Open the demo clocks on one project. Returns how many were opened.

    ``today`` is an argument so the tests are not hostages to the machine
    clock; the installer leaves it to default to the installation date.
    """
    from app.modules.payment_clock import schemas, service

    await service.ensure_regimes(session)
    regime = await service.get_regime_by_code(session, code=DEMO_REGIME_CODE)
    if regime is None:
        logger.debug("Regime %s is not in the catalogue; no demo clocks seeded", DEMO_REGIME_CODE)
        return 0

    anchor = today or date.today()
    count = 0
    for reference, age_days, amount, paid_after_days, notes in _DEMO_APPLICATIONS:
        application_date = anchor - timedelta(days=age_days)
        paid = paid_after_days is not None
        body = schemas.ApplicationCreate(
            project_id=project_id,
            regime_code=DEMO_REGIME_CODE,
            source_type="manual",
            reference=reference,
            application_date=application_date,
            # The monthly valuation period the Aufstellung covers, ending a few
            # days before it reached the client.
            period_start=application_date - timedelta(days=33),
            period_end=application_date - timedelta(days=3),
            applied_amount=Decimal(amount),
            currency="EUR",
            status="paid" if paid else "open",
            paid_at=application_date + timedelta(days=paid_after_days) if paid else None,
            paid_amount=Decimal(amount) if paid else None,
            notes=notes,
        )
        await service.create_application(session, body=body, regime=regime, created_by=created_by)
        count += 1
    return count


__all__ = ["DEMO_REGIME_CODE", "seed_demo_payment_clocks"]
