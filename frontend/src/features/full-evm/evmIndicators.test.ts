// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * The readings this screen makes for itself, and the wrong version of each.
 *
 * Every case below has a plausible implementation that gets it backwards: a
 * parser that treats `null` and `"0"` alike reports an unstarted project as the
 * worst-performing one on the books; a variance bucketer that tests for
 * truthiness files "exactly on plan" under "no data"; a share of the budget
 * that divides without checking reports Infinity as a percentage; and a spread
 * across EAC formulas that counts one computable variant as agreement claims a
 * consensus nobody took.
 */

import { describe, it, expect } from 'vitest';

import {
  INDEX_EPSILON,
  baselineStatusTone,
  canApprove,
  eacMethodWasHonoured,
  eacVariantSpread,
  fractionToPercent,
  indexBand,
  indexTone,
  latestMeasure,
  parseFigure,
  periodIncrements,
  shareOfBudget,
  tcpiOutlook,
  tcpiTone,
  unmeasuredPoints,
  validationTone,
  varianceTone,
} from './evmIndicators';

describe('parseFigure', () => {
  it('reads a plain-decimal string', () => {
    expect(parseFigure('1240.50')).toBe(1240.5);
    expect(parseFigure('-3200')).toBe(-3200);
  });

  it('returns zero for "0" and null for a missing figure', () => {
    // The distinction the whole module rests on. Zero is an index that was
    // computed and came out at nothing; null is an index with no denominator.
    expect(parseFigure('0')).toBe(0);
    expect(parseFigure('0.000000')).toBe(0);
    expect(parseFigure(null)).toBeNull();
    expect(parseFigure(undefined)).toBeNull();
  });

  it('treats a blank or unparseable amount as missing rather than zero', () => {
    expect(parseFigure('')).toBeNull();
    expect(parseFigure('   ')).toBeNull();
    expect(parseFigure('banana')).toBeNull();
  });

  it('refuses the legacy infinity sentinel instead of rendering it as a number', () => {
    // The forecast table carries a literal "inf" in its tcpi column when the
    // budget is exactly consumed with work outstanding. It is unbounded, not a
    // figure, and must not reach a chart axis.
    expect(parseFigure('inf')).toBeNull();
    expect(parseFigure('Infinity')).toBeNull();
    expect(parseFigure('-Infinity')).toBeNull();
    expect(parseFigure('NaN')).toBeNull();
  });
});

describe('indexBand', () => {
  it('calls an index of exactly 1.0 on track', () => {
    expect(indexBand('1.0')).toBe('on_track');
    expect(indexBand('1')).toBe('on_track');
    expect(indexBand('1.000000')).toBe('on_track');
  });

  it('keeps a rounding wobble inside the on-track band', () => {
    expect(indexBand('0.998')).toBe('on_track');
    expect(indexBand('1.002')).toBe('on_track');
  });

  it('bands at the epsilon boundary, inclusively', () => {
    expect(indexBand(String(1 + INDEX_EPSILON))).toBe('ahead');
    expect(indexBand(String(1 - INDEX_EPSILON))).toBe('behind');
  });

  it('reads above 1.0 as ahead and below as behind', () => {
    expect(indexBand('1.14')).toBe('ahead');
    expect(indexBand('0.82')).toBe('behind');
  });

  it('separates an index of zero from an undefined one', () => {
    // CPI 0 means money was spent and nothing earned: the worst reading there
    // is. CPI null means nothing has been spent, which is not a reading at all.
    expect(indexBand('0')).toBe('behind');
    expect(indexBand(null)).toBe('undefined');
  });

  it('paints an undefined index neutrally rather than as a warning', () => {
    expect(indexTone(indexBand(null))).toBe('neutral');
    expect(indexTone(indexBand('0'))).toBe('warning');
    expect(indexTone(indexBand('1'))).toBe('blue');
    expect(indexTone(indexBand('1.2'))).toBe('success');
  });
});

describe('varianceTone', () => {
  it('reads a negative variance as unfavourable', () => {
    expect(varianceTone('-12400.00')).toBe('warning');
    expect(varianceTone('-0.01')).toBe('warning');
  });

  it('reads a positive variance as favourable', () => {
    expect(varianceTone('8300.00')).toBe('success');
  });

  it('treats a variance of exactly zero as on plan, not as missing', () => {
    // SV and CV are never null on the wire, so a zero here is always a real
    // measurement of a project sitting exactly on its plan.
    expect(varianceTone('0')).toBe('neutral');
    expect(varianceTone('0.0000')).toBe('neutral');
    expect(varianceTone('-0')).toBe('neutral');
  });

  it('stays neutral for a figure it cannot read', () => {
    expect(varianceTone(null)).toBe('neutral');
    expect(varianceTone('')).toBe('neutral');
  });
});

