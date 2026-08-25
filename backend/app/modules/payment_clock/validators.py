# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Payment clock validation rules.

The whole module exists for one sentence, and it is this one: **if no valid
payment notice is served in time, the notified sum is the sum the contractor
applied for**. Under the UK Act, the Irish Act, and the New South Wales,
Queensland and New Zealand security-of-payment Acts, that consequence follows
from silence alone. It is not an opinion about the work, it is not open to a
counter-argument about defects, and it decides adjudications. So it is a rule
here rather than a paragraph in a docstring, and it names the amount.

The consequence of silence is not the same everywhere, so it is read off the
regime rather than assumed:

* ``applied_sum_becomes_notified_sum`` - UK, Ireland, New South Wales,
  Queensland, New Zealand. The applied sum becomes the sum payable.
* ``evidential_bar`` - Singapore. The respondent who filed no payment response
  in time cannot put that material before the adjudicator.
* ``deemed_dispute`` - Malaysia. Silence is a denial of the whole claim, and
  the claim goes to adjudication.
* ``none`` - the EU Late Payment Directive and the German VOB/B and BGB
  regimes, which set a payment period and interest but no notice sequence.

Rules, all registered under the ``payment_clock`` rule set:

* ``payment_clock.notified_sum``             - ERROR.   The window closed with
  no payment notice. This is the one above.
* ``payment_clock.notice_in_time``           - ERROR.   A notice served after
  its statutory deadline, naming the deadline and how late it was.
* ``payment_clock.pay_less_basis``           - ERROR.   A pay-less notice has
  to state the sum considered due and how it was calculated.
* ``payment_clock.final_date_after_due_date``- ERROR.   The final date for
  payment must fall after the due date.
* ``payment_clock.statutory_interest``       - WARNING. Past the final date and
  unpaid, interest runs, at a rate the finding names.
* ``payment_clock.notice_currency``          - WARNING. A notice in a currency
  other than the application's.

Every rule reads a plain dict built by
:func:`app.modules.payment_clock.service.clock_snapshot`, so the rules can be
run against a fixture with no database at all.
"""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal
from typing import Any

from app.core.validation.engine import (
    RuleCategory,
    RuleResult,
    Severity,
    ValidationContext,
    ValidationRule,
    rule_registry,
    validation_engine,
)
from app.modules.payment_clock.clock import (
    ClockSchedule,
    days_between,
    deadline_for_notice,
    format_money,
    interest_description,
    parse_date,
    parse_money,
)

logger = logging.getLogger(__name__)

PAYMENT_CLOCK_RULE_SET = "payment_clock"

# What silence means, per regime, as the sentence the finding ends with. The
# key is ``PaymentRegime.no_notice_effect``.
_SILENCE_CONSEQUENCE: dict[str, str] = {
    "applied_sum_becomes_notified_sum": (
        "the sum applied for becomes the notified sum and is payable in full by the final date for payment"
    ),
    "evidential_bar": (
        "the respondent may not rely at adjudication on any reason for withholding that was not stated in time"
    ),
    "deemed_dispute": "the claim is treated as disputed in its entirety and may be referred to adjudication",
    "none": "no statutory consequence follows from the absence of a notice under this regime",
}


# ── Snapshot readers ─────────────────────────────────────────────────────────


def _snapshot(context: ValidationContext) -> dict[str, Any]:
    data = context.data
    return data if isinstance(data, dict) else {}


def _section(context: ValidationContext, key: str) -> dict[str, Any]:
    section = _snapshot(context).get(key)
    return section if isinstance(section, dict) else {}


def _notices(context: ValidationContext) -> list[dict[str, Any]]:
    notices = _snapshot(context).get("notices")
    if not isinstance(notices, list):
        return []
    return [notice for notice in notices if isinstance(notice, dict)]


def _schedule(context: ValidationContext) -> ClockSchedule:
    """The four stored dates as a schedule the clock helpers understand."""
    application = _section(context, "application")
    return ClockSchedule(
        due_date=parse_date(application.get("due_date")),
        payment_notice_deadline=parse_date(application.get("payment_notice_deadline")),
        pay_less_deadline=parse_date(application.get("pay_less_deadline")),
        final_date=parse_date(application.get("final_date")),
    )


def _as_of(context: ValidationContext) -> date:
    """The date the clock is being read on.

    Supplied by the caller so a report can be run as at a past date and so the
    tests are not hostages to the machine clock.
    """
    return parse_date(_snapshot(context).get("as_of")) or date.today()


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _statute(context: ValidationContext) -> str:
    return _text(_section(context, "regime").get("statute")) or "the applicable statute"


def _reference(context: ValidationContext) -> str:
    application = _section(context, "application")
    return _text(application.get("reference")) or _text(application.get("id")) or "this application"


def _paid_in_full(application: dict[str, Any]) -> bool:
    """Whether the row says the money actually arrived.

    A status of ``paid`` with no payment date is a workflow tick somebody
    clicked, not evidence of payment, so both are required. Where a part
    payment is recorded, the shortfall is still overdue.
    """
    if _text(application.get("status")) in {"paid", "closed"} and parse_date(application.get("paid_at")):
        paid = parse_money(application.get("paid_amount"))
        applied = parse_money(application.get("applied_amount"))
        if paid is None or applied is None:
            return True
        return paid >= applied
    return False


def _result(
    rule: ValidationRule,
    passed: bool,
    message: str,
    *,
    element_ref: str | None = None,
    suggestion: str | None = None,
    details: dict[str, Any] | None = None,
) -> RuleResult:
    """Build a RuleResult carrying the rule's own id / name / severity / category."""
    return RuleResult(
        rule_id=rule.rule_id,
        rule_name=rule.name,
        severity=rule.severity,
        category=rule.category,
        passed=passed,
        message=message,
        element_ref=element_ref,
        suggestion=suggestion,
        details=details or {},
    )


