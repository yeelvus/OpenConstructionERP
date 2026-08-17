# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Payment account details carried by an e-invoice (BT-84 IBAN, BT-86 BIC).

Validated at the point of entry because nothing downstream can. A receiver's
validator checks that the document is well formed, not that the account on it
is real, so a mistyped IBAN produces a perfectly valid invoice that cannot be
paid. The ISO 7064 check digits catch every single-character error and all but a
vanishing fraction of transpositions, which is exactly the class of mistake made
while typing an account number into a form.

No dependency: this is the whole of the algorithm, and a package for it would
cost more than it saves on an instance running in two gigabytes.
"""

from __future__ import annotations

import re

__all__ = ["InvalidBankDetail", "normalise_bic", "normalise_iban"]


class InvalidBankDetail(ValueError):
    """A payment detail that cannot be what the user meant."""


# Length per country from the IBAN registry. Deliberately not exhaustive and
# deliberately not authoritative: a country missing here is checked on its check
# digits alone rather than rejected, so the table falling behind the registry
# costs accuracy and never costs a user their bank account.
_IBAN_LENGTHS: dict[str, int] = {
    "AD": 24, "AE": 23, "AL": 28, "AT": 20, "AZ": 28, "BA": 20, "BE": 16, "BG": 22,
    "BH": 22, "BR": 29, "BY": 28, "CH": 21, "CR": 22, "CY": 28, "CZ": 24, "DE": 22,
    "DK": 18, "DO": 28, "EE": 20, "EG": 29, "ES": 24, "FI": 18, "FO": 18, "FR": 27,
    "GB": 22, "GE": 22, "GI": 23, "GL": 18, "GR": 27, "GT": 28, "HR": 21, "HU": 28,
    "IE": 22, "IL": 23, "IQ": 23, "IS": 26, "IT": 27, "JO": 30, "KW": 30, "KZ": 20,
    "LB": 28, "LC": 32, "LI": 21, "LT": 20, "LU": 20, "LV": 21, "LY": 25, "MC": 27,
    "MD": 24, "ME": 22, "MK": 19, "MR": 27, "MT": 31, "MU": 30, "NL": 18, "NO": 15,
    "PK": 24, "PL": 28, "PS": 29, "PT": 25, "QA": 29, "RO": 24, "RS": 22, "SA": 24,
    "SC": 31, "SD": 18, "SE": 24, "SI": 19, "SK": 24, "SM": 27, "ST": 25, "SV": 28,
    "TL": 23, "TN": 24, "TR": 26, "UA": 29, "VA": 22, "VG": 24, "XK": 20,
}  # fmt: skip

_IBAN_SHAPE = re.compile(r"^[A-Z]{2}[0-9]{2}[A-Z0-9]{6,30}$")
# ISO 9362: four letters (institution), two letters (country), two alphanumerics
# (location), and optionally three more (branch). Eight or eleven, never between.
_BIC_SHAPE = re.compile(r"^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$")


def _mod_97(iban: str) -> int:
    """ISO 7064 MOD 97-10 over the rearranged account number."""
    rearranged = iban[4:] + iban[:4]
    # Each letter becomes its position in the alphabet plus nine, which is what
    # int(c, 36) already yields, and the digits pass through unchanged.
    return int("".join(str(int(c, 36)) for c in rearranged)) % 97


def normalise_iban(value: str | None, *, allow_empty: bool = False) -> str:
    """Return the IBAN in wire format, or raise :class:`InvalidBankDetail`.

    Args:
        value: What the user typed, in any spacing or case.
        allow_empty: Treat a blank value as a deliberate clearing rather than
            an error. The settings screen needs this to remove an account.

    Returns:
        The account with separators removed and letters upper-cased, which is
        the only form that belongs in the document (BT-84).

    Raises:
        InvalidBankDetail: The value is not an IBAN, is the wrong length for a
            country whose length is known, or fails its check digits.
    """
    raw = (value or "").strip()
    if not raw:
        if allow_empty:
            return ""
        raise InvalidBankDetail("an account number is required")

    compact = re.sub(r"[\s-]", "", raw).upper()
    if not _IBAN_SHAPE.match(compact):
        raise InvalidBankDetail(
            f"{raw!r} is not an IBAN: it must start with two letters and two check digits, "
            "then at least six more letters or digits"
        )

    expected = _IBAN_LENGTHS.get(compact[:2])
    if expected is not None and len(compact) != expected:
        raise InvalidBankDetail(f"an IBAN for {compact[:2]} is {expected} characters, and this one is {len(compact)}")

    if _mod_97(compact) != 1:
        raise InvalidBankDetail(
            f"the check digits of {raw!r} do not match the rest of the account number, "
            "so at least one character is wrong"
        )
    return compact


def normalise_bic(value: str | None, *, allow_empty: bool = False) -> str:
    """Return the BIC upper-cased, or raise :class:`InvalidBankDetail`.

    A BIC carries no check digit, so only its shape can be verified (BT-86).
    """
    raw = (value or "").strip()
    if not raw:
        if allow_empty:
            return ""
        raise InvalidBankDetail("a BIC is required")

    compact = re.sub(r"\s", "", raw).upper()
    if not _BIC_SHAPE.match(compact):
        raise InvalidBankDetail(
            f"{raw!r} is not a BIC: it must be eight or eleven characters, "
            "beginning with four letters for the institution and two for the country"
        )
    return compact
