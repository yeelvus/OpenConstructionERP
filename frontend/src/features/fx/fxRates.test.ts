// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Tests for the pure FX decisions.
 *
 * The module under test claims, in its own comments, to mirror specific
 * backend behaviour: `rate_of` refusing a non-positive quote, `cross_rate`
 * raising rather than short-circuiting a same-currency pair the set does not
 * quote, `FxRateFreshness` comparing with `age <= tolerance`. Those claims are
 * what is tested here, because a helper that mirrors the server wrongly is
 * worse than one that does not try: the screen then vouches for a conversion
 * the API answers with a 422.
 *
 * Zero appears throughout as a value in its own right. A rate of zero, a
 * tolerance of zero and a checked count of zero are three different real
 * settings, and every one of them is falsy in JavaScript.
 */

import { describe, expect, it } from 'vitest';

import {
  appliedDateGapDays,
  crossRate,
  daysBetween,
  formatDerivedRate,
  freshnessTone,
  inverseRate,
  normaliseCurrency,
  pairIsCovered,
  parseDecimalString,
  pinHolds,
  policyCurrencies,
  quotedRate,
  rateFreshness,
  sourceTone,
  uncoveredPolicyCurrencies,
  validationVerdict,
  verdictTone,
} from './fxRates';
import type { FxPolicy, FxValidation, RateSetSummary } from './api';

/** EUR base: one euro buys 1.09 dollars, 0.85 pounds, 160 yen. */
const RATES: Record<string, string> = {
  USD: '1.09',
  GBP: '0.85',
  JPY: '160',
  XXX: '0',
};

/**
 * A policy fixture the compiler actually checks.
 *
 * No trailing cast. The first version carried `rate_mode: 'latest'`, which is
 * not one of the two modes the type allows, and the cast let it compile: every
 * assertion still passed because an invalid mode is unequal to 'pinned' in the
 * same way 'live' is. A fixture that cannot arrive from the API tests nothing,
 * so the cast is gone and the value is real.
 */
function policy(over: Partial<FxPolicy> = {}): FxPolicy {
  return {
    project_id: 'p1',
    estimating_currency: 'EUR',
    procurement_currency: 'USD',
    reporting_currency: 'EUR',
    rate_mode: 'live',
    pinned_rate_set_id: null,
    pinned_rate_set: null,
    max_rate_age_days: 30,
    note: '',
    ...over,
  };
}

function report(over: Partial<FxValidation> = {}): FxValidation {
  return {
    project_id: 'p1',
    status: 'passed',
    score: 1,
    checked: 4,
    errors: [],
    warnings: [],
    ...over,
  };
}

