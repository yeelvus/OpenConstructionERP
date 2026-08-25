import { describe, it, expect, vi } from 'vitest';

import en from '../../../app/locales/en';
import de from '../../../app/locales/de';

// displayGroupName resolves through the app i18n singleton; route it at the
// real English dictionary so the test exercises the actual key wiring rather
// than a private copy of the map (a mock dictionary would only prove the test
// agrees with itself).
vi.mock('@/app/i18n', () => ({
  default: {
    t: (key: string, opts?: { defaultValue?: string }) =>
      (en as { translation: Record<string, string> }).translation[key] ?? opts?.defaultValue ?? key,
  },
}));

import { displayGroupName } from '../lib/group-labels';

const GROUP_KEYS = [
  'takeoff_viewer.group_general',
  'takeoff_viewer.group_structural',
  'takeoff_viewer.group_electrical',
  'takeoff_viewer.group_plumbing',
  'takeoff_viewer.group_hvac',
  'takeoff_viewer.group_finishing',
  'takeoff_viewer.group_excavation',
  'takeoff_viewer.group_concrete',
];

describe('displayGroupName', () => {
  it('renders canonical built-in names through i18n (English keeps the canon)', () => {
    expect(displayGroupName('General')).toBe('General');
    expect(displayGroupName('Structural')).toBe('Structural');
    expect(displayGroupName('HVAC')).toBe('HVAC');
  });

  it('leaves user-created group names verbatim', () => {
    expect(displayGroupName('Fenster')).toBe('Fenster');
    expect(displayGroupName('My Custom Group')).toBe('My Custom Group');
    expect(displayGroupName('')).toBe('');
  });

  it('every built-in group key exists in en and de', () => {
    const enDict = (en as { translation: Record<string, string> }).translation;
    const deDict = (de as { translation: Record<string, string> }).translation;
    for (const key of GROUP_KEYS) {
      expect(enDict[key], `${key} missing in en`).toBeTruthy();
      expect(deDict[key], `${key} missing in de`).toBeTruthy();
    }
  });

  it('German trades are actually translated, not copied English', () => {
    const deDict = (de as { translation: Record<string, string> }).translation;
    expect(deDict['takeoff_viewer.group_general']).toBe('Allgemein');
    expect(deDict['takeoff_viewer.group_plumbing']).toBe('Sanitär');
    // HLK is the German trade abbreviation replacing HVAC.
    expect(deDict['takeoff_viewer.group_hvac']).toBe('HLK');
  });
});
