# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Tax withholding service - what is deducted, at what rate, from what base.

Three decisions live here and nowhere else.

**The base.** ``taxable_base = gross - materials - VAT``, with each subtraction
made only where the scheme makes it. The UK scheme deducts on labour and takes
both away; section 48 EStG deducts from the Gegenleistung and takes neither.
Deducting on the gross where materials should have come out over-withholds on
every payment where a subcontractor supplied any, month after month, and the
subcontractor only sees it back at the end of their tax year. That is why the
subtraction is driven by a column on the scheme rather than by a constant.

**The band.** A reduced or zero rate is something a party is verified for, and
a verification runs out. When it has, the party falls to the scheme's default
band, which is always the highest one. Real life makes that drop silently; here
it is a named decision with a reason attached, so the figure can be explained.

**The rounding.** Money is quantised to two decimal places, half away from
zero, once, at the end. Rounding a rate or an intermediate would put the answer
a cent away from the one the authority computes.

Everything above is a plain function over plain values, so the arithmetic that
decides how much money leaves the business is testable without a database.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.tax_withholding import repository
from app.modules.tax_withholding.data import WITHHOLDING_REGIMES
from app.modules.tax_withholding.models import (
    PartyTaxStatus,
    ReverseChargeDetermination,
    WithholdingDeduction,
    WithholdingRegime,
)

logger = logging.getLogger(__name__)

ZERO = Decimal("0")
_CENTS = Decimal("0.01")
_HUNDRED = Decimal("100")


def to_decimal(value: Any, default: Decimal = ZERO) -> Decimal:
    """Read a money-or-rate value from whatever shape it arrived in.

    Strings are the wire format for money in this platform, so a string is the
    expected input, not the fallback. A value that cannot be read at all
    becomes ``default`` rather than raising: a validation rule reporting "this
    figure does not add up" is more use than a 500 from a report.
    """
    if isinstance(value, Decimal):
        return value if value.is_finite() else default
    if value is None or isinstance(value, bool):
        return default
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return default
    return parsed if parsed.is_finite() else default


def quantise(value: Decimal) -> Decimal:
    """Two decimal places, half away from zero - the way a tax figure rounds."""
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


def compute_taxable_base(
    gross: Decimal,
    materials: Decimal,
    vat: Decimal,
    *,
    materials_excluded: bool = True,
    vat_excluded: bool = True,
) -> Decimal:
    """The figure the rate is applied to.

    Never negative: materials booked higher than the gross is a data error, and
    a negative base would turn a deduction into a payment to the subcontractor.
    The rules report it; the arithmetic floors it at zero rather than
    propagating an amount nobody could remit.
    """
    base = gross
    if materials_excluded:
        base -= materials
    if vat_excluded:
        base -= vat
    return quantise(base if base > ZERO else ZERO)


def compute_tax_withheld(base: Decimal, rate_pct: Decimal) -> Decimal:
    """Tax withheld from ``base`` at ``rate_pct`` percent."""
    if base <= ZERO or rate_pct <= ZERO:
        return ZERO
    return quantise(base * rate_pct / _HUNDRED)


# ── Bands and verification ───────────────────────────────────────────────────


@dataclass
class BandDecision:
    """Which band was applied, at what rate, and why it is not another one."""

    band_code: str
    rate_pct: Decimal
    requires_verification: bool = False
    downgraded_from: str = ""
    reasons: list[str] = field(default_factory=list)


def bands_of(regime: WithholdingRegime | dict[str, Any] | None) -> list[dict[str, Any]]:
    """The scheme's rate table as a list of dicts, whatever shape it came in."""
    if regime is None:
        return []
    raw = regime.get("bands") if isinstance(regime, dict) else regime.bands
    if not isinstance(raw, list):
        return []
    return [band for band in raw if isinstance(band, dict)]


def find_band(regime: WithholdingRegime | dict[str, Any] | None, band_code: str) -> dict[str, Any] | None:
    """One band of a scheme by code, or ``None`` when the scheme has no such band."""
    if not band_code:
        return None
    for band in bands_of(regime):
        if str(band.get("code") or "") == band_code:
            return band
    return None


