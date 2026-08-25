// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
//
// The page heading and the browser tab both come from the English literal a
// route passes as `<P title="...">`, translated through TITLE_I18N_MAP. Two
// things go wrong there and neither is visible from the type system.
//
// A route with no entry in the map keeps its English title in every language,
// because the lookup falls back to `defaultValue`. Half the routes were in
// that state, including the opening screen of most modules, so a German
// session read "Field Time" over a page whose every other word was German.
//
// An entry pointing at a key no locale answers looks fixed and behaves the
// same way, since the same `defaultValue` catches it. Two entries were in
// that state for as long as the map has existed.
//
// Run:  npx vitest run src/app/layout/pageTitleI18n.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import de from '../locales/de';
import en from '../locales/en';
import { TITLE_I18N_MAP } from './Header';

const APP_CANDIDATES = [
  resolve(process.cwd(), 'src/app/App.tsx'),
  resolve(process.cwd(), 'frontend/src/app/App.tsx'),
];
const APP_PATH = APP_CANDIDATES.find(existsSync);
if (!APP_PATH) throw new Error(`cannot find App.tsx, looked in ${APP_CANDIDATES.join(' and ')}`);
const APP_SOURCE = readFileSync(APP_PATH, 'utf8');

const routeTitles = new Set<string>();
for (const match of APP_SOURCE.matchAll(/<P\s+title=(["'])(.*?)\1/gs)) {
  if (match[2]) routeTitles.add(match[2]);
}

/**
 * Routes whose title has no key anywhere yet.
 *
 * Every one of them is an operator-of-the-operator surface: developer tooling,
 * a chat trace viewer, an admin register. None appears in a workflow a site
 * uses, so they are named in English on purpose until somebody translates
 * them, rather than pointing at a neighbouring key that means something else.
 * A new route belongs in the map, not in this list.
 */
const ENGLISH_ON_PURPOSE = new Set([
  'CPM',
  'Chat Observability',
  'Compare Revisions',
  'EAC Block Primitives',
  'Geo Hub Admin',
  'Module Developer Guide',
  'Property Development Dashboard',
  'Search across projects',
  'Styles Lab',
  'Webhook Targets',
]);

describe('page titles and the locale bundle', () => {
  it('translates every route title the app mounts', () => {
    const untranslated = [...routeTitles]
      .filter((title) => !(title in TITLE_I18N_MAP))
      .filter((title) => !ENGLISH_ON_PURPOSE.has(title))
      .sort();
    expect(untranslated, 'route titles with no i18n key: heading and browser tab stay English').toEqual([]);
  });

  it('points every entry at a key the locales answer', () => {
    // English is where a key is born; German is the language the map exists
    // for, and a key present in en and missing in de renders English anyway.
    const bundles: Array<[string, Record<string, string>]> = [
      ['en', en.translation],
      ['de', de.translation],
    ];
    const dangling: string[] = [];
    for (const [title, key] of Object.entries(TITLE_I18N_MAP)) {
      for (const [locale, bundle] of bundles) {
        if (!(key in bundle)) dangling.push(`${locale}: ${title} -> ${key}`);
      }
    }
    expect(dangling.sort(), 'map entries pointing at a key no locale carries').toEqual([]);
  });

  it('keeps the exception list honest', () => {
    // A title translated later must leave this list, or the list starts
    // certifying work that is already done.
    const stale = [...ENGLISH_ON_PURPOSE].filter((title) => title in TITLE_I18N_MAP).sort();
    expect(stale, 'listed as untranslatable but the map translates it').toEqual([]);
    const gone = [...ENGLISH_ON_PURPOSE].filter((title) => !routeTitles.has(title)).sort();
    expect(gone, 'listed but no route carries this title any more').toEqual([]);
  });
});
