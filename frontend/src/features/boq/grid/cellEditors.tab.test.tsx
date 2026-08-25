/**
 * Tab out of an editable BOQ cell.
 *
 * Reported against 14.5.0: tabbing through item reference, description and
 * unit works, but the moment Tab lands on quantity the cell blinks and stops
 * being editable, and only a mouse click reopens it.
 *
 * The defect was in the editor being LEFT, not the one being entered.
 * ``UnitCellEditor`` committed on Tab without cancelling the keystroke, so the
 * same Tab was also processed by ag-grid's own Tab-during-edit path: the grid
 * advanced twice, and with ``stopEditingWhenCellsLoseFocus`` on, the second
 * advance tore down the quantity popup the first had just opened. Every other
 * branch of that handler already called preventDefault, which is why no other
 * hop reproduced it, and why a mouse click - a path with no keystroke in it -
 * always worked.
 *
 * Cancelling the keystroke also removes the grid's own move, so each editor
 * has to make the move itself, in the direction the modifier asked for. These
 * tests pin both halves for all three custom editors, because a fix that
 * cancels the default and then always walks forward would turn a broken
 * Shift+Tab into a silent one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';

import { FormulaCellEditor, RateCellEditor, UnitCellEditor } from './cellEditors';
import type { FormulaCellEditorParams } from './cellEditors';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { useDisplayQuantity, type DisplayQuantityApi } from '@/shared/hooks/useDisplayQuantity';

// The editors take the display API from grid context. Metric is identity for
// every conversion here, which keeps these tests about keyboard handling.
function metricApi(): DisplayQuantityApi {
  usePreferencesStore.getState().setPreference('measurementSystem', 'metric');
  let api!: DisplayQuantityApi;
  function Probe() {
    api = useDisplayQuantity();
    return null;
  }
  render(<Probe />);
  cleanup();
  return api;
}

function mockApi() {
  return {
    stopEditing: vi.fn(),
    tabToNextCell: vi.fn(),
    tabToPreviousCell: vi.fn(),
  };
}

describe('Tab out of the unit cell - the hop that broke quantity', () => {
  beforeEach(() => cleanup());

  function renderUnit() {
    const api = mockApi();
    const setDataValue = vi.fn();
    const params = {
      value: 'm2',
      data: { unit: 'm2' },
      node: { data: { unit: 'm2' }, setDataValue },
      api,
      column: { getColId: () => 'unit' },
    } as unknown as FormulaCellEditorParams;
    render(<UnitCellEditor {...params} />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    return { input, api, setDataValue };
  }

  it('cancels the Tab keystroke so ag-grid does not advance a second time', () => {
    const { input } = renderUnit();
    // fireEvent.keyDown returns false when a handler called preventDefault.
    // That single bit is the whole bug: uncancelled, the grid ran its own Tab
    // handling on top of ours and closed the editor it had just opened.
    const notCancelled = fireEvent.keyDown(input, { key: 'Tab' });
    expect(notCancelled).toBe(false);
  });

  it('makes the forward move itself, since the default one is now cancelled', () => {
    const { input, api } = renderUnit();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(api.tabToNextCell).toHaveBeenCalledTimes(1);
    expect(api.tabToPreviousCell).not.toHaveBeenCalled();
  });

  it('walks backwards on Shift+Tab rather than forwards', () => {
    const { input, api } = renderUnit();
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true });
    expect(api.tabToPreviousCell).toHaveBeenCalledTimes(1);
    expect(api.tabToNextCell).not.toHaveBeenCalled();
  });

  it('still commits the typed value on the way out', () => {
    const { input, setDataValue } = renderUnit();
    fireEvent.change(input, { target: { value: 'm3' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(setDataValue).toHaveBeenCalledWith('unit', 'm3');
  });
});

describe('Tab direction in the two numeric editors', () => {
  beforeEach(() => cleanup());

  function renderQty() {
    const api = mockApi();
    const params = {
      value: 4,
      data: { unit: 'm2' },
      context: { displayQuantity: metricApi() },
      node: { data: { unit: 'm2', quantity: 4 }, setDataValue: vi.fn() },
      api,
      column: { getColId: () => 'quantity' },
    } as unknown as FormulaCellEditorParams;
    render(<FormulaCellEditor {...params} />);
    return { input: screen.getByRole('textbox') as HTMLInputElement, api };
  }

  function renderRate() {
    const api = mockApi();
    const params = {
      value: 50,
      data: { unit: 'm' },
      context: { displayQuantity: metricApi() },
      node: { data: { unit: 'm', unit_rate: 50 }, setDataValue: vi.fn() },
      api,
      column: { getColId: () => 'unit_rate' },
    } as unknown as FormulaCellEditorParams;
    render(<RateCellEditor {...params} />);
    return { input: screen.getByRole('textbox') as HTMLInputElement, api };
  }

  // Both attach native listeners rather than React synthetic ones, because the
  // synthetic handler does not fire inside ag-grid's popup root. So the event
  // has to be dispatched on the node, not through React's system.
  function nativeTab(input: HTMLInputElement, shiftKey: boolean) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }));
  }

  it('quantity walks forward on Tab and backward on Shift+Tab', () => {
    const fwd = renderQty();
    nativeTab(fwd.input, false);
    expect(fwd.api.tabToNextCell).toHaveBeenCalledTimes(1);
    cleanup();
    const back = renderRate();
    nativeTab(back.input, true);
    expect(back.api.tabToPreviousCell).toHaveBeenCalledTimes(1);
    expect(back.api.tabToNextCell).not.toHaveBeenCalled();
  });

  it('rate walks backward on Shift+Tab', () => {
    const { input, api } = renderRate();
    nativeTab(input, true);
    expect(api.tabToPreviousCell).toHaveBeenCalledTimes(1);
    expect(api.tabToNextCell).not.toHaveBeenCalled();
  });
});