# ── The rule the module exists for ───────────────────────────────────────────


class PaymentClockNotifiedSum(ValidationRule):
    """No payment notice, window closed: the applied sum is the notified sum."""

    rule_id = "payment_clock.notified_sum"
    name = "Notified Sum Follows From A Missing Payment Notice"
    standard = "payment_clock"
    severity = Severity.ERROR
    category = RuleCategory.COMPLIANCE
    description = (
        "Where the payment notice window closes with no notice served, the statute fixes the notified sum "
        "at the sum applied for."
    )

    async def validate(self, context: ValidationContext) -> list[RuleResult]:
        application = _section(context, "application")
        regime = _section(context, "regime")
        schedule = _schedule(context)
        deadline = schedule.payment_notice_deadline
        if deadline is None:
            # The regime sets no payment notice deadline, so there is no
            # silence to have a consequence. Nothing to say either way.
            return []
        as_of = _as_of(context)
        if as_of <= deadline:
            return [
                _result(
                    self,
                    True,
                    "OK",
                    details={"deadline": deadline.isoformat(), "as_of": as_of.isoformat(), "window": "open"},
                )
            ]

        served = [
            notice
            for notice in _notices(context)
            if _text(notice.get("notice_type")) == "payment_notice"
            and (parse_date(notice.get("issued_at")) or date.max) <= deadline
        ]
        if served:
            return [_result(self, True, "OK", details={"deadline": deadline.isoformat(), "notices": len(served)})]

        effect = _text(regime.get("no_notice_effect")) or "applied_sum_becomes_notified_sum"
        consequence = _SILENCE_CONSEQUENCE.get(effect, _SILENCE_CONSEQUENCE["applied_sum_becomes_notified_sum"])
        if effect == "none":
            return [_result(self, True, "OK", details={"no_notice_effect": effect})]

        applied = parse_money(application.get("applied_amount"))
        currency = _text(application.get("currency"))
        amount_text = format_money(applied, currency)
        pay_less = [notice for notice in _notices(context) if _text(notice.get("notice_type")) == "pay_less_notice"]
        message = (
            f"No payment notice was served by {deadline.isoformat()} under {_statute(context)}, "
            f"so {consequence}. The sum applied for is {amount_text}."
        )
        if effect == "applied_sum_becomes_notified_sum" and pay_less:
            message += (
                f" {len(pay_less)} pay-less notice(s) are recorded; a pay-less notice served in time "
                "reduces the sum to be paid but does not displace the notified sum."
            )
        return [
            _result(
                self,
                False,
                message,
                element_ref=_reference(context),
                suggestion=(
                    "Check whether a notice was served and never recorded. If none was, treat "
                    f"{amount_text} as payable and take advice before the final date for payment."
                ),
                details={
                    "deadline": deadline.isoformat(),
                    "as_of": as_of.isoformat(),
                    "no_notice_effect": effect,
                    # A string, never a float: this figure is the one that gets
                    # argued about.
                    "applied_amount": format(applied, "f") if applied is not None else None,
                    "currency": currency,
                    "pay_less_notices": len(pay_less),
                },
            )
        ]


