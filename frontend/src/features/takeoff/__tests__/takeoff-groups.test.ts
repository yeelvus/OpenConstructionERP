// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
import { describe, it, expect } from 'vitest';
import {
  computeGroupSummaries,
  formatGroupTotal,
  ANNOTATION_TYPES,
} from '../lib/takeoff-groups';
import type { Measurement } from '../lib/takeoff-types';

const GROUP_COLORS: Record<string, string> = {
  General: '#3B82F6',
  Structural: '#EF4444',
  Electrical: '#F59E0B',
};

function m(partial: Partial<Measurement>): Measurement {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    type: partial.type ?? 'distance',
    points: partial.points ?? [],
    value: partial.value ?? 0,
    unit: partial.unit ?? 'm',
    label: partial.label ?? '',
    annotation: partial.annotation ?? '',
    page: partial.page ?? 1,
    group: partial.group ?? 'General',
    ...partial,
  };
}

describe('computeGroupSummaries', () => {
  it('returns one row per group present', () => {
    const measurements = [
      m({ group: 'General', value: 1 }),
      m({ group: 'Structural', value: 2 }),
    ];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.name).sort()).toEqual(['General', 'Structural']);
  });

  it('sums total value per group', () => {
    const measurements = [
      m({ group: 'Structural', value: 5, unit: 'm' }),
      m({ group: 'Structural', value: 10, unit: 'm' }),
      m({ group: 'Structural', value: 3, unit: 'm' }),
    ];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result).toHaveLength(1);
    expect(result[0]!.total).toBe(18);
    expect(result[0]!.count).toBe(3);
  });

  it('applies the color map', () => {
    const measurements = [m({ group: 'Structural', value: 1 })];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result[0]!.color).toBe('#EF4444');
  });

  it('falls back to default color for unknown groups', () => {
    const measurements = [m({ group: 'CustomGroup', value: 1 })];
    const result = computeGroupSummaries(measurements, GROUP_COLORS, '#999999');
    expect(result[0]!.color).toBe('#999999');
  });

  it('excludes annotation types from total but counts them', () => {
    const measurements = [
      m({ group: 'General', value: 10, type: 'distance' }),
      m({ group: 'General', value: 5, type: 'cloud' }), // annotation
      m({ group: 'General', value: 2, type: 'rectangle' }), // annotation
    ];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result).toHaveLength(1);
    expect(result[0]!.count).toBe(3);
    // Only the distance (10) contributes to total; cloud/rectangle are annotations.
    expect(result[0]!.total).toBe(10);
  });

  it('picks the most common unit', () => {
    const measurements = [
      m({ group: 'General', value: 1, unit: 'm' }),
      m({ group: 'General', value: 1, unit: 'm' }),
      m({ group: 'General', value: 1, unit: 'm2' }),
    ];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result[0]!.unit).toBe('m');
  });

  it('subtracts opening deductions from the group total (net area)', () => {
    const measurements = [
      m({ group: 'Floors', value: 40, unit: 'm²', type: 'area' }),
      m({ group: 'Floors', value: 3, unit: 'm²', type: 'area', isDeduction: true }),
      m({ group: 'Floors', value: 1, unit: 'm²', type: 'area', isDeduction: true }),
    ];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result[0]!.total).toBeCloseTo(36, 6); // 40 - 3 - 1
    expect(result[0]!.count).toBe(3);
  });

  it('rolls up the effective quantity (slope + multiplier) in the legend total', () => {
    const measurements = [
      // Sloped roof: 10 m2 plan x 1.5 = 15 m2 true surface.
      m({ group: 'Roof', value: 10, unit: 'm²', type: 'area', slopeFactor: 1.5 }),
      // Typical bay counted 3x: 4 x 3 = 12.
      m({ group: 'Roof', value: 4, unit: 'm²', type: 'area', multiplier: 3 }),
    ];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result[0]!.total).toBeCloseTo(15 + 12, 6);
  });

  it('defaults group name to General when blank', () => {
    const measurements = [m({ group: '', value: 1 })];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result[0]!.name).toBe('General');
  });

  it('returns empty array for no measurements', () => {
    expect(computeGroupSummaries([], GROUP_COLORS)).toEqual([]);
  });

  // Audit case-2 K-14: a windows/doors group is whole pieces, not a
  // measured figure - the legend must know so it can skip the ladder.
  it('marks a group as count-only when every quantity is a count', () => {
    const measurements = [
      m({ group: 'Windows', value: 17, unit: 'pcs', type: 'count' }),
      m({ group: 'Windows', value: 4, unit: 'pcs', type: 'count' }),
    ];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result[0]!.isCount).toBe(true);
  });

  it('does not mark mixed or measured groups as count-only', () => {
    const mixed = computeGroupSummaries(
      [
        m({ group: 'Mixed', value: 17, unit: 'pcs', type: 'count' }),
        m({ group: 'Mixed', value: 3.5, unit: 'm', type: 'distance' }),
      ],
      GROUP_COLORS,
    );
    expect(mixed[0]!.isCount).toBe(false);
    const measured = computeGroupSummaries(
      [m({ group: 'Floors', value: 12.5, unit: 'm²', type: 'area' })],
      GROUP_COLORS,
    );
    expect(measured[0]!.isCount).toBe(false);
    // Annotation-only groups have no quantity at all - not "count-only".
    const annotations = computeGroupSummaries(
      [m({ group: 'Notes', value: 0, type: 'cloud' })],
      GROUP_COLORS,
    );
    expect(annotations[0]!.isCount).toBe(false);
  });

  it('returns summaries in stable (alphabetical) order', () => {
    const measurements = [
      m({ group: 'Structural', value: 1 }),
      m({ group: 'Electrical', value: 1 }),
      m({ group: 'General', value: 1 }),
    ];
    const result = computeGroupSummaries(measurements, GROUP_COLORS);
    expect(result.map((r) => r.name)).toEqual([
      'Electrical',
      'General',
      'Structural',
    ]);
  });
});

