// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * The two pure decisions the payment clock screen makes for itself.
 *
 * Everything else on the panel is the server's answer rendered as it came.
 * These two are ours, and both have a wrong version that looks right: an
 * overdue test that ignores status paints a red badge on every settled
 * payment, and a severity mapper without a fallback renders no badge at all
 * for a severity the validation engine adds later.
 */

import { describe, it, expect } from 'vitest';

import { isOverdue, severityVariant } from './clockStatus';
import type { PaymentApplication } from './api';

const TODAY = '2026-08-08';

function application(over: Partial<PaymentApplication> = {}): PaymentApplication {
  return {
    id: 'a1',
    project_id: 'p1',
    regime_id: 'r1',
    source_type: 'manual',
    source_id: null,
    reference: 'PA-01',
    application_date: '2026-06-01',
    period_start: null,
    period_end: null,
    applied_amount: '1000.00',
    currency: 'GBP',
    due_date: '2026-06-18',
    payment_notice_deadline: '2026-06-06',
    pay_less_deadline: '2026-06-16',
    final_date: '2026-07-01',
    dates_overridden: false,
    status: 'open',
    paid_at: null,
    paid_amount: null,
    notes: '',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    regime_code: 'uk_hgcra',
    jurisdiction: 'United Kingdom',
    ...over,
  };
}

describe('isOverdue', () => {
  it('flags an open application whose final date has passed', () => {
    expect(isOverdue(application(), TODAY)).toBe(true);
  });

  it('does not flag a paid application whose final date has passed', () => {
    // The negative control that matters. Without the status half of the test
    // every settled payment in the register carries a red overdue badge.
    expect(isOverdue(application({ status: 'paid' }), TODAY)).toBe(false);
    expect(isOverdue(application({ status: 'closed' }), TODAY)).toBe(false);
  });

  it('does not flag an application with no final date yet', () => {
    expect(isOverdue(application({ final_date: null }), TODAY)).toBe(false);
  });

  it('does not flag one whose final date is still ahead', () => {
    expect(isOverdue(application({ final_date: '2026-09-01' }), TODAY)).toBe(false);
  });

  it('does not flag one falling due today', () => {
    // Due today is not late. The statute gives the payer the whole day.
    expect(isOverdue(application({ final_date: TODAY }), TODAY)).toBe(false);
  });

  it('compares dates as strings across a month and year boundary', () => {
    // Guards the lexicographic comparison: '2026-09-01' < '2026-10-01' and
    // '2026-12-31' < '2027-01-01' both have to hold without parsing.
    expect(isOverdue(application({ final_date: '2026-09-01' }), '2026-10-01')).toBe(true);
    expect(isOverdue(application({ final_date: '2026-12-31' }), '2027-01-01')).toBe(true);
  });
});

describe('severityVariant', () => {
  it('maps the severities the rules emit today', () => {
    expect(severityVariant('critical')).toBe('error');
    expect(severityVariant('error')).toBe('error');
    expect(severityVariant('warning')).toBe('warning');
  });

  it('falls back to neutral for a severity it has never seen', () => {
    // A validation rule may add a severity without this file changing. It has
    // to render as something; a mapper returning undefined draws no badge and
    // nothing anywhere reports the gap.
    expect(severityVariant('info')).toBe('neutral');
    expect(severityVariant('')).toBe('neutral');
    expect(severityVariant('whatever-comes-next')).toBe('neutral');
  });
});
