// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * The pure decisions the tax withholding screen makes for itself.
 *
 * Everything else on the panel is the server's answer rendered as it came.
 * These are ours, and each has a wrong version that looks right: a bucketer
 * that reads `days_to_expiry` as a truthy number files "expires today" under
 * "never expires", and a band lookup returning 0 for a code the scheme does
 * not define cannot be told apart from the zero-rate bands three of the five
 * shipped schemes actually have.
 */

import { describe, it, expect } from 'vitest';

import { bandRate, findBand, standingState, standingVariant } from './withholdingStatus';
import type { StandingState } from './withholdingStatus';
import type { PartyStatus, Regime } from './api';

const TODAY = '2026-08-08';

function standing(over: Partial<PartyStatus> = {}): PartyStatus {
  return {
    id: 's1',
    party_id: 'party-1',
    party_type: 'subcontractor',
    party_name: 'Northbank Groundworks',
    regime_id: 'r1',
    band_code: 'STANDARD',
    verification_reference: 'V-88213',
    verified_on: '2026-01-10',
    valid_from: '2026-01-10',
    valid_to: '2027-01-09',
    evidence_document_id: null,
    evidence_reference: '',
    status: 'active',
    notes: '',
    created_at: '2026-01-10T00:00:00Z',
    updated_at: '2026-01-10T00:00:00Z',
    is_expired: false,
    days_to_expiry: 154,
    ...over,
  };
}

