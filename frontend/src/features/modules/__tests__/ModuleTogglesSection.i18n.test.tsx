// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
//
// The registry cards, rendered in German through the real i18next wiring.
//
// `manifestI18n.test.ts` proves every manifest string is a key and that a
// German value exists for it. That is a statement about the data; this is the
// statement about the screen, and the two fail differently. A page that
// rendered `mod.name` straight would pass the data test and print
// `modules.pdf_takeoff.name` to a German reader, which is exactly the state
// this sweep replaced.
//
// Run:  npx vitest run src/features/modules/__tests__/ModuleTogglesSection.i18n.test.tsx

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18next, { type i18n as I18n } from 'i18next';

// This suite exercises the real translation path, so the harness-wide stub of
// react-i18next (src/test/setup.ts) must not stand in for it here.
vi.unmock('react-i18next');

import { I18nextProvider } from 'react-i18next';
import de from '../../../app/locales/de';
import fr from '../../../app/locales/fr';
import { MODULE_REGISTRY, getModuleTranslations } from '../../../modules/_registry';
import { ModuleTogglesSection } from '../ModulesPage';

let i18n: I18n;
let i18nFr: I18n;

beforeAll(async () => {
  // German only, with no English fallback behind it. Production does fall back
  // to English, and that fallback is precisely what hides a missing German
  // string: with English in the store an untranslated card still reads like a
  // finished one. Take it away and anything not translated shows up.
  i18n = i18next.createInstance();
  await i18n.init({
    lng: 'de',
    fallbackLng: false,
    resources: { de: { translation: {} } },
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  // Merge in production's order, which is not the intuitive one. `app/i18n.ts`
  // merges the module bundles while the module itself evaluates (line 319);
  // the locale arrives later, on the lazy chunk (line 111), and both calls
  // overwrite. So a key that a manifest and a locale file both define is won
  // by the locale file. Loading the locale first and the modules on top would
  // let this test assert a German string the app never actually shows.
  for (const [lng, keys] of Object.entries(getModuleTranslations())) {
    i18n.addResourceBundle(lng, 'translation', keys, true, true);
  }
  i18n.addResourceBundle('de', 'translation', de.translation, false, true);

  // A second instance in French, same production merge order, same absent
  // English fallback. German alone would not prove the merge order generalizes
  // past the one locale it happened to be fixed for; French is a locale none
  // of these manifest keys shipped in before this sweep, so it only passes if
  // the manifest bundle actually reaches a locale beyond German.
  i18nFr = i18next.createInstance();
  await i18nFr.init({
    lng: 'fr',
    fallbackLng: false,
    resources: { fr: { translation: {} } },
    keySeparator: false,
    nsSeparator: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  for (const [lng, keys] of Object.entries(getModuleTranslations())) {
    i18nFr.addResourceBundle(lng, 'translation', keys, true, true);
  }
  i18nFr.addResourceBundle('fr', 'translation', fr.translation, false, true);
});

function renderSection() {
  return render(
    <I18nextProvider i18n={i18n}>
      <ModuleTogglesSection
        isModuleEnabled={() => true}
        setModuleEnabled={() => {}}
        canDisable={() => ({ allowed: true, blockedBy: [] })}
        getEnabledDependents={() => []}
      />
    </I18nextProvider>,
  );
}

function renderSectionFr() {
  return render(
    <I18nextProvider i18n={i18nFr}>
      <ModuleTogglesSection
        isModuleEnabled={() => true}
        setModuleEnabled={() => {}}
        canDisable={() => ({ allowed: true, blockedBy: [] })}
        getEnabledDependents={() => []}
      />
    </I18nextProvider>,
  );
}

describe('module registry cards in German', () => {
  it('shows a name a locale file carries', () => {
    // `collab.title`, translated in every locale file.
    renderSection();
    expect(screen.getByText('Echtzeit-Zusammenarbeit')).toBeInTheDocument();
  });

  it('shows a name the manifest carries itself', () => {
    // `modules.pdf_takeoff.name` exists in no locale file - the module ships
    // it, and it has to reach the card through the module bundle alone.
    renderSection();
    expect(screen.getByText('PDF-Aufmaß-Viewer')).toBeInTheDocument();
  });

  it('shows a description the manifest carries itself', () => {
    renderSection();
    expect(
      screen.getByText(/PDF-Pläne ansehen und Mengen direkt in der Zeichnung aufmessen/),
    ).toBeInTheDocument();
  });

  it('prints no manifest key anywhere on the page', () => {
    // The class assertion: not one of the strings the manifests declare may
    // appear as itself. Naming a single card would pass while the other 16
    // leaked.
    const { container } = renderSection();
    const text = container.textContent ?? '';
    const leaked = MODULE_REGISTRY.flatMap((m) => [m.name, m.description]).filter((key) =>
      text.includes(key),
    );
    expect(leaked).toEqual([]);
  });

  it('translates every card, rather than falling back to the English name', () => {
    // Each module's English name, gathered from its own bundle where it has
    // one: seeing it on a German page means the German never arrived.
    const englishNames = MODULE_REGISTRY.map((m) => m.translations?.['en']?.[m.name]).filter(
      (value): value is string => typeof value === 'string',
    );
    const { container } = renderSection();
    const text = container.textContent ?? '';
    const english = englishNames.filter(
      // A name that reads the same in both languages (product and standard
      // names: "DDC cad2data - IFC Converter") is not evidence of a fallback.
      (name) => text.includes(name) && de.translation[name] === undefined && !/DDC|GAEB/.test(name),
    );
    expect(english).toEqual([]);
  });
});

describe('module registry cards in French', () => {
  // The German suite above proves the merge order for one locale. This proves
  // it generalizes: French carries none of these manifest keys in its locale
  // file before this sweep, so a card that renders correctly here only does
  // so because the manifest bundle reached a second language, not because the
  // merge order happens to work for German specifically.
  it('shows a name a locale file carries', () => {
    // `collab.title`, translated in every locale file.
    renderSectionFr();
    expect(screen.getByText('Collaboration en temps réel')).toBeInTheDocument();
  });

  it('shows a name the manifest carries itself', () => {
    // `modules.pdf_takeoff.name` exists in no locale file - the module ships
    // it, and it has to reach the card through the module bundle alone.
    renderSectionFr();
    expect(screen.getByText('Visionneuse de métré PDF')).toBeInTheDocument();
  });

  it('shows a description the manifest carries itself', () => {
    renderSectionFr();
    expect(
      screen.getByText(/Visualisez des PDF et effectuez des mesures directement sur les plans/),
    ).toBeInTheDocument();
  });

  it('prints no manifest key anywhere on the page', () => {
    const { container } = renderSectionFr();
    const text = container.textContent ?? '';
    const leaked = MODULE_REGISTRY.flatMap((m) => [m.name, m.description]).filter((key) =>
      text.includes(key),
    );
    expect(leaked).toEqual([]);
  });

  it('translates every card, rather than falling back to the English name', () => {
    const englishNames = MODULE_REGISTRY.map((m) => m.translations?.['en']?.[m.name]).filter(
      (value): value is string => typeof value === 'string',
    );
    const { container } = renderSectionFr();
    const text = container.textContent ?? '';
    const english = englishNames.filter(
      (name) => text.includes(name) && fr.translation[name] === undefined && !/DDC|GAEB/.test(name),
    );
    expect(english).toEqual([]);
  });
});
