# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""The bank account an e-invoice tells the buyer to pay into (BT-84, BT-86).

A mistyped IBAN is not caught downstream by anything the sender sees. The
receiver's validator checks the syntax of the document, not whether the account
exists, so the invoice passes, gets sent, and the payment fails weeks later. The
check-digit test is the only one available at the point of entry, and it catches
every single-character slip and almost every transposition.
"""

from __future__ import annotations

import pytest

from app.modules.einvoice.bank import (
    InvalidBankDetail,
    normalise_bic,
    normalise_iban,
)


class TestIban:
    def test_a_valid_account_is_accepted_and_stored_without_its_spacing(self):
        """Printed in groups of four, stored as the wire format."""
        assert normalise_iban("DE02 1203 0000 0000 2020 51") == "DE02120300000000202051"

    def test_lower_case_is_accepted_and_normalised(self):
        assert normalise_iban("de02120300000000202051") == "DE02120300000000202051"

    def test_a_single_mistyped_digit_is_refused(self):
        """The whole point: this is the error no later step can catch."""
        with pytest.raises(InvalidBankDetail):
            normalise_iban("DE02120300000000202052")

    def test_two_transposed_digits_are_refused(self):
        with pytest.raises(InvalidBankDetail):
            normalise_iban("DE02120300000000200251")

    def test_the_wrong_length_for_a_known_country_is_refused(self):
        """A German account is 22 characters, and a 21-character one is a typo."""
        with pytest.raises(InvalidBankDetail):
            normalise_iban("DE0212030000000020205")

    def test_an_untabulated_country_is_accepted_on_its_check_digits_alone(self):
        """A country we did not tabulate must not lock a firm out of the screen.

        The length table is a convenience, not the standard, and it will fall
        behind the registry. Anything structurally plausible whose check digits
        agree is accepted, because refusing it would be this product asserting
        that a country does not exist.
        """
        unknown = _synthetic_iban("QQ")  # QQ is unassigned, so it cannot be in the table
        assert normalise_iban(unknown) == unknown

    def test_something_that_is_not_an_account_at_all_is_refused(self):
        for junk in ["", "   ", "DE", "1234567890", "DE02-1203/0000", "DEAA120300000000202051"]:
            with pytest.raises(InvalidBankDetail):
                normalise_iban(junk)

    def test_a_country_code_that_is_not_two_letters_is_refused(self):
        with pytest.raises(InvalidBankDetail):
            normalise_iban("D102120300000000202051")

    @pytest.mark.parametrize(
        "iban",
        [
            "DE02120300000000202051",
            "FR1420041010050500013M02606",
            "GB29NWBK60161331926819",
            "NL91ABNA0417164300",
            "IT60X0542811101000000123456",
            "ES9121000418450200051332",
            "PL61109010140000071219812874",
            "NO9386011117947",
        ],
    )
    def test_published_examples_from_eight_countries_pass(self, iban: str):
        """A sender's own country is not the only one it invoices from."""
        assert normalise_iban(iban) == iban

    def test_an_empty_value_can_be_cleared_when_that_is_allowed(self):
        """Leaving the account blank is how a user removes it, not an error."""
        assert normalise_iban("", allow_empty=True) == ""
        assert normalise_iban("   ", allow_empty=True) == ""


def _synthetic_iban(country: str) -> str:
    """Build a checksum-correct IBAN for a country outside the length table."""
    body = "CBZZ12345678901234"
    rearranged = body + country + "00"
    numeric = "".join(str(int(c, 36)) for c in rearranged)
    check = 98 - (int(numeric) % 97)
    return f"{country}{check:02d}{body}"


class TestBic:
    def test_an_eight_character_code_is_accepted(self):
        assert normalise_bic("cobadeff") == "COBADEFF"

    def test_an_eleven_character_code_with_a_branch_is_accepted(self):
        assert normalise_bic("COBADEFFXXX") == "COBADEFFXXX"

    def test_a_nine_character_code_is_refused(self):
        """ISO 9362 has no nine or ten character form."""
        with pytest.raises(InvalidBankDetail):
            normalise_bic("COBADEFFX")

    def test_a_code_whose_country_is_not_letters_is_refused(self):
        with pytest.raises(InvalidBankDetail):
            normalise_bic("COBA12FF")

    def test_an_empty_value_can_be_cleared_when_that_is_allowed(self):
        assert normalise_bic("", allow_empty=True) == ""