def verification_is_current(status: PartyTaxStatus | None, as_of: date) -> bool:
    """Whether ``status`` evidences a verification that still holds on ``as_of``.

    Four things have to be true at once, and each of them is a way this fails
    in practice: the standing exists, it has not been revoked, the window it
    covers contains the date, and there is a reference to the authority's own
    answer. A standing marked active with no reference is somebody's intention,
    not a verification.
    """
    if status is None:
        return False
    if status.status in {"revoked", "expired"}:
        return False
    if not (status.verification_reference or "").strip():
        return False
    if status.valid_from and status.valid_from > as_of:
        return False
    return not (status.valid_to is not None and status.valid_to < as_of)


def resolve_band(
    regime: WithholdingRegime,
    *,
    requested_band: str = "",
    party_status: PartyTaxStatus | None = None,
    as_of: date | None = None,
) -> BandDecision:
    """Decide the band a payment is deducted at.

    The order is explicit request, then the party's recorded standing, then the
    scheme default. Whatever comes out of that, a band that requires
    verification is only kept if the verification is current on ``as_of``;
    otherwise the party drops to the scheme default, which is the highest-rate
    band, and the drop is reported rather than merely applied.
    """
    on_date = as_of or date.today()
    reasons: list[str] = []

    wanted = requested_band or (party_status.band_code if party_status else "") or regime.default_band_code
    band = find_band(regime, wanted)
    if band is None:
        available = bands_of(regime)
        fallback = find_band(regime, regime.default_band_code) or (available[-1] if available else None)
        if fallback is None:
            reasons.append(f"Scheme {regime.scheme_code} defines no rate bands, so no rate could be applied.")
            return BandDecision(band_code=wanted, rate_pct=ZERO, reasons=reasons)
        if wanted:
            reasons.append(
                f"Band '{wanted}' is not defined by scheme {regime.scheme_code}; "
                f"the scheme default '{fallback.get('code')}' was applied instead."
            )
        band = fallback
        wanted = str(band.get("code") or "")

    requires_verification = bool(band.get("requires_verification"))
    if requires_verification and not verification_is_current(party_status, on_date):
        default_band = find_band(regime, regime.default_band_code)
        if default_band is not None and str(default_band.get("code") or "") != wanted:
            if party_status is None:
                reasons.append(
                    f"Band '{wanted}' requires a verification and none is recorded for this party, "
                    f"so the higher band '{default_band.get('code')}' applies."
                )
            else:
                reasons.append(
                    f"The verification behind band '{wanted}' is not valid on {on_date.isoformat()}, "
                    f"so the higher band '{default_band.get('code')}' applies."
                )
            return BandDecision(
                band_code=str(default_band.get("code") or ""),
                rate_pct=to_decimal(default_band.get("rate_pct")),
                requires_verification=bool(default_band.get("requires_verification")),
                downgraded_from=wanted,
                reasons=reasons,
            )
        reasons.append(
            f"Band '{wanted}' requires a verification that is not valid on {on_date.isoformat()}, "
            "and the scheme names no higher band to fall back to."
        )

    return BandDecision(
        band_code=wanted,
        rate_pct=to_decimal(band.get("rate_pct")),
        requires_verification=requires_verification,
        reasons=reasons,
    )


@dataclass
class DeductionFigures:
    """A whole computed deduction: the base, the rate, the money, and the why."""

    band_code: str
    rate_pct: Decimal
    gross_amount: Decimal
    qualifying_materials: Decimal
    vat_amount: Decimal
    taxable_base: Decimal
    tax_withheld: Decimal
    net_payable: Decimal
    below_threshold: bool = False
    downgraded_from: str = ""
    reasons: list[str] = field(default_factory=list)