# ── Notices ──────────────────────────────────────────────────────────────────


class PaymentClockNoticeInTime(ValidationRule):
    """A notice served after its statutory deadline is not a valid notice."""

    rule_id = "payment_clock.notice_in_time"
    name = "Notice Served Within Its Statutory Deadline"
    standard = "payment_clock"
    severity = Severity.ERROR
    category = RuleCategory.COMPLIANCE
    description = "A payment or pay-less notice served after its deadline has no statutory effect."

    async def validate(self, context: ValidationContext) -> list[RuleResult]:
        notices = _notices(context)
        if not notices:
            return []
        schedule = _schedule(context)
        results: list[RuleResult] = []
        for index, notice in enumerate(notices):
            notice_type = _text(notice.get("notice_type"))
            issued_at = parse_date(notice.get("issued_at"))
            deadline, deadline_name = deadline_for_notice(notice_type, schedule)
            if issued_at is None or deadline is None:
                continue
            reference = _text(notice.get("reference")) or f"notice #{index + 1}"
            if issued_at <= deadline:
                results.append(
                    _result(
                        self,
                        True,
                        "OK",
                        element_ref=reference,
                        details={"notice_type": notice_type, "deadline": deadline.isoformat()},
                    )
                )
                continue
            late_by = days_between(deadline, issued_at)
            results.append(
                _result(
                    self,
                    False,
                    (
                        f"This {notice_type.replace('_', ' ')} was served on {issued_at.isoformat()}, "
                        f"{late_by} calendar day(s) after {deadline_name} of {deadline.isoformat()}. "
                        f"Out of time under {_statute(context)}, it has no statutory effect."
                    ),
                    element_ref=reference,
                    suggestion=(
                        "Confirm the date of service against the delivery record. A notice served late "
                        "cannot be cured by reissuing it against the same application."
                    ),
                    details={
                        "notice_type": notice_type,
                        "issued_at": issued_at.isoformat(),
                        "deadline": deadline.isoformat(),
                        "days_late": late_by,
                    },
                )
            )
        return results


class PaymentClockPayLessBasis(ValidationRule):
    """A pay-less notice states the sum considered due and how it is calculated."""

    rule_id = "payment_clock.pay_less_basis"
    name = "Pay-Less Notice States Its Basis"
    standard = "payment_clock"
    severity = Severity.ERROR
    category = RuleCategory.COMPLETENESS
    description = (
        "A pay-less notice that does not specify the sum considered due and the basis of its calculation "
        "is invalid, and the sum it tried to withhold stays payable."
    )

    async def validate(self, context: ValidationContext) -> list[RuleResult]:
        results: list[RuleResult] = []
        for index, notice in enumerate(_notices(context)):
            if _text(notice.get("notice_type")) != "pay_less_notice":
                continue
            reference = _text(notice.get("reference")) or f"notice #{index + 1}"
            basis = _text(notice.get("basis_of_calculation"))
            amount = parse_money(notice.get("notified_amount"))
            missing = [
                label
                for label, ok in (
                    ("the sum considered due", amount is not None),
                    ("the basis on which it is calculated", bool(basis)),
                )
                if not ok
            ]
            if not missing:
                results.append(_result(self, True, "OK", element_ref=reference))
                continue
            results.append(
                _result(
                    self,
                    False,
                    (
                        f"This pay-less notice does not state {' or '.join(missing)}. "
                        f"Under {_statute(context)} that makes it invalid, and the sum it withholds "
                        "remains payable."
                    ),
                    element_ref=reference,
                    suggestion=(
                        "State the sum the payer considers due and set out how it was calculated, "
                        "line by line, before the pay-less deadline passes."
                    ),
                    details={"missing": missing, "reference": reference},
                )
            )
        return results


