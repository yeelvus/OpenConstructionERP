import { describe, expect, it, beforeEach } from 'vitest';
import { persistFieldSession, readFieldSession } from './fieldApi';

/**
 * The field shell reads the session during render and re-renders on every sync
 * tick. A fresh object per read would restart every effect keyed on it, and the
 * crew roster would refetch on a loop over the connection this screen exists to
 * work without. Identity is therefore part of the contract, not an accident.
 */
describe('readFieldSession identity', () => {
  beforeEach(() => {
    sessionStorage.clear();
    // Drop the cached object between tests: a stale identity from a previous
    // test would make the "changed session" case pass for the wrong reason.
    readFieldSession();
  });

  it('hands back the same object while nothing has changed', () => {
    persistFieldSession({ token: 't', pin: '1234', projectId: 'p1', userId: 'u1' });
    const first = readFieldSession();
    const second = readFieldSession();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('hands back a new object once a stored value changes', () => {
    persistFieldSession({ token: 't', pin: '1234', projectId: 'p1', userId: 'u1' });
    const first = readFieldSession();
    persistFieldSession({ token: 't', pin: '1234', projectId: 'p2', userId: 'u1' });
    const second = readFieldSession();
    expect(second).not.toBe(first);
    expect(second?.projectId).toBe('p2');
  });

  it('returns null when the session is gone, and does not resurrect the old one', () => {
    persistFieldSession({ token: 't', pin: '1234', projectId: 'p1', userId: 'u1' });
    expect(readFieldSession()).not.toBeNull();
    sessionStorage.clear();
    expect(readFieldSession()).toBeNull();

    // Signing back in on a different project must not hand out the cached object.
    persistFieldSession({ token: 't', pin: '1234', projectId: 'p1', userId: 'u1' });
    const back = readFieldSession();
    expect(back?.projectId).toBe('p1');
    expect(readFieldSession()).toBe(back);
  });
});
