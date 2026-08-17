// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * The address this page hands out has to be one the server answers.
 *
 * Asserting the built string against another string written here would restate
 * the implementation and pass on any address at all, which is exactly how the
 * page came to advertise `/calendar/feed.ics` - a path no route has ever
 * served. So the expected shape is read out of the router itself: the
 * decorator that mounts the feed, and the name of the query parameter it
 * authenticates on. Change either on the server and this test fails on the next
 * run instead of on a user's calendar client.
 *
 * What it does not cover: the mount prefix. `module_loader` composes that from
 * the module directory at import time rather than declaring it somewhere
 * readable, so it is written on both sides here. A change to that scheme passes
 * this test and still breaks the address.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CALENDAR_TOKEN_PLACEHOLDER, calendarFeedUrl } from './calendarFeed';

// vitest runs with the frontend package as its working directory. Resolving
// from `import.meta.url` does not work here: Vite rewrites it to a `/@fs/`
// URL, which `readFileSync` refuses.
const MODULE_DIR = 'integrations';
const ROUTER = resolve(process.cwd(), '..', 'backend', 'app', 'modules', MODULE_DIR, 'router.py');

function routerSource(): string {
  try {
    return readFileSync(ROUTER, 'utf-8');
  } catch (error) {
    throw new Error(
      `cannot read the integrations router at ${ROUTER}, so the address cannot be checked ` +
        `against the route it is meant to reach (${String(error)})`
    );
  }
}

/** The path in the `@router.get(...)` decorator that serves the ICS feed. */
function decoratedFeedPath(source: string): string {
  const path = source.match(/@router\.get\(\s*["'](\/calendar\/[^"']*\.ics\/?)["']/)?.[1];
  if (!path) throw new Error('no @router.get decorator for a .ics path found in the integrations router');
  return path;
}

/** The name of the required query parameter the feed route authenticates on. */
function requiredTokenParam(source: string): string {
  const name = source.match(/\n\s+(\w+):\s*str\s*=\s*Query\(\s*\.\.\./)?.[1];
  if (!name) throw new Error('the feed route no longer declares a required query token');
  return name;
}

/**
 * Where the loader mounts this module.
 *
 * `module_loader` builds the prefix as `/api/v1/<kebab module directory>`; the
 * router object itself declares none. Deriving it from the directory keeps the
 * two in step: rename the module on the server and the expectation moves with
 * it, so the frontend that did not follow is what fails.
 */
const MOUNT = `/api/v1/${MODULE_DIR}`;

const PROJECT = '8f1c4c22-0f4a-4f1e-9a8d-2b6f0f5a1c33';
const ORIGIN = 'https://erp.example.org';

describe('calendarFeedUrl', () => {
  it('addresses the path the router actually decorates', () => {
    const source = routerSource();
    const expected = `${ORIGIN}${MOUNT}${decoratedFeedPath(source).replace('{project_id}', PROJECT)}`;
    const built = calendarFeedUrl(ORIGIN, PROJECT);

    expect(built.split('?')[0]).toBe(expected);
  });

  it('carries the token parameter the route requires', () => {
    // The route declares `token: str = Query(...)`, so a URL without it is
    // rejected before any calendar is built. Read the parameter name rather
    // than assuming it.
    const declared = requiredTokenParam(routerSource());
    const query = new URL(calendarFeedUrl(ORIGIN, PROJECT)).searchParams;

    expect(query.get(declared)).toBe(CALENDAR_TOKEN_PLACEHOLDER);
  });

  it('leaves the token visibly unfilled rather than inventing one', () => {
    // Nothing in the interface issues an API key yet. The placeholder is the
    // honest output; a generated-looking value would read as ready to use.
    expect(calendarFeedUrl(ORIGIN, PROJECT)).toContain(`token=${CALENDAR_TOKEN_PLACEHOLDER}`);
    expect(CALENDAR_TOKEN_PLACEHOLDER).not.toMatch(/^[0-9a-f]{8,}$/i);
  });

  it('offers no address at all when no project is active', () => {
    // The route has no form that omits the project, so there is nothing to
    // hand out and the section prompts for a project instead.
    expect(calendarFeedUrl(ORIGIN, '')).toBe('');
  });

  it('never rebuilds the address that was being handed out before', () => {
    const built = calendarFeedUrl(ORIGIN, PROJECT);
    expect(built).not.toContain('/feed.ics');
    expect(routerSource()).not.toContain('feed.ics');
  });
});