class PaymentClockNoticeCurrency(ValidationRule):
    """A notice in another currency is a fact worth surfacing, not a typo to fix."""

    rule_id = "payment_clock.notice_currency"
    name = "Notice Currency Matches The Application"
    standard = "payment_clock"
    severity = Severity.WARNING
    category = RuleCategory.CONSISTENCY
    description = "A notice stating a sum in a currency other than the application's cannot be compared to it."

    async def validate(self, context: ValidationContext) -> list[RuleResult]:
        application_currency = _text(_section(context, "application").get("currency")).upper()
        if not application_currency:
            return []
        results: list[RuleResult] = []
        for index, notice in enumerate(_notices(context)):
            currency = _text(notice.get("currency")).upper()
            if not currency or currency == application_currency:
                continue
            reference = _text(notice.get("reference")) or f"notice #{index + 1}"
            results.append(
                _result(
                    self,
                    False,
                    (
                        f"This notice states its sum in {currency} while the application is in "
                        f"{application_currency}. The two cannot be compared without a rate and a date "
                        "for it, so no arithmetic here treats them as one number."
                    ),
                    element_ref=reference,
                    suggestion="Reissue the notice in the currency of the application, or record the rate applied.",
                    details={"notice_currency": currency, "application_currency": application_currency},
                )
            )
        return results


# ── The dates themselves ─────────────────────────────────────────────────────


class PaymentClockFinalDateAfterDueDate(ValidationRule):
    """The final date for payment must fall after the due date."""

    rule_id = "payment_clock.final_date_after_due_date"
    name = "Final Date Falls After The Due Date"
    standard = "payment_clock"
    severity = Severity.ERROR
    category = RuleCategory.STRUCTURE
    description = (
        "The due date and the final date for payment are two different dates in a fixed order, and the "
        "period between them is what the notice deadlines are measured in."
    )

    async def validate(self, context: ValidationContext) -> list[RuleResult]:
        schedule = _schedule(context)
        due_date, final_date = schedule.due_date, schedule.final_date
        if due_date is None or final_date is None:
            return []
        if final_date > due_date:
            return [
                _result(
                    self,
                    True,
                    "OK",
                    details={"due_date": due_date.isoformat(), "final_date": final_date.isoformat()},
                )
            ]
        gap = days_between(due_date, final_date)
        return [
            _result(
                self,
                False,
                (
                    f"The final date for payment ({final_date.isoformat()}) does not fall after the due date "
                    f"({due_date.isoformat()}). With no period between them there is no window in which a "
                    "pay-less notice can be served, and the payer is in default the moment the sum falls due."
                ),
                element_ref=_reference(context),
                suggestion=("Recompute the dates from the regime, or correct the dates that were entered by hand."),
                details={
                    "due_date": due_date.isoformat(),
                    "final_date": final_date.isoformat(),
                    "days_between": gap,
                },
            )
        ]