describe('parseDecimalString', () => {
  it('reads a plain decimal', () => {
    expect(parseDecimalString('1.09')).toBe(1.09);
    expect(parseDecimalString('  2.5  ')).toBe(2.5);
  });

  it('reads zero as zero and not as absent', () => {
    // The distinction the module exists to keep: a quote of nothing is a
    // mistake somebody can correct, no quote at all is a currency the set
    // never covered, and only the first has anybody to fix it.
    expect(parseDecimalString('0')).toBe(0);
    expect(parseDecimalString('0.00')).toBe(0);
  });

  it('returns null for absent, empty and unparsable input', () => {
    expect(parseDecimalString(null)).toBeNull();
    expect(parseDecimalString(undefined)).toBeNull();
    expect(parseDecimalString('')).toBeNull();
    expect(parseDecimalString('   ')).toBeNull();
    expect(parseDecimalString('not a rate')).toBeNull();
    expect(parseDecimalString('Infinity')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts whole days forward and backward', () => {
    expect(daysBetween('2026-08-01', '2026-08-08')).toBe(7);
    expect(daysBetween('2026-08-08', '2026-08-01')).toBe(-7);
    expect(daysBetween('2026-08-08', '2026-08-08')).toBe(0);
  });

  it('crosses a month and a year end', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('counts the leap day', () => {
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('returns null rather than NaN for anything it cannot read', () => {
    expect(daysBetween(null, '2026-08-08')).toBeNull();
    expect(daysBetween('2026-08-08', undefined)).toBeNull();
    expect(daysBetween('yesterday', '2026-08-08')).toBeNull();
  });
});

describe('rateFreshness', () => {
  it('reports a pinned project as pinned whatever the dates say', () => {
    // The backend returns no freshness at all for a pinned project, because
    // holding old rates is what pinning is for. Warning about it would train
    // people to ignore the light.
    const state = rateFreshness({
      rateDate: '2019-01-01',
      onDate: '2026-08-08',
      maxAgeDays: 30,
      pinned: true,
    });
    expect(state).toBe('pinned');
  });

  it('accepts a set dated exactly on the tolerance', () => {
    expect(rateFreshness({ rateDate: '2026-07-09', onDate: '2026-08-08', maxAgeDays: 30 })).toBe('current');
  });

  it('rejects a set one day past the tolerance', () => {
    expect(rateFreshness({ rateDate: '2026-07-08', onDate: '2026-08-08', maxAgeDays: 30 })).toBe('stale');
  });

  it('treats a tolerance of zero as a real setting, not an unset one', () => {
    expect(rateFreshness({ rateDate: '2026-08-08', onDate: '2026-08-08', maxAgeDays: 0 })).toBe('current');
    expect(rateFreshness({ rateDate: '2026-08-07', onDate: '2026-08-08', maxAgeDays: 0 })).toBe('stale');
  });

  it('separates a set from the future from one it cannot date', () => {
    expect(rateFreshness({ rateDate: '2026-09-01', onDate: '2026-08-08', maxAgeDays: 30 })).toBe('future');
    expect(rateFreshness({ rateDate: null, onDate: '2026-08-08', maxAgeDays: 30 })).toBe('unknown');
  });
});

describe('freshnessTone and sourceTone', () => {
  it('warns only where somebody has something to fix', () => {
    expect(freshnessTone('stale')).toBe('warning');
    expect(freshnessTone('current')).toBe('success');
    expect(freshnessTone('pinned')).toBe('blue');
    expect(freshnessTone('future')).toBe('neutral');
    expect(freshnessTone('unknown')).toBe('neutral');
  });

  it('warns on the bundled snapshot, which was never fetched for this project', () => {
    expect(sourceTone('seed')).toBe('warning');
    expect(sourceTone('ecb')).toBe('success');
    expect(sourceTone('manual')).toBe('blue');
    expect(sourceTone('something-else')).toBe('neutral');
  });
});

describe('normaliseCurrency', () => {
  it('accepts a three-letter code in any case or padding', () => {
    expect(normaliseCurrency(' eur ')).toBe('EUR');
    expect(normaliseCurrency('Usd')).toBe('USD');
  });

  it('refuses anything that is not a three-letter code', () => {
    expect(normaliseCurrency('EURO')).toBe('');
    expect(normaliseCurrency('EU')).toBe('');
    expect(normaliseCurrency('E1R')).toBe('');
    expect(normaliseCurrency('')).toBe('');
    expect(normaliseCurrency(null)).toBe('');
    expect(normaliseCurrency(undefined)).toBe('');
  });
});

describe('quotedRate', () => {
  it('reads the base as exactly one, without it being quoted', () => {
    expect(quotedRate(RATES, 'EUR', 'EUR')).toBe(1);
    expect(quotedRate(RATES, 'EUR', ' eur ')).toBe(1);
  });

  it('reads a quoted currency', () => {
    expect(quotedRate(RATES, 'EUR', 'USD')).toBe(1.09);
    expect(quotedRate(RATES, 'EUR', 'JPY')).toBe(160);
  });

  it('refuses a currency the set never carried', () => {
    expect(quotedRate(RATES, 'EUR', 'CHF')).toBeNull();
  });

  it('refuses a quote of zero, matching rate_of refusing to divide by it', () => {
    expect(quotedRate(RATES, 'EUR', 'XXX')).toBeNull();
  });

  it('refuses a negative quote', () => {
    expect(quotedRate({ ...RATES, USD: '-1.09' }, 'EUR', 'USD')).toBeNull();
  });

  it('refuses a code that is not a code', () => {
    expect(quotedRate(RATES, 'EUR', '')).toBeNull();
    expect(quotedRate(RATES, 'EUR', 'DOLLARS')).toBeNull();
  });
});

describe('pairIsCovered', () => {
  it('covers a pair the set quotes both sides of', () => {
    expect(pairIsCovered(RATES, 'EUR', 'USD', 'GBP')).toBe(true);
    expect(pairIsCovered(RATES, 'EUR', 'EUR', 'USD')).toBe(true);
  });

  it('does not cover a pair with one side missing or quoted at zero', () => {
    expect(pairIsCovered(RATES, 'EUR', 'USD', 'CHF')).toBe(false);
    expect(pairIsCovered(RATES, 'EUR', 'XXX', 'USD')).toBe(false);
  });
});

describe('crossRate', () => {
  it('reads target over source, never the other way round', () => {
    // One dollar buys 0.85/1.09 pounds. Inverting this is the mistake that
    // looks plausible on screen and is wrong by the square of the rate.
    const rate = crossRate(RATES, 'EUR', 'USD', 'GBP');
    expect(rate).toBeCloseTo(0.85 / 1.09, 12);
  });

  it('prices from and to the base', () => {
    expect(crossRate(RATES, 'EUR', 'EUR', 'USD')).toBeCloseTo(1.09, 12);
    expect(crossRate(RATES, 'EUR', 'USD', 'EUR')).toBeCloseTo(1 / 1.09, 12);
  });

  it('answers exactly one for a same-currency pair the set quotes', () => {
    expect(crossRate(RATES, 'EUR', 'USD', 'USD')).toBe(1);
    expect(crossRate(RATES, 'EUR', 'EUR', 'EUR')).toBe(1);
  });

  it('refuses a same-currency pair the set does not quote', () => {
    // The tempting short-circuit is to answer 1 because the two sides match.
    // The service raises instead, so answering 1 here would promise a
    // conversion the API refuses.
    expect(crossRate(RATES, 'EUR', 'CHF', 'CHF')).toBeNull();
  });

  it('refuses a pair the set cannot price', () => {
    expect(crossRate(RATES, 'EUR', 'USD', 'CHF')).toBeNull();
    expect(crossRate(RATES, 'EUR', 'XXX', 'USD')).toBeNull();
  });
});

describe('inverseRate', () => {
  it('inverts a rate given as a string or a number', () => {
    expect(inverseRate('1.25')).toBe(0.8);
    expect(inverseRate(1.25)).toBe(0.8);
  });

  it('returns null for zero rather than Infinity', () => {
    // Infinity formats into a screen exactly as readily as a number does,
    // which is why this is guarded rather than left to the arithmetic.
    expect(inverseRate('0')).toBeNull();
    expect(inverseRate(0)).toBeNull();
  });

  it('returns null for anything it cannot read', () => {
    expect(inverseRate(null)).toBeNull();
    expect(inverseRate(undefined)).toBeNull();
    expect(inverseRate('')).toBeNull();
  });
});

describe('formatDerivedRate', () => {
  it('gives six decimals at or above one', () => {
    expect(formatDerivedRate(1.5)).toBe('1.5');
    expect(formatDerivedRate(1.234567891)).toBe('1.234568');
  });

  it('keeps a small rate significant instead of rounding it away', () => {
    // 0.0000363636 to six decimals is 0.000036, a one percent error on every
    // figure it touches, and a budget gets converted in both directions.
    const rendered = formatDerivedRate(0.0000363636);
    expect(rendered).not.toBe('0.000036');
    expect(Number(rendered)).toBeCloseTo(0.0000363636, 12);
  });

  it('renders zero as zero', () => {
    expect(formatDerivedRate(0)).toBe('0');
  });

  it('returns null for absent and non-finite input', () => {
    expect(formatDerivedRate(null)).toBeNull();
    expect(formatDerivedRate(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatDerivedRate(Number.NaN)).toBeNull();
  });
});

describe('appliedDateGapDays', () => {
  it('reports how far the applied rates predate the request', () => {
    expect(appliedDateGapDays('2026-01-01', '2026-08-08')).toBe(219);
  });

  it('reports nothing when no date was requested', () => {
    expect(appliedDateGapDays('2026-01-01', null)).toBeNull();
    expect(appliedDateGapDays('2026-01-01', undefined)).toBeNull();
  });

  it('reports zero when the rates carry the requested day', () => {
    expect(appliedDateGapDays('2026-08-08', '2026-08-08')).toBe(0);
  });
});

describe('policyCurrencies', () => {
  it('lists the three roles in order without repeating one', () => {
    expect(policyCurrencies(policy())).toEqual(['EUR', 'USD']);
  });

  it('keeps three distinct currencies in role order', () => {
    const three = policy({ reporting_currency: 'GBP' });
    expect(policyCurrencies(three)).toEqual(['EUR', 'USD', 'GBP']);
  });

  it('drops a role that holds something which is not a code', () => {
    const broken = policy({ procurement_currency: '' });
    expect(policyCurrencies(broken)).toEqual(['EUR']);
  });
});

describe('uncoveredPolicyCurrencies', () => {
  it('finds nothing when the set prices every role', () => {
    expect(uncoveredPolicyCurrencies(policy(), RATES, 'EUR')).toEqual([]);
  });

  it('names the role the set cannot price', () => {
    const swiss = policy({ reporting_currency: 'CHF' });
    expect(uncoveredPolicyCurrencies(swiss, RATES, 'EUR')).toEqual(['CHF']);
  });

  it('counts a role quoted at zero as uncovered', () => {
    const broken = policy({ reporting_currency: 'XXX' });
    expect(uncoveredPolicyCurrencies(broken, RATES, 'EUR')).toEqual(['XXX']);
  });
});

describe('validationVerdict', () => {
  it('does not call a project passed when nothing was examined', () => {
    // A project with no policy leaves every rule silent, and the report comes
    // back with no errors, no warnings and nothing checked. Painting that
    // green banks a pass from checks that never ran.
    expect(validationVerdict(report({ checked: 0 }))).toBe('unchecked');
    expect(validationVerdict(undefined)).toBe('unchecked');
  });

  it('reports errors ahead of warnings', () => {
    const finding = {
      rule_id: 'fx.policy_currency_coverage',
      rule_name: 'Policy currency coverage',
      severity: 'error',
      category: 'fx',
      message: 'Reporting currency is not quoted.',
      element_ref: null,
      suggestion: null,
    };
    expect(validationVerdict(report({ errors: [finding], warnings: [finding] }))).toBe('errors');
    expect(validationVerdict(report({ warnings: [finding] }))).toBe('warnings');
  });

  it('passes a project that was examined and found clean', () => {
    expect(validationVerdict(report())).toBe('passed');
  });
});

describe('verdictTone', () => {
  it('gives success only to a project that was actually examined', () => {
    expect(verdictTone('passed')).toBe('success');
    expect(verdictTone('unchecked')).toBe('neutral');
    expect(verdictTone('warnings')).toBe('warning');
    expect(verdictTone('errors')).toBe('error');
  });
});

describe('pinHolds', () => {
  // A whole RateSetSummary rather than the handful of fields this reads. A
  // partial cast compiled until the type gained a field, and then reported the
  // fixture as the mistake it was; keeping it complete means the compiler
  // checks the fixture against the real contract.
  const set: RateSetSummary = {
    id: 's1',
    base_currency: 'EUR',
    rate_date: '2026-08-01',
    source: 'ecb',
    source_ref: 'eurofxref-daily',
    fetched_at: '2026-08-01T14:15:00Z',
    is_locked: true,
    note: '',
    quote_count: 31,
    currencies: ['USD', 'GBP', 'CHF'],
  };

  it('holds only when the pinned set is locked', () => {
    const pinned = policy({ rate_mode: 'pinned', pinned_rate_set_id: 's1', pinned_rate_set: set });
    expect(pinHolds(pinned)).toBe(true);
  });

  it('does not hold when the pinned set can still be rewritten', () => {
    // An unlocked pin is not a pin: the next refresh moves the set underneath
    // it and the reproducible estimate changes with nobody touching it.
    const loose = policy({
      rate_mode: 'pinned',
      pinned_rate_set_id: 's1',
      pinned_rate_set: { ...set, is_locked: false },
    });
    expect(pinHolds(loose)).toBe(false);
  });

  it('does not hold when nothing is pinned at all', () => {
    expect(pinHolds(policy())).toBe(false);
    expect(pinHolds(policy({ rate_mode: 'pinned' }))).toBe(false);
    expect(pinHolds(undefined)).toBe(false);
  });
});
