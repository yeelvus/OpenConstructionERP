// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * An open shift has to survive the phone going into a pocket.
 *
 * The punch-in is the one thing on this screen that is not a mutation: the
 * hours are unknown until the shift ends, so nothing is queued and the sync
 * badge shows nothing pending. That made the loss invisible twice over - the
 * shift vanished, and every indicator the worker had said all was well.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStoredCrew,
  crewStorageKey,
  readStoredCrew,
  shiftDate,
  writeStoredCrew,
  type CrewMember,
} from './crewShiftStore';

const PROJECT = 'p-1';

function member(overrides: Partial<CrewMember> = {}): CrewMember {
  return {
    id: 'm-1',
    name: 'A. Worker',
    task: 'concrete',
    startedAt: null,
    resourceId: 'res-1',
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('an open shift survives a reload', () => {
  it('reads back a punched-in member', () => {
    const open = member({ startedAt: '2026-08-11T06:00:00.000Z' });
    writeStoredCrew(PROJECT, [open]);

    const restored = readStoredCrew(PROJECT);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.startedAt).toBe('2026-08-11T06:00:00.000Z');
  });

  it('keeps projects apart', () => {
    writeStoredCrew(PROJECT, [member({ name: 'Ours' })]);
    expect(readStoredCrew('p-2')).toEqual([]);
  });

  it('answers empty for a project that has never had a roster', () => {
    expect(readStoredCrew(PROJECT)).toEqual([]);
  });

  it('ignores a project id it cannot key on', () => {
    // The shell knows the token before it knows the project, so this state is
    // reached on every cold start, not only on a broken link.
    writeStoredCrew('', [member()]);
    expect(readStoredCrew('')).toEqual([]);
    // Asserted through getItem rather than the store's length, which this
    // environment does not implement: the point is that nothing was filed
    // under a key that would never be read back.
    expect(window.localStorage.getItem(crewStorageKey(''))).toBeNull();
  });
});

describe('a roster it cannot read is not a roster it throws away', () => {
  it('survives a value that is not JSON', () => {
    window.localStorage.setItem(crewStorageKey(PROJECT), 'not json at all');
    expect(readStoredCrew(PROJECT)).toEqual([]);
  });

  it('survives JSON that is not an array', () => {
    window.localStorage.setItem(crewStorageKey(PROJECT), '{"id":"m-1"}');
    expect(readStoredCrew(PROJECT)).toEqual([]);
  });

  it('drops only the rows that changed shape', () => {
    // The point of the filter: a build that renamed a field should cost the
    // worker those rows, not the shift they are currently standing in.
    const good = member({ id: 'keep', startedAt: '2026-08-11T06:00:00.000Z' });
    window.localStorage.setItem(
      crewStorageKey(PROJECT),
      JSON.stringify([good, { id: 'no-name' }, null, 'string row', { name: 'no id' }]),
    );

    const restored = readStoredCrew(PROJECT);
    expect(restored.map((m) => m.id)).toEqual(['keep']);
  });

  it('does not throw when storage refuses to write', () => {
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
    try {
      expect(() => writeStoredCrew(PROJECT, [member()])).not.toThrow();
    } finally {
      setItem.mockRestore();
    }
  });

  it('clears a roster when asked', () => {
    writeStoredCrew(PROJECT, [member()]);
    clearStoredCrew(PROJECT);
    expect(readStoredCrew(PROJECT)).toEqual([]);
  });
});

describe('a shift belongs to the day it started', () => {
  it('files a night shift against the day it began', () => {
    // 22:00 local on the 10th. Filing it under the 11th, the day the worker
    // punched out, would show nobody on site on the day they worked.
    const startedAt = new Date(2026, 7, 10, 22, 0, 0).toISOString();
    expect(shiftDate(startedAt, '2026-08-11')).toBe('2026-08-10');
  });

  it('files an ordinary day shift against that same day', () => {
    const startedAt = new Date(2026, 7, 11, 7, 30, 0).toISOString();
    expect(shiftDate(startedAt, '2026-08-11')).toBe('2026-08-11');
  });

  it('falls back rather than inventing a date it cannot parse', () => {
    expect(shiftDate('yesterday sometime', '2026-08-11')).toBe('2026-08-11');
  });
});

describe('a roster written before the picker existed', () => {
  it('keeps rows that have no resource id and normalises the field', () => {
    // Written by the build that shipped before the register picker. The row is
    // a real open shift; dropping it would end somebody's day for them.
    window.localStorage.setItem(
      crewStorageKey(PROJECT),
      JSON.stringify([
        { id: 'old-1', name: 'Typed Name', task: 'concrete', startedAt: '2026-08-11T06:00:00.000Z' },
      ]),
    );

    const restored = readStoredCrew(PROJECT);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.name).toBe('Typed Name');
    expect(restored[0]?.resourceId).toBe('');
  });

  it('keeps the id when one was stored', () => {
    writeStoredCrew(PROJECT, [member({ resourceId: 'res-42' })]);
    expect(readStoredCrew(PROJECT)[0]?.resourceId).toBe('res-42');
  });
});