describe('tcpiOutlook', () => {
  it('is undefined when the budget is exactly consumed', () => {
    // (BAC-EV)/(BAC-AC) has no value once BAC equals AC. The register stores
    // NULL for it and the screen must not read that as an easy target.
    expect(tcpiOutlook(null, '0.92')).toBe('undefined');
  });

  it('has no benchmark while nothing has been spent', () => {
    // TCPI exists, CPI does not. Calling that comfortable would vouch for a
    // project on no evidence at all.
    expect(tcpiOutlook('1.00', null)).toBe('no_benchmark');
    expect(tcpiTone(tcpiOutlook('1.00', null))).toBe('neutral');
  });

  it('flags remaining work that must beat what the project has managed', () => {
    expect(tcpiOutlook('1.18', '0.91')).toBe('above_achieved');
    expect(tcpiTone(tcpiOutlook('1.18', '0.91'))).toBe('warning');
  });

  it('accepts remaining work at or under the achieved efficiency', () => {
    expect(tcpiOutlook('0.88', '0.91')).toBe('at_or_below_achieved');
    expect(tcpiOutlook('1.0', '1.0')).toBe('at_or_below_achieved');
    expect(tcpiTone(tcpiOutlook('0.88', '0.91'))).toBe('success');
  });
});

describe('fractionToPercent', () => {
  it('scales the stored fraction', () => {
    // percent_complete is EV/BAC as a fraction despite its name.
    expect(fractionToPercent('0.25')).toBe(25);
    expect(fractionToPercent('1')).toBe(100);
  });

  it('keeps zero as zero and missing as missing', () => {
    expect(fractionToPercent('0')).toBe(0);
    expect(fractionToPercent(null)).toBeNull();
  });
});

describe('shareOfBudget', () => {
  it('returns null against a zero baseline instead of dividing', () => {
    // A baseline with BAC 0 is ordinary while a plan is being drafted. The
    // division would yield Infinity, which renders as a confident nonsense.
    expect(shareOfBudget('4000', '0')).toBeNull();
    expect(shareOfBudget('0', '0')).toBeNull();
    expect(shareOfBudget('4000', '0.0000')).toBeNull();
  });

  it('returns zero for a zero amount against a real budget', () => {
    expect(shareOfBudget('0', '100000')).toBe(0);
  });

  it('computes an ordinary share', () => {
    expect(shareOfBudget('25000', '100000')).toBe(25);
  });

  it('returns null when either side is missing or unreadable', () => {
    expect(shareOfBudget(null, '100000')).toBeNull();
    expect(shareOfBudget('25000', null)).toBeNull();
    expect(shareOfBudget('25000', 'banana')).toBeNull();
  });
});

describe('periodIncrements', () => {
  it('returns nothing for a baseline with no periods', () => {
    // A baseline can be created without a curve; that is the natural authoring
    // order, not an edge case.
    expect(periodIncrements([])).toEqual([]);
  });

  it('gives a single period its whole cumulative value', () => {
    expect(periodIncrements([{ period_end: '2026-03-31', planned_value: '90000' }])).toEqual([90000]);
  });

  it('differences a cumulative curve', () => {
    expect(
      periodIncrements([
        { period_end: '2026-01-31', planned_value: '100000' },
        { period_end: '2026-02-28', planned_value: '250000' },
        { period_end: '2026-03-31', planned_value: '400000' },
      ]),
    ).toEqual([100000, 150000, 150000]);
  });

  it('keeps a flat period at zero rather than reporting it as missing', () => {
    // A period that plans no new work is a real plan, e.g. a shutdown.
    expect(
      periodIncrements([
        { period_end: '2026-01-31', planned_value: '100000' },
        { period_end: '2026-02-28', planned_value: '100000' },
      ]),
    ).toEqual([100000, 0]);
  });

  it('surfaces a curve that goes backwards instead of clamping it', () => {
    // A falling cumulative total is a data fault the rule set reports. Hiding
    // it here would make the screen disagree with the finding beside it.
    expect(
      periodIncrements([
        { period_end: '2026-01-31', planned_value: '250000' },
        { period_end: '2026-02-28', planned_value: '180000' },
      ]),
    ).toEqual([250000, -70000]);
  });

  it('propagates an unreadable value to the increment that depends on it', () => {
    const increments = periodIncrements([
      { period_end: '2026-01-31', planned_value: '100000' },
      { period_end: '2026-02-28', planned_value: 'banana' },
      { period_end: '2026-03-31', planned_value: '400000' },
    ]);
    expect(increments).toEqual([100000, null, null]);
  });
});

