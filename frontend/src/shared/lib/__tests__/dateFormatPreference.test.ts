// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
//
// `oe_preferences.dateFormat` was stored and offered in Settings but read by
// no rendering surface, so picking a format changed nothing. Wiring it up has
// one hard constraint: an account that never picked a format must render
// exactly what it rendered before, byte for byte. That is not a formality -
// there was no "unset" state to preserve, because both the account column and
// the store defaulted to the concrete order `DD.MM.YYYY`. `'auto'` is the new
// unset state, and the first block below is the proof that it is inert.
//
// The equivalence is asserted against the ORIGINAL expression, not against a
// reimplementation of it, so a future change to either side has to keep them
// equal rather than keep two copies of the same mistake in step.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import i18next from 'i18next';
import { formatDateWithPreference, fmtDate, getIntlLocale } from '../formatters';
import { usePreferencesStore, type DateFormat } from '@/stores/usePreferencesStore';

vi.mock('@/shared/lib/api', () => ({ apiGet: vi.fn() }));

/** A spread wide enough to catch order, separator, script and calendar drift. */
const LOCALES = ['de-DE', 'en-US', 'ru-RU', 'ja-JP', 'ar-SA'] as const;

/** The option sets the real date surfaces use, mirrored from DateDisplay. */
const DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' };
const NUMERIC_DATE_OPTIONS: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' };
const DATETIME_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
};
const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' };

const TIMESTAMP = new Date('2026-03-14T14:30:00Z');
/** Date-only values are pinned to UTC by both seams; mirror that here. */
const DATE_ONLY = new Date('2026-03-14');

const originalLanguage = i18next.language;
function setLanguage(lang: string) {
  (i18next as unknown as { language: string }).language = lang;
}

beforeEach(() => {
  localStorage.clear();
  usePreferencesStore.getState().resetPreferences();
  setLanguage(originalLanguage);
});

afterAll(() => {
  setLanguage(originalLanguage);
});

describe("the unset default ('auto') renders exactly what the language rendered before", () => {
  for (const locale of LOCALES) {
    it(`is byte-identical for ${locale}`, () => {
      const cases: [string, Date, Intl.DateTimeFormatOptions][] = [
        ['date, timestamp', TIMESTAMP, DATE_OPTIONS],
        ['date, date-only pinned to UTC', DATE_ONLY, { ...DATE_OPTIONS, timeZone: 'UTC' }],
        ['numeric, timestamp', TIMESTAMP, NUMERIC_DATE_OPTIONS],
        ['numeric, date-only pinned to UTC', DATE_ONLY, { ...NUMERIC_DATE_OPTIONS, timeZone: 'UTC' }],
        ['datetime', TIMESTAMP, DATETIME_OPTIONS],
        ['time', TIMESTAMP, TIME_OPTIONS],
      ];
      for (const [label, date, options] of cases) {
        // The right-hand side is the expression the code ran before the
        // preference existed.
        expect(formatDateWithPreference(date, locale, options, 'auto'), label).toBe(
          new Intl.DateTimeFormat(locale, options).format(date),
        );
      }
    });
  }

  for (const lang of ['de', 'en', 'ru', 'ja', 'ar']) {
    it(`keeps fmtDate byte-identical with the UI language set to ${lang}`, () => {
      setLanguage(lang);
      // Timestamp: no UTC pinning, caller options passed straight through.
      expect(fmtDate('2026-03-14T14:30:00Z')).toBe(
        new Date('2026-03-14T14:30:00Z').toLocaleDateString(getIntlLocale(), {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
        }),
      );
      // Date-only: the seam pins it to UTC so the calendar day cannot slip.
      expect(fmtDate('2026-03-14')).toBe(
        new Date('2026-03-14').toLocaleDateString(getIntlLocale(), {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        }),
      );
      // Caller-supplied options are honoured unchanged too.
      expect(fmtDate('2026-03-14', NUMERIC_DATE_OPTIONS)).toBe(
        new Date('2026-03-14').toLocaleDateString(getIntlLocale(), {
          ...NUMERIC_DATE_OPTIONS,
          timeZone: 'UTC',
        }),
      );
    });
  }

  it("starts on 'auto', so a browser that never touched Settings is on the inert path", () => {
    expect(usePreferencesStore.getState().dateFormat).toBe('auto');
  });
});

describe('each supported preference value renders its own order', () => {
  const EXPECTED: Record<Exclude<DateFormat, 'auto'>, string> = {
    'DD.MM.YYYY': '14.03.2026',
    'MM/DD/YYYY': '03/14/2026',
    'YYYY-MM-DD': '2026-03-14',
  };

  for (const [pref, expected] of Object.entries(EXPECTED) as [Exclude<DateFormat, 'auto'>, string][]) {
    it(`renders ${pref} as ${expected}`, () => {
      expect(formatDateWithPreference(TIMESTAMP, 'en-US', NUMERIC_DATE_OPTIONS, pref)).toBe(expected);
    });

    it(`forces the long month numeric under ${pref}`, () => {
      // The vocabulary has no long-month token, so an explicit order implies
      // an all-numeric date even where the language would have written "Mar".
      expect(formatDateWithPreference(TIMESTAMP, 'en-US', DATE_OPTIONS, pref)).toBe(expected);
    });

    it(`keeps the time intact alongside the date under ${pref}`, () => {
      const withPref = formatDateWithPreference(TIMESTAMP, 'en-US', DATETIME_OPTIONS, pref);
      // Only the date fields move. Everything the language put after them -
      // the date/time connector, the hour, the day period - is still there.
      // The separator before PM is matched as \s rather than a literal space
      // because ICU emits a narrow no-break space through formatToParts and an
      // ordinary space through format(); see formatDateWithPreference.
      expect(withPref.startsWith(expected), withPref).toBe(true);
      expect(withPref.slice(expected.length)).toMatch(/^,\s02:30\sPM$/u);
    });
  }

  it('reorders without switching the script or the calendar', () => {
    // Arabic renders Arabic-Indic digits on the Islamic calendar. The
    // preference changes the ORDER, so every field value the language
    // produced must still be present afterwards.
    const parts = new Intl.DateTimeFormat('ar-SA', NUMERIC_DATE_OPTIONS).formatToParts(TIMESTAMP);
    const field = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const rendered = formatDateWithPreference(TIMESTAMP, 'ar-SA', NUMERIC_DATE_OPTIONS, 'YYYY-MM-DD');
    expect(rendered).toBe(`${field('year')}-${field('month')}-${field('day')}`);
  });

  it('leaves a time-only cell alone, having no date fields to reorder', () => {
    for (const pref of ['DD.MM.YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const) {
      expect(formatDateWithPreference(TIMESTAMP, 'en-US', TIME_OPTIONS, pref)).toBe(
        new Intl.DateTimeFormat('en-US', TIME_OPTIONS).format(TIMESTAMP),
      );
    }
  });

  it('leaves a partial date (month and year only) to the language', () => {
    const monthYear: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };
    expect(formatDateWithPreference(TIMESTAMP, 'en-US', monthYear, 'YYYY-MM-DD')).toBe(
      new Intl.DateTimeFormat('en-US', monthYear).format(TIMESTAMP),
    );
  });

  it('reaches fmtDate, which reads the preference from the store', () => {
    usePreferencesStore.getState().setPreference('dateFormat', 'YYYY-MM-DD');
    setLanguage('de');
    expect(fmtDate('2026-03-14')).toBe('2026-03-14');
  });
});
