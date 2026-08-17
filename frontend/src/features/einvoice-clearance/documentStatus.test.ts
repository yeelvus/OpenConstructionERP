// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * The decisions the clearance screen makes for itself.
 *
 * Each has a wrong version that passes a casual reading, and those are what
 * this file pins: an action set that trusts the server's own guard offers to
 * send an in-doubt document a second time, a status mapper with no fallback
 * draws nothing at all for a word the backend adds later, and a refusal reader
 * that goes through `getErrorMessage` loses the name of the field that blocked
 * the submission.
 */

import { describe, it, expect } from 'vitest';

import {
  availableActions,
  countryRegime,
  findingsFromError,
  isInDoubt,
  onlyWarnings,
  severityVariant,
  statusVariant,
} from './documentStatus';
import type { ClearanceFinding, CountryRegime } from './api';

function finding(over: Partial<ClearanceFinding> = {}): ClearanceFinding {
  return {
    key: 'einvoice_clearance.validation.country_fields_complete',
    rule_id: 'einvoice_clearance.country_fields_complete',
    severity: 'error',
    message: 'Uso CFDI is required for a Mexican invoice.',
    suggestion: '',
    details: {},
    ...over,
  };
}

/** The body FastAPI serves for a refused act, as `_refuse` builds it. */
function refusal(findings: unknown[], message = 'This document cannot be submitted yet.') {
  return { body: { detail: { message, findings } } };
}

describe('statusVariant', () => {
  it('maps the nine states the machine moves between', () => {
    expect(statusVariant('draft')).toBe('neutral');
    expect(statusVariant('validated')).toBe('blue');
    expect(statusVariant('queued')).toBe('blue');
    expect(statusVariant('submitted')).toBe('warning');
    expect(statusVariant('cleared')).toBe('success');
    expect(statusVariant('reported')).toBe('success');
    expect(statusVariant('delivered')).toBe('success');
    expect(statusVariant('rejected')).toBe('error');
    expect(statusVariant('cancelled')).toBe('neutral');
  });

  it('gives the three regime successes the same weight', () => {
    // They are one idea seen from three regimes, not three outcomes. A reader
    // scanning the register must not read `delivered` as weaker than `cleared`.
    expect(new Set(['cleared', 'reported', 'delivered'].map(statusVariant)).size).toBe(1);
  });

  it('falls back to neutral for a status it has never seen', () => {
    // /meta is the authority on this vocabulary, so the backend can add a
    // status without this file changing. A mapper returning undefined draws no
    // badge, and nothing anywhere reports the gap.
    expect(statusVariant('awaiting_countersignature')).toBe('neutral');
    expect(statusVariant('')).toBe('neutral');
  });
});

describe('availableActions', () => {
  it('offers the safe check and the send on anything not yet sent', () => {
    for (const status of ['draft', 'validated', 'queued']) {
      expect(availableActions(status)).toEqual(['validate', 'submit']);
    }
  });

  it('lets a rejected document be fixed and sent again', () => {
    // The authority said no and the same row is corrected and resubmitted;
    // that is what retry_count counts.
    expect(availableActions('rejected')).toEqual(['validate', 'submit']);
  });

  it('offers only the hand-recorded outcome on a document in doubt', () => {
    // The negative control that matters. The server refuses only the FINAL
    // statuses, so it would accept a second submission of a `submitted`
    // document - and that is two cleared invoices for one sale.
    expect(availableActions('submitted')).toEqual(['resolve']);
    expect(availableActions('submitted')).not.toContain('submit');
  });

  it('offers a withdrawal only where the country has one', () => {
    for (const status of ['cleared', 'reported', 'delivered']) {
      expect(availableActions(status, { cancellable: true })).toEqual(['cancel']);
      // A country whose only correction is a further document gets no button
      // rather than one that is guaranteed to be refused.
      expect(availableActions(status, { cancellable: false })).toEqual([]);
      expect(availableActions(status)).toEqual([]);
    }
  });

  it('offers nothing on a withdrawn document', () => {
    expect(availableActions('cancelled', { cancellable: true })).toEqual([]);
  });

  it('offers nothing on a status it has never seen', () => {
    // Guessing an action for an unknown state is worse than offering none:
    // every act here either sends something to a tax authority or writes a
    // fiscal record by hand.
    expect(availableActions('awaiting_countersignature', { cancellable: true })).toEqual([]);
    expect(availableActions('')).toEqual([]);
  });
});

describe('isInDoubt', () => {
  it('is true only for a document that was sent with no answer recorded', () => {
    expect(isInDoubt('submitted')).toBe(true);
    expect(isInDoubt('queued')).toBe(false);
    expect(isInDoubt('cleared')).toBe(false);
    expect(isInDoubt('')).toBe(false);
  });
});

