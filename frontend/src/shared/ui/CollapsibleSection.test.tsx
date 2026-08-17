/**
 * Tests for CollapsibleSection, the "How this module fits together" explainer
 * block used once per page on 33 module pages.
 *
 * Behaviour under test (the 2026-07-26 contract):
 *   - open by default: header and body both render
 *   - clicking the header collapses the block to NOTHING in the page, and
 *     registers it in useModuleInfoStore so the pill next to the Cases button
 *     brings it back
 *   - the store's expand entry re-expands and unregisters
 *   - the choice persists under `oce.collapse.<storageKey>` and is read back
 *   - the registry key is namespaced `section:<storageKey>`, so an info card on
 *     the same page using the same string does not unregister this block
 *   - unmount (navigation) unregisters
 *
 * ``window.localStorage`` is mocked globally in ``src/test/setup.ts`` as an
 * in-memory store with a working ``clear()``.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { CollapsibleSection } from './CollapsibleSection';
import { useModuleInfoStore } from '@/stores/useModuleInfoStore';

const KEY = 'crm.how';
const LS_KEY = `oce.collapse.${KEY}`;

function renderSection(storageKey = KEY) {
  return render(
    <CollapsibleSection storageKey={storageKey} title="How the CRM fits together">
      <p>Leads become opportunities, opportunities become bids.</p>
    </CollapsibleSection>,
  );
}

/** The registry the top-bar re-open icon reads. */
function storeEntries() {
  return useModuleInfoStore.getState().entries;
}

beforeEach(() => {
  window.localStorage.clear();
  useModuleInfoStore.setState({ entries: [] });
});

describe('CollapsibleSection', () => {
  it('renders open by default with header and body, registering nothing', () => {
    renderSection();
    expect(screen.getByText('How the CRM fits together')).toBeInTheDocument();
    expect(
      screen.getByText('Leads become opportunities, opportunities become bids.'),
    ).toBeInTheDocument();
    expect(document.querySelector('[aria-expanded="true"]')).toBeInTheDocument();
    // Nothing collapsed -> the re-open pill stays hidden.
    expect(storeEntries()).toHaveLength(0);
  });

  it('collapsing leaves NOTHING in the page and hands the block to the pill', () => {
    const { container } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: /How the CRM fits together/ }));

    // The whole block goes, header included - the way back is the pill next to
    // the Cases button, not a leftover strip on the page.
    expect(screen.queryByText('How the CRM fits together')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Leads become opportunities, opportunities become bids.'),
    ).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();

    expect(storeEntries()).toHaveLength(1);
    expect(storeEntries()[0]!.key).toBe(`section:${KEY}`);
    expect(window.localStorage.getItem(LS_KEY)).toBe('1');
  });

  it('the store expand entry (the pill) re-expands and unregisters', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /How the CRM fits together/ }));
    expect(storeEntries()).toHaveLength(1);

    act(() => useModuleInfoStore.getState().expandAll());

    expect(
      screen.getByText('Leads become opportunities, opportunities become bids.'),
    ).toBeInTheDocument();
    expect(storeEntries()).toHaveLength(0);
    expect(window.localStorage.getItem(LS_KEY)).toBe('0');
  });

  it('a stored collapsed choice is honoured on the next visit', () => {
    window.localStorage.setItem(LS_KEY, '1');
    const { container } = renderSection();

    expect(container.firstChild).toBeNull();
    expect(storeEntries()).toHaveLength(1);
  });

  it('namespaces its registry key so an info card on the same key survives', () => {
    // DismissibleInfo registers under the BARE storage key. If this block used
    // the bare key too, one would silently unregister the other and the pill
    // would bring back only half the page.
    useModuleInfoStore.getState().register({ key: KEY, expand: () => {} });
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /How the CRM fits together/ }));

    const keys = storeEntries().map((e) => e.key).sort();
    expect(keys).toEqual([KEY, `section:${KEY}`]);
  });

  it('unmount while collapsed unregisters (navigation away)', () => {
    window.localStorage.setItem(LS_KEY, '1');
    const { unmount } = renderSection();
    expect(storeEntries()).toHaveLength(1);
    unmount();
    expect(storeEntries()).toHaveLength(0);
  });

  it('two blocks with different keys stay independent', () => {
    render(
      <>
        <CollapsibleSection storageKey="a.how" title="Block A">
          <p>Body A</p>
        </CollapsibleSection>
        <CollapsibleSection storageKey="b.how" title="Block B">
          <p>Body B</p>
        </CollapsibleSection>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Block A/ }));

    expect(screen.queryByText('Block A')).not.toBeInTheDocument();
    expect(screen.getByText('Block B')).toBeInTheDocument();
    expect(storeEntries()).toHaveLength(1);
    expect(storeEntries()[0]!.key).toBe('section:a.how');
  });
});
