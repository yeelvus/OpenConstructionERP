// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
import { describe, expect, it } from 'vitest';
import {
  formatDms,
  looksLikeCoordinatePair,
  parseCoordinates,
} from './parseCoordinates';

describe('parseCoordinates', () => {
  it('parses classic DMS paste (user example)', () => {
    const r = parseCoordinates(`13°35'37.60"N 100°57'48.38"E`);
    expect(r).not.toBeNull();
    expect(r!.format).toBe('dms');
    expect(r!.lat).toBeCloseTo(13 + 35 / 60 + 37.6 / 3600, 6);
    expect(r!.lng).toBeCloseTo(100 + 57 / 60 + 48.38 / 3600, 6);
  });

  it('parses DMS with comma separator and fancy quotes', () => {
    const r = parseCoordinates(`13°35′37.60″N, 100°57′48.38″E`);
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(13.5937778, 5);
    expect(r!.lng).toBeCloseTo(100.9634389, 5);
  });

  it('parses hemisphere-first DMS', () => {
    const r = parseCoordinates(`N13°35'37.60" E100°57'48.38"`);
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(13.5937778, 5);
    expect(r!.lng).toBeCloseTo(100.9634389, 5);
  });

  it('parses southern / western hemispheres', () => {
    const r = parseCoordinates(`33°52'0"S 151°12'0"W`);
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(-33.8666667, 4);
    expect(r!.lng).toBeCloseTo(-151.2, 4);
  });

  it('parses decimal pair', () => {
    const r = parseCoordinates('13.59378, 100.96344');
    expect(r).toEqual({
      lat: 13.59378,
      lng: 100.96344,
      format: 'decimal',
    });
  });

  it('parses space-separated decimals', () => {
    const r = parseCoordinates('13.59378 100.96344');
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(13.59378, 5);
    expect(r!.lng).toBeCloseTo(100.96344, 5);
  });

  it('returns null for garbage', () => {
    expect(parseCoordinates('hello world')).toBeNull();
    expect(parseCoordinates('')).toBeNull();
    expect(parseCoordinates('99°00\'00"N 200°00\'00"E')).toBeNull();
  });

  it('round-trips via formatDms', () => {
    const lat = 13 + 35 / 60 + 37.6 / 3600;
    const lng = 100 + 57 / 60 + 48.38 / 3600;
    const s = formatDms(lat, lng, 2);
    const r = parseCoordinates(s);
    expect(r).not.toBeNull();
    expect(r!.lat).toBeCloseTo(lat, 4);
    expect(r!.lng).toBeCloseTo(lng, 4);
  });
});

describe('looksLikeCoordinatePair', () => {
  it('detects DMS and decimal pairs', () => {
    expect(looksLikeCoordinatePair(`13°35'37.60"N 100°57'48.38"E`)).toBe(true);
    expect(looksLikeCoordinatePair('13.5, 100.9')).toBe(true);
    expect(looksLikeCoordinatePair('just a city name')).toBe(false);
  });
});
