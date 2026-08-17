// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * The depth meter is a claim about real catalogues, so it is checked against
 * the real catalogue sizes rather than against numbers copied in here.
 *
 * Copying the counts into this file would test the copy. The registry is the
 * one place those numbers live, so the counts are read out of it: add a base,
 * or restate an existing one, and the assertions below run against the new
 * figures on the next run. Two things are asserted that a literal test could
 * not: that the flagship GESN / FER / TER base still reaches the top band, and
 * that the bands actually separate the catalogue - a meter where everything
 * lands on the same segment is decoration, and it would pass any check written
 * one base at a time.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEPTH_BANDS, DEPTH_THRESHOLDS, baseDepthLevel } from './baseDepth';

// vitest runs with the frontend package as its working directory. Resolving
// from `import.meta.url` does not work here: Vite rewrites it to a `/@fs/` URL,
// which `readFileSync` refuses.
const REGISTRY = resolve(process.cwd(), '..', 'backend', 'app', 'modules', 'costs', 'base_registry.py');

function registrySource(): string {
  try {
    return readFileSync(REGISTRY, 'utf-8');
  } catch (error) {
    throw new Error(
      `cannot read the cost base registry at ${REGISTRY}, so the depth bands cannot be checked ` +
        `against the catalogues they describe (${String(error)})`
    );
  }
}

/** Work-item count of the flagship base every market of the global family shares. */
function globalPositions(source: string): number {
  const value = source.match(/^_GLOBAL_POSITIONS\s*=\s*(\d+)/m)?.[1];
  if (!value) throw new Error('the registry no longer declares _GLOBAL_POSITIONS');
  return Number(value);
}

/** Work-item count of each national base, keyed by family key. */
function nationalPositions(source: string): Record<string, number> {
  const start = source.indexOf('_NATIONAL_FAMILIES');
  const end = source.indexOf('BASE_FAMILIES: tuple');
  if (start === -1 || end === -1) throw new Error('cannot locate the national families block in the registry');

  const counts: Record<string, number> = {};
  for (const call of source.slice(start, end).split('_national(').slice(1)) {
    const key = call.match(/"([^"]+)"/)?.[1];
    const positions = call.match(/positions=(\d+)/)?.[1];
    if (key && positions) counts[key] = Number(positions);
  }
  if (Object.keys(counts).length === 0) throw new Error('no national bases found in the registry');
  return counts;
}

describe('baseDepthLevel', () => {
  it('puts the flagship base at the top of the scale', () => {
    // The founder's requirement, stated against the registry rather than
    // against a hard-coded 55,719: whatever the global catalogue holds, it is
    // the deepest base we ship and the meter has to read full.
    expect(baseDepthLevel(globalPositions(registrySource()))).toBe(DEPTH_BANDS);
  });

  it('leaves no other base sharing the top band', () => {
    const source = registrySource();
    const flagship = baseDepthLevel(globalPositions(source));
    for (const [key, positions] of Object.entries(nationalPositions(source))) {
      expect(baseDepthLevel(positions), `${key} reads as deep as the flagship`).toBeLessThan(flagship);
    }
  });

  it('spreads the shipped bases over more than one band', () => {
    const source = registrySource();
    const levels = new Set(Object.values(nationalPositions(source)).map(baseDepthLevel));
    expect(levels.size).toBeGreaterThan(1);
  });

  it('keeps every shipped base inside the scale', () => {
    const source = registrySource();
    const all = [globalPositions(source), ...Object.values(nationalPositions(source))];
    for (const positions of all) {
      const level = baseDepthLevel(positions);
      expect(level).toBeGreaterThanOrEqual(1);
      expect(level).toBeLessThanOrEqual(DEPTH_BANDS);
    }
  });

  it('reads the thresholds inclusively and never falls off the bottom', () => {
    expect(baseDepthLevel(DEPTH_THRESHOLDS[0])).toBe(DEPTH_BANDS);
    expect(baseDepthLevel(DEPTH_THRESHOLDS[0] - 1)).toBe(DEPTH_BANDS - 1);
    expect(baseDepthLevel(0)).toBe(1);
  });
});
