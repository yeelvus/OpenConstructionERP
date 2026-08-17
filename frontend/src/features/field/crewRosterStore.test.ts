// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * The pick list has to be there when there is no signal.
 *
 * Picking a person carries their register id, and the desktop timesheet
 * reconciles on exactly that. A typed name carries nothing, so the same
 * worker lands on the project twice with neither screen saying so. That means
 * an empty pick list is not a cosmetic problem - it silently sends every punch
 * back to the shape that double counts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  availableRoster,
  clearCachedRoster,
  readCachedRoster,
  rosterStorageKey,
  writeCachedRoster,
  type CrewRosterMember,
} from './crewRosterStore';

const PROJECT = 'p-1';

function person(overrides: Partial<CrewRosterMember> = {}): CrewRosterMember {
  return { id: 'r-1', name: 'A. Worker', code: 'W-001', resource_type: 'person', ...overrides };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('the roster survives losing signal', () => {
  it('reads back what was cached', () => {
    writeCachedRoster(PROJECT, [person(), person({ id: 'r-2', name: 'B. Worker', code: 'W-002' })]);

    const restored = readCachedRoster(PROJECT);
    expect(restored.map((r) => r.id)).toEqual(['r-1', 'r-2']);
    expect(restored[1]?.name).toBe('B. Worker');
  });

  it('keeps projects apart', () => {
    writeCachedRoster(PROJECT, [person()]);
    expect(readCachedRoster('p-2')).toEqual([]);
  });

  it('answers empty for a project it has never cached', () => {
    expect(readCachedRoster(PROJECT)).toEqual([]);
  });

  it('will not cache under a project id it cannot key on', () => {
    writeCachedRoster('', [person()]);
    expect(window.localStorage.getItem(rosterStorageKey(''))).toBeNull();
  });
});

describe('an empty answer does not erase a working list', () => {
  it('keeps the cached roster when the server returns nobody', () => {
    // A project whose register is simply not filled in yet is indistinguishable
    // here from a bad round trip, and taking the picker away from a foreman who
    // had it a minute ago is the worse of the two mistakes.
    writeCachedRoster(PROJECT, [person()]);
    writeCachedRoster(PROJECT, []);
    expect(readCachedRoster(PROJECT)).toHaveLength(1);
  });

  it('clears only when asked to', () => {
    writeCachedRoster(PROJECT, [person()]);
    clearCachedRoster(PROJECT);
    expect(readCachedRoster(PROJECT)).toEqual([]);
  });
});

describe('a cache it cannot read is not a cache it throws away', () => {
  it('survives a value that is not JSON', () => {
    window.localStorage.setItem(rosterStorageKey(PROJECT), 'not json');
    expect(readCachedRoster(PROJECT)).toEqual([]);
  });

  it('survives JSON that is not an array', () => {
    window.localStorage.setItem(rosterStorageKey(PROJECT), '{"id":"r-1"}');
    expect(readCachedRoster(PROJECT)).toEqual([]);
  });

  it('drops rows with no id, because a row with no id is the defect', () => {
    // A nameless or idless row would be offered as a choice and add a member
    // carrying nothing, which is exactly the state the picker exists to stop.
    window.localStorage.setItem(
      rosterStorageKey(PROJECT),
      JSON.stringify([person(), { name: 'no id' }, { id: '', name: 'blank id' }, null, 'row']),
    );
    expect(readCachedRoster(PROJECT).map((r) => r.id)).toEqual(['r-1']);
  });

  it('fills in the fields a thinner server row leaves out', () => {
    window.localStorage.setItem(
      rosterStorageKey(PROJECT),
      JSON.stringify([{ id: 'r-9', name: 'Lean Row' }]),
    );
    const row = readCachedRoster(PROJECT)[0];
    expect(row?.code).toBe('');
    expect(row?.resource_type).toBe('person');
  });

  it('does not throw when storage refuses to write', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      expect(() => writeCachedRoster(PROJECT, [person()])).not.toThrow();
    } finally {
      setItem.mockRestore();
    }
  });
});

describe('the list does not offer somebody who is already on it', () => {
  it('hides a person already added', () => {
    const roster = [person(), person({ id: 'r-2', name: 'B. Worker' })];
    const left = availableRoster(roster, [{ resourceId: 'r-1' }]);
    expect(left.map((r) => r.id)).toEqual(['r-2']);
  });

  it('ignores typed rows, which claim nobody', () => {
    // A typed name has no id. It must not knock anybody off the pick list,
    // otherwise typing "Jan" once would hide the real Jan from the register.
    const roster = [person()];
    expect(availableRoster(roster, [{ resourceId: '' }])).toHaveLength(1);
  });

  it('leaves the whole list when nobody is added yet', () => {
    const roster = [person(), person({ id: 'r-2' })];
    expect(availableRoster(roster, [])).toHaveLength(2);
  });
});