describe('formatGroupTotal', () => {
  it('formats small numbers with 3 decimals', () => {
    expect(formatGroupTotal(0.123, 'm', 'en')).toBe('0.123 m');
  });

  it('formats medium numbers with 2 decimals', () => {
    expect(formatGroupTotal(12.345, 'm', 'en')).toBe('12.35 m');
  });

  it('formats large numbers with 1 decimal and grouping', () => {
    // Grouping matches the ledger/viewer (Intl with default grouping).
    expect(formatGroupTotal(1234.56, 'm', 'en')).toBe('1,234.6 m');
  });

  // Audit case-2 K-12 follow-up: the legend total must use the same
  // decimal separator as the measurement rows it sums - one frame held
  // "485.3 m²" directly above the "248,5 m²" rows.
  it('renders in the requested locale like the rows it sums', () => {
    expect(formatGroupTotal(485.3, 'm²', 'de')).toBe('485,3 m²');
    expect(formatGroupTotal(96.4, 'm²', 'de')).toBe('96,40 m²');
  });

  it('keeps the trailing zero of its precision tier', () => {
    // The old Number(toFixed()) wrapper dropped it, so the legend lost a
    // digit relative to the ledger ("96.40" row vs "96.4" total).
    expect(formatGroupTotal(96.4, 'm²', 'en')).toBe('96.40 m²');
  });

  it('omits unit when empty', () => {
    expect(formatGroupTotal(5, '', 'en')).toBe('5.00');
  });

  it('renders zero as a bare 0', () => {
    expect(formatGroupTotal(0, 'm', 'en')).toBe('0 m');
  });

  // Audit case-2 K-14: "17,00 pcs" gave whole pieces a fraction. Count
  // totals bypass the decimal ladder in every locale.
  it('renders count totals as whole pieces', () => {
    expect(formatGroupTotal(17, 'Stk', 'de', true)).toBe('17 Stk');
    expect(formatGroupTotal(17, 'pcs', 'en', true)).toBe('17 pcs');
    // Without the flag the ladder would print 17.00.
    expect(formatGroupTotal(17, 'pcs', 'en')).toBe('17.00 pcs');
  });
});

describe('ANNOTATION_TYPES', () => {
  it('includes all decorative tool types', () => {
    expect(ANNOTATION_TYPES.has('cloud')).toBe(true);
    expect(ANNOTATION_TYPES.has('arrow')).toBe(true);
    expect(ANNOTATION_TYPES.has('text')).toBe(true);
    expect(ANNOTATION_TYPES.has('rectangle')).toBe(true);
    expect(ANNOTATION_TYPES.has('highlight')).toBe(true);
  });

  it('excludes measurement tool types', () => {
    expect(ANNOTATION_TYPES.has('distance')).toBe(false);
    expect(ANNOTATION_TYPES.has('area')).toBe(false);
    expect(ANNOTATION_TYPES.has('volume')).toBe(false);
  });
});