def compute_deduction(
    regime: WithholdingRegime,
    *,
    gross_amount: Decimal,
    currency_code: str,
    qualifying_materials: Decimal = ZERO,
    vat_amount: Decimal = ZERO,
    requested_band: str = "",
    party_status: PartyTaxStatus | None = None,
    as_of: date | None = None,
) -> DeductionFigures:
    """Work out one deduction from end to end.

    ``below_threshold`` is a flag and not a rate change on purpose. Where a
    scheme has an exemption limit it is normally an annual figure per payee -
    Germany's section 48 EStG limit is - and a single payment cannot tell
    whether the year is already over it. Reporting the possibility is honest;
    zeroing the deduction on one payment's evidence would not be.

    ``currency_code`` is the payment's currency and is required rather than
    defaulted, because the exemption limit is denominated in the scheme's
    currency and comparing across two of them is arithmetic on unlike units. A
    default would have made the wrong answer the quiet one.
    """
    decision = resolve_band(regime, requested_band=requested_band, party_status=party_status, as_of=as_of)
    base = compute_taxable_base(
        gross_amount,
        qualifying_materials,
        vat_amount,
        materials_excluded=regime.materials_excluded,
        vat_excluded=regime.vat_excluded,
    )
    withheld = compute_tax_withheld(base, decision.rate_pct)
    threshold = regime.threshold_amount
    paid_in = (currency_code or "").strip().upper()
    scheme_currency = (regime.currency_code or "").strip().upper()
    same_currency = bool(paid_in) and paid_in == scheme_currency
    below = threshold is not None and same_currency and gross_amount <= to_decimal(threshold)
    reasons = list(decision.reasons)
    if below:
        reasons.append(
            f"This payment is at or below the scheme's exemption limit of "
            f"{to_decimal(threshold)} {regime.currency_code}. The limit normally applies to the "
            "payee's total for the year, so check the year to date before treating it as exempt."
        )
    elif threshold is not None and not same_currency:
        # The limit is a figure in the scheme's own currency. Holding it up
        # against a payment in another one compares two different units and
        # would answer with whichever way the exchange rate happened to fall.
        reasons.append(
            f"The scheme's exemption limit is {to_decimal(threshold)} {regime.currency_code} and this "
            f"payment is in {paid_in or 'a currency that was not stated'}, so the limit has not been "
            "applied. Convert at the rate for the payment date before deciding whether the payee is under it."
        )
    return DeductionFigures(
        band_code=decision.band_code,
        rate_pct=decision.rate_pct,
        gross_amount=quantise(gross_amount),
        qualifying_materials=quantise(qualifying_materials),
        vat_amount=quantise(vat_amount),
        taxable_base=base,
        tax_withheld=withheld,
        net_payable=quantise(gross_amount - withheld),
        below_threshold=below,
        downgraded_from=decision.downgraded_from,
        reasons=reasons,
    )


# ── Seeding ──────────────────────────────────────────────────────────────────


async def seed_regimes(session: AsyncSession) -> tuple[int, int, list[str]]:
    """Install the shipped schemes. Returns ``(created, existing, scheme_codes)``.

    Only fills gaps. A scheme already present is left exactly as it is, because
    an operator who edited a rate did so for a reason - a rate that changed
    mid-year, a ruling specific to their business - and an upgrade silently
    restoring the shipped figure would change what the next return says.
    """
    created = 0
    existing = 0
    codes: list[str] = []
    for shipped in WITHHOLDING_REGIMES:
        codes.append(str(shipped["scheme_code"]))
        found = await repository.get_regime_by_scheme(
            session,
            country_code=str(shipped["country_code"]),
            scheme_code=str(shipped["scheme_code"]),
        )
        if found is not None:
            existing += 1
            continue
        threshold = shipped.get("threshold_amount")
        await repository.add_regime(
            session,
            WithholdingRegime(
                country_code=str(shipped["country_code"]),
                scheme_code=str(shipped["scheme_code"]),
                scheme_name=str(shipped["scheme_name"]),
                legal_reference=str(shipped.get("legal_reference") or ""),
                authority=str(shipped.get("authority") or ""),
                currency_code=str(shipped["currency_code"]),
                bands=[dict(band) for band in shipped.get("bands", [])],
                default_band_code=str(shipped.get("default_band_code") or ""),
                materials_excluded=bool(shipped.get("materials_excluded", True)),
                vat_excluded=bool(shipped.get("vat_excluded", True)),
                verification_validity_months=int(shipped.get("verification_validity_months") or 0),
                threshold_amount=to_decimal(threshold) if threshold is not None else None,
                notes=str(shipped.get("notes") or ""),
                is_active=True,
            ),
        )
        created += 1
    logger.info("tax_withholding: seeded %d scheme(s), %d already present", created, existing)
    return created, existing, codes


