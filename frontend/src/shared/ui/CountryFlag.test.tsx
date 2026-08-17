import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CountryFlag } from './CountryFlag';

// The language list is read out of the source rather than imported, because
// importing app/i18n boots i18next with the whole English resource and the
// test worker never comes back. Only the country codes are wanted here, and
// they are a literal in that file.
const i18nSource = readFileSync(resolve(process.cwd(), 'src/app/i18n.ts'), 'utf-8');
const languages: Array<[string, string]> = [];
for (const match of i18nSource.matchAll(/\{\s*code:\s*'([^']+)'[^}]*?country:\s*'([^']+)'/g)) {
  const [, code, country] = match;
  if (code && country) languages.push([code, country]);
}

describe('CountryFlag', () => {
  it('found the language list', () => {
    // If the literal is reformatted the regex above stops matching, and a test
    // that iterates an empty list passes while checking nothing.
    expect(languages.length).toBeGreaterThan(25);
  });

  // Adding a language is two edits in two files, and forgetting the second one
  // fails silently: resolveIso returns null for a code in neither map and the
  // component renders nothing, so the switcher lists the language with a hole
  // where every other row has a flag. That is how Estonian shipped. Nothing
  // else notices - no broken image, no console warning, no type error, just an
  // empty slot - so it has to be asserted here.
  // Asserting an <img> rather than any node at all: a wrapper span with no
  // flag inside is exactly the failure this test exists to catch, and it is
  // a non-empty DOM element.
  it.each(languages)('draws a flag image for %s (country %s)', (_code, country) => {
    const { container } = render(<CountryFlag code={country} />);
    expect(container.querySelector('img')).toBeTruthy();
  });

  it('renders nothing for a code that is not a country', () => {
    const { container } = render(<CountryFlag code="zzz" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('resolves a region key to its country, not just a bare ISO code', () => {
    // Cost-base pickers pass raw region keys like DE_BERLIN and USA_USD.
    const { container } = render(<CountryFlag code="DE_BERLIN" />);
    expect(container.querySelector('img')).toBeTruthy();
  });
});