function regime(over: Partial<Regime> = {}): Regime {
  return {
    id: 'r1',
    country_code: 'IE',
    scheme_code: 'IE_RCT',
    scheme_name: 'Relevant Contracts Tax',
    legal_reference: '',
    authority: '',
    currency_code: 'EUR',
    bands: [
      { code: 'ZERO', label: 'Zero rate', rate_pct: '0', requires_verification: true },
      { code: 'STANDARD', label: 'Standard rate', rate_pct: '20', requires_verification: true },
      { code: 'HIGHER', label: 'Higher rate', rate_pct: '35', requires_verification: false },
    ],
    default_band_code: 'HIGHER',
    materials_excluded: false,
    vat_excluded: true,
    verification_validity_months: 12,
    threshold_amount: null,
    notes: '',
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('standingState', () => {
  it('calls a verification with room left current', () => {
    expect(standingState(standing(), TODAY)).toBe('current');
  });

  it('flags one closing inside the window as expiring', () => {
    expect(standingState(standing({ days_to_expiry: 12 }), TODAY)).toBe('expiring');
    expect(standingState(standing({ days_to_expiry: 60 }), TODAY)).toBe('expiring');
    expect(standingState(standing({ days_to_expiry: 61 }), TODAY)).toBe('current');
  });

  it('treats a window closing today as expiring and not as open-ended', () => {
    // The negative control that matters. `days_to_expiry` is 0 on the last day
    // the verification holds. A bucketer written `if (!days) return 'current'`
    // passes every other test in this file and tells the one party whose
    // certificate runs out this afternoon that nothing is due.
    expect(standingState(standing({ days_to_expiry: 0, valid_to: TODAY }), TODAY)).toBe('expiring');
  });

  it('leaves a standing with no end date alone rather than calling it expiring', () => {
    // Null is the other half of the same trap, and it has to land somewhere
    // different from 0: there is no end date to warn about.
    expect(standingState(standing({ days_to_expiry: null, valid_to: null }), TODAY)).toBe('current');
  });

  it('reports a closed window as lapsed, however far past', () => {
    // days_to_expiry goes negative rather than null once the window closes, so
    // a screen that renders it unguarded says "expires in -12 days".
    expect(standingState(standing({ is_expired: true, days_to_expiry: -1 }), TODAY)).toBe('lapsed');
    expect(standingState(standing({ is_expired: true, days_to_expiry: -400 }), TODAY)).toBe('lapsed');
  });

  it('reports a stored expired status even where the dates do not say so', () => {
    // is_expired is computed from valid_to alone, so an open-ended row someone
    // marked expired reports is_expired false. The backend still refuses it.
    expect(
      standingState(standing({ status: 'expired', valid_to: null, days_to_expiry: null }), TODAY),
    ).toBe('lapsed');
  });

  it('puts revocation ahead of expiry when both are true', () => {
    expect(standingState(standing({ status: 'revoked' }), TODAY)).toBe('revoked');
    expect(
      standingState(standing({ status: 'revoked', is_expired: true, days_to_expiry: -30 }), TODAY),
    ).toBe('revoked');
  });

  it('refuses to call a standing with no reference verified', () => {
    // Matches verification_is_current: a standing marked active with nothing
    // from the authority behind it is an intention. Whitespace is not a
    // reference either.
    expect(standingState(standing({ verification_reference: '' }), TODAY)).toBe('unverified');
    expect(standingState(standing({ verification_reference: '   ' }), TODAY)).toBe('unverified');
  });

  it('does not vouch for a standing nobody has confirmed', () => {
    // The backend honours a pending standing - verification_is_current refuses
    // only revoked and expired - so the figure is unchanged either way. What
    // must not happen is this screen painting it green and calling it current.
    expect(standingState(standing({ status: 'pending' }), TODAY)).toBe('pending');
    expect(standingVariant(standingState(standing({ status: 'pending' }), TODAY))).not.toBe('success');
  });

  it('reports the louder problem first on a pending standing that also lapsed', () => {
    expect(standingState(standing({ status: 'pending', is_expired: true }), TODAY)).toBe('lapsed');
    expect(standingState(standing({ status: 'pending', verification_reference: '' }), TODAY)).toBe(
      'unverified',
    );
  });

  it('does not treat a window that has not opened as current', () => {
    expect(standingState(standing({ valid_from: '2026-09-01' }), TODAY)).toBe('not_yet');
    // Starting today is open, not pending. The whole day counts.
    expect(standingState(standing({ valid_from: TODAY }), TODAY)).toBe('current');
  });

  it('compares valid_from as a string across month and year boundaries', () => {
    expect(standingState(standing({ valid_from: '2026-10-01' }), '2026-09-30')).toBe('not_yet');
    expect(standingState(standing({ valid_from: '2027-01-01' }), '2026-12-31')).toBe('not_yet');
  });

  it('honours a caller that asks about a different window', () => {
    expect(standingState(standing({ days_to_expiry: 100 }), TODAY, 120)).toBe('expiring');
    expect(standingState(standing({ days_to_expiry: 100 }), TODAY, 30)).toBe('current');
  });
});

describe('standingVariant', () => {
  it('paints the states that need acting on differently from the ones that do not', () => {
    expect(standingVariant('revoked')).toBe('error');
    expect(standingVariant('lapsed')).toBe('error');
    expect(standingVariant('expiring')).toBe('warning');
    expect(standingVariant('unverified')).toBe('warning');
    expect(standingVariant('pending')).toBe('blue');
    expect(standingVariant('not_yet')).toBe('neutral');
    expect(standingVariant('current')).toBe('success');
  });

  it('reserves the success colour for the one state worth vouching for', () => {
    // Every other state has something outstanding on it. If a second state
    // ever paints green, a row needing action becomes indistinguishable from
    // one that does not at a glance, which is the whole register's job.
    const others: StandingState[] = ['revoked', 'lapsed', 'unverified', 'pending', 'not_yet', 'expiring'];
    for (const state of others) {
      expect(standingVariant(state)).not.toBe('success');
    }
    expect(standingVariant('current')).toBe('success');
  });
});

describe('findBand', () => {
  it('finds a band the scheme defines', () => {
    expect(findBand(regime(), 'STANDARD')?.rate_pct).toBe('20');
    expect(findBand(regime(), 'HIGHER')?.requires_verification).toBe(false);
  });

  it('returns null for a code the scheme does not define', () => {
    expect(findBand(regime(), 'GROSS')).toBeNull();
  });

  it('returns null rather than throwing before a scheme is picked', () => {
    // The picker renders before the schemes query resolves.
    expect(findBand(undefined, 'STANDARD')).toBeNull();
    expect(findBand(regime(), '')).toBeNull();
  });
});

describe('bandRate', () => {
  it('gives back the rate as the string it arrived as', () => {
    // Not a number. A percentage parsed and re-rendered is a percentage this
    // screen has taken responsibility for, and it has not.
    expect(bandRate(regime(), 'STANDARD')).toBe('20');
    expect(typeof bandRate(regime(), 'STANDARD')).toBe('string');
  });

  it('tells a zero-rate band apart from a band that does not exist', () => {
    // The control. Three of the five shipped schemes define a real band at 0%
    // — Ireland ZERO, Germany EXEMPT, the US NONE — so a lookup answering 0
    // for an unknown code reports "nothing is withheld" about a scheme that
    // never said so.
    expect(bandRate(regime(), 'ZERO')).toBe('0');
    expect(bandRate(regime(), 'NO_SUCH_BAND')).toBeNull();
    expect(bandRate(regime(), 'ZERO')).not.toBeNull();
  });
});