# ── Persistence ──────────────────────────────────────────────────────────────


def apply_regime_body(regime: WithholdingRegime, body: Any) -> None:
    """Copy the writable fields of a validated scheme request onto the row."""
    regime.country_code = body.country_code
    regime.scheme_code = body.scheme_code
    regime.scheme_name = body.scheme_name
    regime.legal_reference = body.legal_reference
    regime.authority = body.authority
    regime.currency_code = body.currency_code
    regime.bands = [band.model_dump(mode="json") for band in body.bands]
    regime.default_band_code = body.default_band_code
    regime.materials_excluded = body.materials_excluded
    regime.vat_excluded = body.vat_excluded
    regime.verification_validity_months = body.verification_validity_months
    regime.threshold_amount = body.threshold_amount
    regime.notes = body.notes
    regime.is_active = body.is_active


def apply_party_status_body(row: PartyTaxStatus, body: Any) -> None:
    """Copy the writable fields of a validated standing request onto the row."""
    row.party_id = body.party_id
    row.party_type = body.party_type
    row.party_name = body.party_name
    row.regime_id = body.regime_id
    row.band_code = body.band_code
    row.verification_reference = body.verification_reference
    row.verified_on = body.verified_on
    row.valid_from = body.valid_from
    row.valid_to = body.valid_to
    row.evidence_document_id = body.evidence_document_id
    row.evidence_reference = body.evidence_reference
    row.status = body.status
    row.notes = body.notes


def apply_deduction_body(row: WithholdingDeduction, body: Any, figures: DeductionFigures) -> None:
    """Copy a validated deduction request onto the row, computing what was left out.

    ``taxable_base``, ``tax_withheld`` and ``rate_pct`` are taken from the
    request when it supplied them and from ``figures`` when it did not. A
    caller that supplies its own numbers keeps them - an imported deduction has
    already been decided by whatever filed it, and quietly recomputing it would
    replace a record of what happened with a claim about what should have.
    The validation rules then have something real to disagree with.
    """
    row.project_id = body.project_id
    row.regime_id = body.regime_id
    row.party_status_id = body.party_status_id
    row.party_id = body.party_id
    row.party_name = body.party_name
    row.payment_reference = body.payment_reference
    row.period_start = body.period_start
    row.period_end = body.period_end
    row.gross_amount = body.gross_amount
    row.qualifying_materials = body.qualifying_materials
    row.vat_amount = body.vat_amount
    row.taxable_base = body.taxable_base if body.taxable_base is not None else figures.taxable_base
    row.rate_pct = body.rate_pct if body.rate_pct is not None else figures.rate_pct
    row.tax_withheld = body.tax_withheld if body.tax_withheld is not None else figures.tax_withheld
    row.band_code = body.band_code or figures.band_code
    row.currency_code = body.currency_code
    row.status = body.status
    row.remitted_at = body.remitted_at
    row.return_reference = body.return_reference
    row.notes = body.notes


def apply_determination_body(row: ReverseChargeDetermination, body: Any) -> None:
    """Copy the writable fields of a validated determination onto the row."""
    row.project_id = body.project_id
    row.invoice_id = body.invoice_id
    row.invoice_reference = body.invoice_reference
    row.country_code = body.country_code
    row.rule_code = body.rule_code
    row.buyer_accounts_for_vat = body.buyer_accounts_for_vat
    row.legal_reference = body.legal_reference
    row.invoice_wording = body.invoice_wording
    row.net_amount = body.net_amount
    row.vat_amount = body.vat_amount
    row.currency_code = body.currency_code
    row.status = body.status
    row.notes = body.notes


# ── Validation payloads ──────────────────────────────────────────────────────
#
# The rules run on a plain dict rather than on ORM instances so they can be
# exercised without a database, and so a figure arriving from an import can be
# checked before anything is stored.