class PaymentClockStatutoryInterest(ValidationRule):
    """Past the final date and unpaid, statutory interest runs."""

    rule_id = "payment_clock.statutory_interest"
    name = "Statutory Interest Accrues On A Late Payment"
    standard = "payment_clock"
    severity = Severity.WARNING
    category = RuleCategory.COMPLIANCE
    description = "An application unpaid after its final date for payment accrues interest at a statutory rate."

    async def validate(self, context: ValidationContext) -> list[RuleResult]:
        application = _section(context, "application")
        regime = _section(context, "regime")
        final_date = _schedule(context).final_date
        if final_date is None:
            return []
        as_of = _as_of(context)
        if as_of <= final_date or _paid_in_full(application):
            return [_result(self, True, "OK", details={"final_date": final_date.isoformat()})]

        overdue_days = days_between(final_date, as_of)
        applied = parse_money(application.get("applied_amount"))
        paid = parse_money(application.get("paid_amount")) or Decimal("0")
        outstanding = applied - paid if applied is not None else None
        currency = _text(application.get("currency"))
        rate = interest_description(regime)
        return [
            _result(
                self,
                False,
                (
                    f"{format_money(outstanding, currency)} has been outstanding for {overdue_days} day(s) "
                    f"past the final date for payment of {final_date.isoformat()}. Statutory interest runs "
                    f"at {rate}."
                ),
                element_ref=_reference(context),
                suggestion=(
                    "Record the payment if it has been made. If it has not, the interest is due as of right "
                    "and does not need to be claimed separately to start running."
                ),
                details={
                    "final_date": final_date.isoformat(),
                    "as_of": as_of.isoformat(),
                    "days_overdue": overdue_days,
                    "outstanding_amount": format(outstanding, "f") if outstanding is not None else None,
                    "currency": currency,
                    "interest_basis": _text(regime.get("interest_basis")),
                    "interest_rate": rate,
                },
            )
        ]


_PAYMENT_CLOCK_RULES: tuple[ValidationRule, ...] = (
    PaymentClockNotifiedSum(),
    PaymentClockNoticeInTime(),
    PaymentClockPayLessBasis(),
    PaymentClockNoticeCurrency(),
    PaymentClockFinalDateAfterDueDate(),
    PaymentClockStatutoryInterest(),
)

# The rule that produced a finding decides which event type is recorded for it.
# One entry per rule that can produce a breach worth keeping - a currency
# mismatch is worth showing and not worth filing.
RULE_EVENT_TYPES: dict[str, str] = {
    "payment_clock.notified_sum": "payment_notice_missed",
    "payment_clock.notice_in_time": "notice_out_of_time",
    "payment_clock.pay_less_basis": "pay_less_notice_without_basis",
    "payment_clock.final_date_after_due_date": "final_date_before_due_date",
    "payment_clock.statutory_interest": "payment_overdue",
}


def register_payment_clock_rules() -> None:
    """Register the module's validation rules with the core rule registry.

    Idempotent - the registry overwrites a rule by id, so a re-import or hot
    reload re-registers cleanly. Called from the module ``on_startup`` hook.
    """
    for rule in _PAYMENT_CLOCK_RULES:
        rule_registry.register(rule, [PAYMENT_CLOCK_RULE_SET])
    logger.debug("Registered %d payment clock validation rules", len(_PAYMENT_CLOCK_RULES))


async def evaluate_clock(snapshot: dict[str, Any], *, application_id: str = "") -> list[RuleResult]:
    """Run the payment clock rules over one snapshot; passing results dropped.

    Guarded the same way the other modules guard theirs: a broken rule must not
    stop somebody recording a notice, so a failure degrades to "no findings"
    and a log line rather than a 500. The findings are advisory to the screen
    and never block a save - a clock that is already in breach is exactly the
    one that has to be recorded.
    """
    try:
        report = await validation_engine.validate(
            data=snapshot,
            rule_sets=[PAYMENT_CLOCK_RULE_SET],
            target_type="payment_application",
            target_id=application_id,
        )
    except Exception:  # noqa: BLE001 - validation augments the save; never break it
        logger.warning("payment clock validation failed for application %s", application_id, exc_info=True)
        return []
    return [result for result in report.results if not result.passed and not result.is_engine_error]


def blocking_findings(results: list[RuleResult]) -> list[RuleResult]:
    """The subset a person has to answer for, rather than merely read."""
    return [result for result in results if result.severity == Severity.ERROR]


__all__ = [
    "PAYMENT_CLOCK_RULE_SET",
    "RULE_EVENT_TYPES",
    "blocking_findings",
    "evaluate_clock",
    "register_payment_clock_rules",
]
