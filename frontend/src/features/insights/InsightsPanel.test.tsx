// @ts-nocheck
/**
 * The Insights panel must never draw figures the project does not have.
 *
 * The panel used to fall back to invented rows when a module held no records
 * and label them with a "Sample data" badge. A badge is not enough: a chart of
 * made-up numbers still reads as if the project already held that work, and
 * screenshots of it end up in public material. The panel now shows nothing.
 *
 * The load-bearing assertion is the third one. Checking that an empty-state
 * message appears would also pass if the sample figures were merely hidden
 * behind it, so instead we assert a value unique to the sample rows is absent
 * from the DOM entirely.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Partial mock: the app's i18n bootstrap imports initReactI18next from here,
// so replacing the whole module breaks the import chain before any test runs.
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, opts?: unknown) => {
        if (typeof opts === 'string') return opts;
        if (opts && typeof opts === 'object' && 'defaultValue' in (opts as Record<string, unknown>)) {
          return (opts as { defaultValue: string }).defaultValue;
        }
        return key;
      },
    }),
  };
});

import { InsightsPanel } from './InsightsPanel';

/** A distinctive number so its presence in the DOM cannot be a coincidence. */
const SAMPLE_ONLY_VALUE = 424242;
const REAL_ONLY_VALUE = 1717;

const fields = [
  { key: 'trade', label: 'Trade', kind: 'dimension' as const },
  { key: 'amount', label: 'Amount', kind: 'measure' as const, format: 'number' as const },
];

const builtins = [
  { id: 'k1', title: 'Total amount', datasetId: 'ds', chart: 'kpi' as const, measure: 'amount', agg: 'sum' as const, builtin: true },
  { id: 'c1', title: 'By trade', datasetId: 'ds', chart: 'bar' as const, dimension: 'trade', measure: 'amount', agg: 'sum' as const, builtin: true },
];

function renderPanel(datasets, onCollapse = vi.fn()) {
  return render(
    <InsightsPanel
      open
      datasets={datasets}
      builtins={builtins}
      custom={[]}
      onAdd={vi.fn()}
      onUpdate={vi.fn()}
      onRemove={vi.fn()}
      onCollapse={onCollapse}
    />,
  );
}

const sampleDataset = [
  {
    id: 'ds',
    label: 'Rows',
    rows: [{ trade: 'Groundworks', amount: SAMPLE_ONLY_VALUE }],
    fields,
    sample: true,
  },
];

const realDataset = [
  {
    id: 'ds',
    label: 'Rows',
    rows: [{ trade: 'Groundworks', amount: REAL_ONLY_VALUE }],
    fields,
  },
];

describe('InsightsPanel', () => {
  it('says there is nothing to chart when the only rows are samples', () => {
    renderPanel(sampleDataset);
    expect(screen.getByText('No data to chart yet')).toBeTruthy();
  });

  it('says the same when a real dataset is simply empty', () => {
    renderPanel([{ id: 'ds', label: 'Rows', rows: [], fields }]);
    expect(screen.getByText('No data to chart yet')).toBeTruthy();
  });

  it('does not render the sample figures anywhere, not even hidden', () => {
    const { container } = renderPanel(sampleDataset);
    // Any formatting of the number, with or without separators.
    expect(container.innerHTML).not.toContain('424242');
    expect(container.innerHTML).not.toContain('424,242');
    expect(container.innerHTML).not.toContain('Groundworks');
    // The chart titles must be gone too, not merely their values.
    expect(screen.queryByText('Total amount')).toBeNull();
    expect(screen.queryByText('By trade')).toBeNull();
  });

  it('refuses to open the builder when there is no real data to build from', () => {
    renderPanel(sampleDataset);
    const button = screen.getByRole('button', { name: /New chart/i });
    expect(button.hasAttribute('disabled')).toBe(true);
  });

  it('still draws the built-ins when the rows are real', () => {
    renderPanel(realDataset);
    expect(screen.queryByText('No data to chart yet')).toBeNull();
    expect(screen.getByText('Total amount')).toBeTruthy();
    expect(screen.getByText('By trade')).toBeTruthy();
  });
});

describe('InsightsPanel collapse control', () => {
  it('closes the panel through the caller, never on its own', () => {
    const onCollapse = vi.fn();
    renderPanel(realDataset, onCollapse);
    const footer = screen.getByRole('button', { name: /Collapse insights/i });
    fireEvent.click(footer);
    expect(onCollapse).toHaveBeenCalledTimes(1);
    // The page owns open/hide so the header toggle and this control cannot
    // drift apart. A panel that hid itself would leave that toggle claiming
    // the panel is open, which is the bug this assertion exists to prevent.
    expect(screen.getByText('Total amount')).toBeTruthy();
  });

  it('offers the control on an empty panel too', () => {
    // The emptier the panel, the more a reader wants it out of the way, so the
    // footer must not be tied to there being charts to show.
    renderPanel(sampleDataset);
    expect(screen.getByRole('button', { name: /Collapse insights/i })).toBeTruthy();
  });

  it('renders nothing at all once the caller reports it closed', () => {
    const { container } = render(
      <InsightsPanel
        open={false}
        datasets={realDataset}
        builtins={builtins}
        custom={[]}
        onAdd={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
        onCollapse={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