def deduction_payload(
    body: Any,
    *,
    regime: WithholdingRegime | None,
    party_status: PartyTaxStatus | None,
    figures: DeductionFigures | None = None,
) -> dict[str, Any]:
    """The dict the deduction rules read. See :mod:`.validators` for the contract."""
    base = body.taxable_base if body.taxable_base is not None else (figures.taxable_base if figures else None)
    withheld = body.tax_withheld if body.tax_withheld is not None else (figures.tax_withheld if figures else None)
    rate = body.rate_pct if body.rate_pct is not None else (figures.rate_pct if figures else None)
    band_code = body.band_code or (figures.band_code if figures else "")
    payload: dict[str, Any] = {
        "record_type": "deduction",
        "gross_amount": body.gross_amount,
        "qualifying_materials": body.qualifying_materials,
        "vat_amount": body.vat_amount,
        "taxable_base": base if base is not None else ZERO,
        "tax_withheld": withheld if withheld is not None else ZERO,
        "rate_pct": rate if rate is not None else ZERO,
        "band_code": band_code,
        "currency_code": body.currency_code,
        "period_start": body.period_start,
        "period_end": body.period_end,
        "payment_reference": body.payment_reference,
    }
    if regime is not None:
        payload["regime"] = {
            "scheme_code": regime.scheme_code,
            "country_code": regime.country_code,
            "currency_code": regime.currency_code,
            "materials_excluded": regime.materials_excluded,
            "vat_excluded": regime.vat_excluded,
            "default_band_code": regime.default_band_code,
            "bands": bands_of(regime),
        }
    if party_status is not None:
        payload["party_status"] = {
            "band_code": party_status.band_code,
            "verification_reference": party_status.verification_reference,
            "valid_from": party_status.valid_from,
            "valid_to": party_status.valid_to,
            "status": party_status.status,
        }
    return payload


def determination_payload(body: Any) -> dict[str, Any]:
    """The dict the reverse-charge rules read."""
    return {
        "record_type": "reverse_charge",
        "buyer_accounts_for_vat": body.buyer_accounts_for_vat,
        "invoice_reference": body.invoice_reference,
        "country_code": body.country_code,
        "rule_code": body.rule_code,
        "legal_reference": body.legal_reference,
        "invoice_wording": body.invoice_wording,
        "net_amount": body.net_amount,
        "vat_amount": body.vat_amount,
        "currency_code": body.currency_code,
        "status": body.status,
    }


# ── Reads that need more than one table ──────────────────────────────────────


async def load_deduction_context(
    session: AsyncSession,
    *,
    regime_id: uuid.UUID,
    party_status_id: uuid.UUID | None,
) -> tuple[WithholdingRegime | None, PartyTaxStatus | None]:
    """The scheme and the party standing a deduction is judged against."""
    regime = await repository.get_regime(session, regime_id)
    party_status = None
    if party_status_id is not None:
        party_status = await repository.get_party_status(session, party_status_id)
    return regime, party_status


def expiry_view(status: PartyTaxStatus, as_of: date) -> tuple[bool, int | None]:
    """``(is_expired, days_to_expiry)`` for one standing on one date.

    Computed on read and never stored. A stored expiry flag is only as fresh as
    the last job that wrote it, and an expiry nobody noticed is the entire
    failure this module is here to prevent.

    A standing is expired when the calendar says so or when the record does, and
    the two are separate evidence pointing the same way. The calendar overrides
    a record still reading "active", because nobody goes back to edit a row on
    the day it lapses. The record overrides an open window, because a standing
    marked expired with no end date has no calendar to consult at all, and
    answering "not expired" there contradicts ``verification_is_current``, which
    already refuses that row. There is no countdown in that case, since the date
    it would count to is the date that is missing. Revocation is deliberately
    not folded in here: a revoked standing is refused all the same, but calling
    it expired would put the wrong word on the screen for it.
    """
    if status.status == "expired":
        return True, None
    if status.valid_to is None:
        return False, None
    delta = (status.valid_to - as_of).days
    return delta < 0, delta


__all__ = [
    "ZERO",
    "BandDecision",
    "DeductionFigures",
    "apply_deduction_body",
    "apply_determination_body",
    "apply_party_status_body",
    "apply_regime_body",
    "bands_of",
    "compute_deduction",
    "compute_tax_withheld",
    "compute_taxable_base",
    "deduction_payload",
    "determination_payload",
    "expiry_view",
    "find_band",
    "load_deduction_context",
    "quantise",
    "resolve_band",
    "seed_regimes",
    "to_decimal",
    "verification_is_current",
]