describe('severityVariant', () => {
  it('maps the severities the rules emit today', () => {
    expect(severityVariant('error')).toBe('error');
    expect(severityVariant('critical')).toBe('error');
    expect(severityVariant('warning')).toBe('warning');
  });

  it('falls back to neutral for a severity it has never seen', () => {
    expect(severityVariant('info')).toBe('neutral');
    expect(severityVariant('')).toBe('neutral');
    expect(severityVariant('whatever-comes-next')).toBe('neutral');
  });
});

describe('findingsFromError', () => {
  it('reads the findings a refusal carried', () => {
    const err = refusal([
      finding(),
      finding({ rule_id: 'einvoice_clearance.profile_complete', severity: 'warning' }),
    ]);
    const found = findingsFromError(err);
    expect(found).toHaveLength(2);
    // The point of the whole helper: the field that blocked the submission is
    // named. `getErrorMessage` would have returned only the refusal's sentence.
    expect(found[0]?.message).toContain('Uso CFDI');
    expect(found[0]?.rule_id).toBe('einvoice_clearance.country_fields_complete');
    expect(found[1]?.severity).toBe('warning');
  });

  it('keeps the details a rule attached', () => {
    const err = refusal([finding({ details: { field: 'uso_cfdi' }, suggestion: 'Add it.' })]);
    expect(findingsFromError(err)[0]?.details).toEqual({ field: 'uso_cfdi' });
    expect(findingsFromError(err)[0]?.suggestion).toBe('Add it.');
  });

  it('returns nothing for the errors that carry no findings', () => {
    // The negative controls. Every one of these reaches the same catch block
    // as a real refusal, and a helper that threw or invented a finding here
    // would take the screen down on an ordinary network failure.
    expect(findingsFromError(new Error('Failed to fetch'))).toEqual([]);
    expect(findingsFromError({ body: { detail: 'Document not found' } })).toEqual([]);
    expect(findingsFromError({ body: 'Internal Server Error' })).toEqual([]);
    expect(findingsFromError({ body: { detail: { message: 'No.' } } })).toEqual([]);
    expect(findingsFromError(null)).toEqual([]);
    expect(findingsFromError(undefined)).toEqual([]);
    expect(findingsFromError('nope')).toEqual([]);
    expect(findingsFromError(42)).toEqual([]);
  });

  it('ignores a detail whose findings are not a list', () => {
    expect(findingsFromError(refusal([] as unknown[]))).toEqual([]);
    expect(findingsFromError({ body: { detail: { findings: 'one' } } })).toEqual([]);
  });

  it('drops entries that would render as a blank row', () => {
    const found = findingsFromError(refusal([finding(), null, 'text', {}, { severity: 'error' }]));
    expect(found).toHaveLength(1);
  });
});

describe('onlyWarnings', () => {
  it('is true when every finding is waivable', () => {
    expect(onlyWarnings([finding({ severity: 'warning' }), finding({ severity: 'warning' })])).toBe(
      true,
    );
  });

  it('is false when anything in the set is an error', () => {
    // The whole reason to ask: an error is never waivable, so offering "send
    // anyway" here would put a button on a refusal that can never succeed.
    expect(onlyWarnings([finding({ severity: 'warning' }), finding({ severity: 'error' })])).toBe(
      false,
    );
    expect(onlyWarnings([finding({ severity: 'error' })])).toBe(false);
  });

  it('is false for no findings at all', () => {
    expect(onlyWarnings([])).toBe(false);
  });
});

describe('countryRegime', () => {
  const countries: CountryRegime[] = [
    {
      country: 'MX',
      regime: 'clearance',
      platform: 'CFDI 4.0',
      label: 'Mexico',
      identifier_label: 'UUID (Folio Fiscal)',
      document_format: 'cfdi_4_0',
      en16931_profile: '',
      profile_fields: [],
      document_fields: [],
      cancellation_window_days: 365,
      is_cancellable: true,
      correction_mechanism: 'cancellation, then a replacement CFDI',
      notes: '',
    },
  ];

  it('finds a country however the row cased it', () => {
    expect(countryRegime(countries, 'MX')?.platform).toBe('CFDI 4.0');
    expect(countryRegime(countries, 'mx')?.platform).toBe('CFDI 4.0');
    expect(countryRegime(countries, ' mx ')?.platform).toBe('CFDI 4.0');
  });

  it('is undefined rather than something plausible for a country it lacks', () => {
    // The cancel button and the identifier label both hang off this, so a miss
    // has to be a miss: guessing an entry would offer a withdrawal for a
    // platform that has no cancellation flow.
    expect(countryRegime(countries, 'BR')).toBeUndefined();
    expect(countryRegime(countries, '')).toBeUndefined();
    expect(countryRegime([], 'MX')).toBeUndefined();
  });
});