describe('unmeasuredPoints', () => {
  it('counts a period nobody measured', () => {
    expect(
      unmeasuredPoints([
        { earned_value: '100000' },
        { earned_value: null },
        { earned_value: null },
      ]),
    ).toBe(2);
  });

  it('does not count a period measured at zero earned value', () => {
    // Nothing earned in a period that was reported is a measurement, and a
    // different fact from a period nobody reported.
    expect(unmeasuredPoints([{ earned_value: '0' }, { earned_value: '0.0000' }])).toBe(0);
  });

  it('is zero for a curve with no points at all', () => {
    expect(unmeasuredPoints([])).toBe(0);
  });
});

describe('latestMeasure', () => {
  it('returns null for an empty register', () => {
    expect(latestMeasure([])).toBeNull();
  });

  it('picks the newest data date regardless of list order', () => {
    const measures = [
      { data_date: '2026-02-28' },
      { data_date: '2026-04-30' },
      { data_date: '2026-01-31' },
    ];
    expect(latestMeasure(measures)).toEqual({ data_date: '2026-04-30' });
  });

  it('keeps the first of two rows on the same date', () => {
    const first = { data_date: '2026-04-30', id: 'a' };
    const second = { data_date: '2026-04-30', id: 'b' };
    expect(latestMeasure([first, second])).toBe(first);
  });
});

describe('eacVariantSpread', () => {
  it('measures how far the formulas disagree', () => {
    const spread = eacVariantSpread({
      remaining: '1200000',
      cpi: '1310000',
      combined: '1425000',
    });
    expect(spread).toEqual({ low: 1200000, high: 1425000, spread: 225000 });
  });

  it('reports agreement as a spread of zero', () => {
    expect(eacVariantSpread({ remaining: '1200000', cpi: '1200000' })?.spread).toBe(0);
  });

  it('returns null when only one formula could run', () => {
    // On a project that has earned nothing, only `remaining` is computable.
    // A spread of zero there would claim a consensus nobody took.
    expect(eacVariantSpread({ remaining: '1200000', cpi: null, combined: null })).toBeNull();
  });

  it('returns null for an empty or absent variant map', () => {
    expect(eacVariantSpread({})).toBeNull();
    expect(eacVariantSpread(undefined)).toBeNull();
  });
});

describe('eacMethodWasHonoured', () => {
  it('is true when the requested formula ran', () => {
    expect(eacMethodWasHonoured({ eac_method: 'cpi', eac_method_effective: 'cpi' })).toBe(true);
  });

  it('is false when a zero divisor forced a simpler formula', () => {
    expect(eacMethodWasHonoured({ eac_method: 'cpi', eac_method_effective: 'remaining' })).toBe(false);
  });

  it('never calls auto a substitution', () => {
    // `auto` asks for whatever is richest, so whatever ran is what it wanted.
    expect(eacMethodWasHonoured({ eac_method: 'auto', eac_method_effective: 'remaining' })).toBe(true);
  });
});

describe('status tones', () => {
  it('paints a baseline by its lifecycle state', () => {
    expect(baselineStatusTone('approved')).toBe('success');
    expect(baselineStatusTone('draft')).toBe('blue');
    expect(baselineStatusTone('superseded')).toBe('neutral');
  });

  it('does not guess at a state a later version writes', () => {
    expect(baselineStatusTone('rebaselined')).toBe('neutral');
  });

  it('keeps an unchecked row out of both the pass and the fail colour', () => {
    // `pending` means never validated, `unsupported` means the rule set
    // resolved to no rules. Neither is a pass and neither is a failure.
    expect(validationTone('pending')).toBe('neutral');
    expect(validationTone('unsupported')).toBe('neutral');
    expect(validationTone('passed')).toBe('success');
    expect(validationTone('warnings')).toBe('warning');
    expect(validationTone('errors')).toBe('error');
  });
});

describe('canApprove', () => {
  it('refuses a baseline that already is the measurement base', () => {
    expect(canApprove({ status: 'approved', validation_status: 'passed' })).toBe(false);
  });

  it('refuses a baseline carrying blocking errors', () => {
    expect(canApprove({ status: 'draft', validation_status: 'errors' })).toBe(false);
  });

  it('allows a draft whose findings are only warnings', () => {
    expect(canApprove({ status: 'draft', validation_status: 'warnings' })).toBe(true);
  });

  it('allows a superseded baseline to be approved again', () => {
    // Re-approving an earlier baseline is how a re-baseline is undone.
    expect(canApprove({ status: 'superseded', validation_status: 'passed' })).toBe(true);
  });
});
