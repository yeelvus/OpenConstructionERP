// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
//
// Startup language gate - the English boot path.
//
// The counterpart of `i18nStartupLocaleGate.test.tsx`: an English session has
// its whole dictionary in the main bundle, so the boot must not wait on
// anything - no gate promise, no timer, a fully synchronous mount path. This
// file pins that regression surface: a future edit that makes English boots
// wait (or makes non-English boots stop waiting) turns exactly one of these
// two suites red. The scenarios live in separate files because the module
// under test resolves its language once, at evaluation time.
//
// Run:  npx vitest run src/app/__tests__/i18nStartupLocaleGate.en.test.tsx

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider, useTranslation } from 'react-i18next';

// Real react-i18next, not the harness-wide mock from src/test/setup.ts.
vi.unmock('react-i18next');

// Small fixtures instead of the ~3 MB shipped dictionaries - see the sibling
// suite for why the real files must stay out of the vitest transform.
const FIXTURES = vi.hoisted(() => ({
  EN: {
    'probe.title': 'Bill of quantities',
    'probe.action': 'Export',
  } as Record<string, string>,
}));

vi.mock('../locales/en', () => ({ default: { translation: FIXTURES.EN } }));
vi.mock('@/modules/_registry', () => ({ getModuleTranslations: () => ({}) }));

type I18nModule = typeof import('../i18n');
let i18nMod: I18nModule;

beforeAll(async () => {
  window.localStorage.setItem('i18nextLng', 'en');
  i18nMod = await import('../i18n');
});

describe('startup language gate - stored English locale', () => {
  it('has no gate: an English boot must not wait on anything', () => {
    expect(i18nMod.initialLocaleReady).toBeNull();
  });

  it('resolves English strings on a synchronous first render', () => {
    expect(i18nMod.default.isInitialized).toBe(true);
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
    for (const k of KEYS) {
      expect(screen.getByTestId(`probe:${k}`).textContent).toBe(FIXTURES.EN[k]);
    }
  });
});
