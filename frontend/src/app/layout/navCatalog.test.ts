// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
//
// routeIcons.ts says in its own header that it MIRRORS the nav definitions and
// that the two must be kept in sync by hand. That sentence has been there since
// the map was written and nothing has ever checked it, so this does.
//
// The claim under test is narrow on purpose: for every screen the menu offers,
// asking the route-icon map about that exact path returns the same glyph the
// menu row draws. Where the map has no entry for a path it answers with the
// parent module's icon, which is the behaviour detail routes rely on, so a
// disagreement here is a real one rather than a gap.

import { describe, expect, it } from 'vitest';
import { navGroups } from './navCatalog';
import { getRouteIcon } from './routeIcons';

describe('the screen catalogue and the route-icon map', () => {
  it('agree on the icon for every screen the menu offers', () => {
    const disagreements: string[] = [];
    for (const group of navGroups) {
      for (const item of group.items) {
        const fromMap = getRouteIcon(item.to);
        if (fromMap !== item.icon) {
          disagreements.push(
            `${item.to}: menu draws ${item.icon.displayName ?? item.icon.name}, ` +
            `map answers ${fromMap ? (fromMap.displayName ?? fromMap.name) : 'nothing'}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('gives every screen a route, a label key and an icon', () => {
    const broken: string[] = [];
    for (const group of navGroups) {
      for (const item of group.items) {
        if (!item.to.startsWith('/')) broken.push(`${item.labelKey}: route ${item.to}`);
        if (!item.labelKey) broken.push(`${item.to}: no label key`);
        if (!item.icon) broken.push(`${item.to}: no icon`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('lists each route once, so a screen has one home in the menu', () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const group of navGroups) {
      for (const item of group.items) {
        const first = seen.get(item.to);
        if (first) twice.push(`${item.to} in both ${first} and ${group.id}`);
        else seen.set(item.to, group.id);
      }
    }
    expect(twice).toEqual([]);
  });
});
