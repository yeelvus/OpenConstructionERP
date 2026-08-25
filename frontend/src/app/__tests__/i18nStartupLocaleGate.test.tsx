// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
//
// Startup language gate - the non-English boot path.
//
// i18next boots with only the bundled English resource; the active locale
// arrives in a lazy chunk. The old boot merely kicked that fetch off
// (`void loadLocaleResource(...)`) and mounted React immediately, so the
// first frame of every non-English session rendered through the English
// fallback - the "English flash" the German pilot QA measured on every
// single page load, whatever the cache state, because the first paint is
// synchronous and a chunk resolve never is.
//
// The fix is an exported `initialLocaleReady` promise that `main.tsx`
// awaits (time-capped) before mounting. This suite pins the contract from
// the non-English side: the gate exists, it resolves only after the locale
// is merged, and a first render issued after it holds not a single English
// fallback string. The English side (no gate, no waiting) is pinned in
// `i18nStartupLocaleGate.en.test.tsx` - the language is read once at module
// evaluation, so each boot scenario needs its own test file.
//
// Run:  npx vitest run src/app/__tests__/i18nStartupLocaleGate.test.tsx

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider, useTranslation } from 'react-i18next';

// This suite exercises the real i18next wiring, so the harness-wide mock of
// react-i18next (src/test/setup.ts) must not stand in for it here.
vi.unmock('react-i18next');

// The shipped locale files are ~3 MB object literals; pushing one through the
// vitest transform pipeline stalls the worker (see localeKeyResolution.test.ts).
// The gate's behaviour does not depend on dictionary size, so the bundled
// English and the lazily imported German are both replaced with small fixtures
// whose values disagree on every key - which is exactly what lets an assertion
// tell "resolved from the active locale" apart from "fell back to English"
// without ever naming one particular production string.
const FIXTURES = vi.hoisted(() => ({
  EN: {
    'probe.title': 'Bill of quantities',
    'probe.action': 'Export',
    'probe.rows': 'Rows',
  } as Record<string, string>,
  DE: {
    'probe.title': 'Leistungsverzeichnis',
    'probe.action': 'Exportieren',
    'probe.rows': 'Zeilen',
  } as Record<string, string>,
}));

vi.mock('../locales/en', () => ({ default: { translation: FIXTURES.EN } }));
vi.mock('../locales/de.ts', () => ({ default: { translation: FIXTURES.DE } }));
vi.mock('@/modules/_registry', () => ({ getModuleTranslations: () => ({}) }));

type I18nModule = typeof import('../i18n');
let i18nMod: I18nModule;

beforeAll(async () => {
  // The saved language a returning user boots with. It must be in place
  // before the module under test is imported - the module reads it at
  // evaluation time, exactly as a real page load does.
  window.localStorage.setItem('i18nextLng', 'de');
  i18nMod = await import('../i18n');
});

describe('startup language gate - stored non-English locale', () => {
  it('initializes synchronously, so the gate is the only thing left to wait for', () => {
    expect(i18nMod.default.isInitialized).toBe(true);
    expect(i18nMod.default.language).toBe('de');
  });

  it('exposes a pending gate instead of a fire-and-forget load', () => {
    expect(i18nMod.initialLocaleReady).toBeInstanceOf(Promise);
  });

  it('resolves only once the locale bundle is merged into the store', async () => {
    await i18nMod.initialLocaleReady;
    expect(i18nMod.default.hasResourceBundle('de', 'translation')).toBe(true);
  });

  it('a first render issued after the gate carries no English fallback strings', async () => {
    await i18nMod.initialLocaleReady;
    const KEYS = Object.keys(FIXTURES.EN);
    function Probe() {
      const { t } = useTranslation();
      return (
        <div>
          {KEYS.map((k) => (
            <span key={k} data-testid={`probe:${k}`}>
              {t(k)}
            </span>
          ))}
        </div>
      );
    }
    render(
      <I18nextProvider i18n={i18nMod.default}>
        <Probe />
      </I18nextProvider>,
    );
    // Assert the class of behaviour, not one word: for every sampled key the
    // very first paint must show the active locale's value and must not show
    // the English one. No waitFor here on purpose - what is being asserted IS
    // the initial frame, before any recovery re-render could paper over it.
    for (const k of KEYS) {
      const text = screen.getByTestId(`probe:${k}`).textContent;
      expect(text, `key ${k} rendered the English fallback on first paint`).not.toBe(
        FIXTURES.EN[k],
      );
      expect(text).toBe(FIXTURES.DE[k]);
    }
  });
});
