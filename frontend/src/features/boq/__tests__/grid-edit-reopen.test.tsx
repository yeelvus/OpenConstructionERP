// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Editor open → close → reopen lifecycle for the BOQ grid.
 *
 * Regression coverage for the "cell editor opens once, then never again"
 * defect: after the ordinal-editing rework (double-click / F2 only,
 * validation with revert + toast) a cell editor could be opened exactly one
 * time; every later double-click, click+Enter or F2 was refused. The
 * acceptance here is behavioural: open, close (Escape / commit / invalid
 * revert), and open again — on the same cell and on other cells.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { createElement, StrictMode } from 'react';

import BOQGrid from '../BOQGrid';
import type { Position } from '../api';

// Collab locks degrade silently in production when the service is down; in
// tests we resolve successfully so the acquire/release lifecycle runs.
vi.mock('@/features/collab_locks', () => ({
  acquireLock: vi.fn(async () => ({ ok: true, lock: { id: 'lock-test' } })),
  releaseLock: vi.fn(async () => undefined),
}));

// jsdom has no layout: AG Grid sizes its viewport from client rects, so give
// every element a viewport-sized box or the grid renders zero rows.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return 800; },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() { return 1600; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return 800; },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return 1600; },
  });
  HTMLElement.prototype.getBoundingClientRect = function () {
    return {
      width: 1600, height: 800, top: 0, left: 0, bottom: 800, right: 1600,
      x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect;
  };
  // jsdom always reports offsetParent as null; AG Grid's PopupService walks
  // it to position popup editors (description / quantity) and crashes on the
  // null. Report the parent element so popup editors can open.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return this.parentElement; },
  });
});

afterEach(() => {
  cleanup();
});

function makePosition(n: number): Position {
  return {
    id: `pos-${n}`,
    boq_id: 'boq-1',
    ordinal: `01.0${n}`,
    description: `Position ${n}`,
    unit: 'm2',
    quantity: 10 + n,
    unit_rate: 5 + n,
    total: (10 + n) * (5 + n),
    parent_id: null,
    position_type: 'position',
    validation_status: 'valid',
    metadata: {},
  } as unknown as Position;
}

const noop = () => undefined;

function renderGrid(overrides: Record<string, unknown> = {}, opts: { strict?: boolean } = {}) {
  const onUpdatePosition = vi.fn();
  const grid = createElement(BOQGrid, {
    positions: [makePosition(1), makePosition(2), makePosition(3)],
    onUpdatePosition,
    onDeletePosition: noop,
    onAddPosition: noop,
    onSelectSuggestion: noop,
    onSaveToDatabase: noop,
    onFormulaApplied: noop,
    collapsedSections: new Set<string>(),
    onToggleSection: noop,
    currencySymbol: '€',
    currencyCode: 'EUR',
    locale: 'de-DE',
    footerRows: [],
    ...overrides,
  });
  const utils = render(opts.strict ? createElement(StrictMode, null, grid) : grid);
  return { ...utils, onUpdatePosition };
}

/** The grid's editing state, straight from the DOM. */
function editingCells(): Element[] {
  return Array.from(document.querySelectorAll('.ag-cell-inline-editing, .ag-popup-editor'));
}

function cell(rowId: string, colId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `.ag-row[row-id="${rowId}"] .ag-cell[col-id="${colId}"]`,
  );
  if (!el) throw new Error(`cell ${rowId}/${colId} not rendered`);
  return el;
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

/** Poll a condition instead of guessing a delay - the full suite runs on
 *  starved parallel workers where a fixed 20ms is routinely not enough. */
async function waitUntil(cond: () => boolean, what: string, timeoutMs = 4000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await flush(25);
  }
}

async function openEditorByDoubleClick(rowId: string, colId: string) {
  const target = cell(rowId, colId);
  await act(async () => {
    fireEvent.mouseDown(target);
    fireEvent.mouseUp(target);
    fireEvent.click(target);
    fireEvent.mouseDown(target);
    fireEvent.mouseUp(target);
    fireEvent.click(target, { detail: 2 });
    fireEvent.doubleClick(target);
  });
  await flush(20);
}

/** Double-click and wait for an editor to be present. */
async function openAndAwaitEditor(rowId: string, colId: string, what: string) {
  await openEditorByDoubleClick(rowId, colId);
  await waitUntil(() => editingCells().length > 0, `${what}: editor open`);
}

function activeEditorInput(): HTMLInputElement | HTMLTextAreaElement | null {
  return document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    '.ag-cell-inline-editing input, .ag-cell-inline-editing textarea, .ag-popup-editor input, .ag-popup-editor textarea',
  );
}

describe('BOQ grid editor open/close/reopen lifecycle', () => {
  it('reopens the ordinal editor after Escape, on the same and other rows', async () => {
    renderGrid();
    await flush(50);

    // Sanity: the three position rows rendered.
    expect(document.querySelector('.ag-row[row-id="pos-1"]')).toBeTruthy();

    // 1st open — double-click row 1's ordinal.
    await openEditorByDoubleClick('pos-1', 'ordinal');
    expect(editingCells().length, 'first double-click must open an editor').toBeGreaterThan(0);
    let input = activeEditorInput();
    expect(input, 'editor input must exist').toBeTruthy();

    // Close with Escape (cancel).
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);
    expect(editingCells().length, 'Escape must close the editor').toBe(0);

    // 2nd open — same cell again.
    await openEditorByDoubleClick('pos-1', 'ordinal');
    expect(editingCells().length, 'same cell must reopen after Escape').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);

    // 3rd open — a different row.
    await openEditorByDoubleClick('pos-2', 'ordinal');
    expect(editingCells().length, 'another row must open after a previous edit').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);
  });

  it('reopens the ordinal editor after a valid commit and after an invalid revert', async () => {
    const { onUpdatePosition } = renderGrid();
    await flush(50);

    // Valid commit.
    await openEditorByDoubleClick('pos-1', 'ordinal');
    let input = activeEditorInput();
    expect(input).toBeTruthy();
    await act(async () => {
      fireEvent.input(input!, { target: { value: '02.99' } });
      fireEvent.keyDown(input!, { key: 'Enter' });
    });
    await flush(20);
    expect(editingCells().length, 'Enter must close the editor').toBe(0);
    expect(onUpdatePosition).toHaveBeenCalledWith(
      'pos-1',
      expect.objectContaining({ ordinal: '02.99' }),
      expect.anything(),
    );

    // Reopen after the commit.
    await openEditorByDoubleClick('pos-1', 'ordinal');
    expect(editingCells().length, 'must reopen after a valid commit').toBeGreaterThan(0);

    // Invalid entry → revert path (guard sets + must clear its flag).
    input = activeEditorInput();
    await act(async () => {
      fireEvent.input(input!, { target: { value: '!!invalid!!' } });
      fireEvent.keyDown(input!, { key: 'Enter' });
    });
    await flush(20);
    expect(editingCells().length, 'invalid commit must close the editor').toBe(0);

    // Reopen after the invalid revert — the re-entrancy guard must be clear.
    await openEditorByDoubleClick('pos-2', 'ordinal');
    expect(editingCells().length, 'must reopen after an invalid revert').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);
  });

  it('switching the edit to another cell closes the old editor and the grid keeps editing', async () => {
    renderGrid();
    await flush(50);

    await openEditorByDoubleClick('pos-1', 'ordinal');
    expect(editingCells().length).toBeGreaterThan(0);

    // Start an edit on ANOTHER cell while the ordinal editor is open - the
    // everyday "click straight into the next field" path. (In the browser
    // the focus loss also closes the first editor; jsdom cannot emulate
    // that part, so the assertion here is that a dangling session never
    // blocks the next one.)
    await openEditorByDoubleClick('pos-2', 'unit_rate');
    const editingCols = editingCells().map((el) => el.getAttribute('col-id'));
    expect(editingCols, 'the new editor must open').toContain('unit_rate');

    // Close whatever sessions are open, then a third one still opens.
    for (let i = 0; i < 4 && editingCells().length > 0; i++) {
      const input = activeEditorInput();
      if (!input) break;
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Escape' });
      });
      await flush(20);
    }
    expect(editingCells().length, 'Escape must close every session').toBe(0);
    await openEditorByDoubleClick('pos-3', 'ordinal');
    expect(editingCells().length, 'must reopen after an edit-switch close').toBeGreaterThan(0);
  });

  it('rate editor: blur-with-typed-value commits and the grid reopens editors afterwards', async () => {
    const { onUpdatePosition } = renderGrid();
    await flush(50);

    await openEditorByDoubleClick('pos-1', 'unit_rate');
    const input = activeEditorInput();
    expect(input, 'rate editor must open').toBeTruthy();

    await act(async () => {
      fireEvent.input(input!, { target: { value: '33' } });
    });
    // Real blur: the RateCellEditor's own native blur listener commits.
    const other = cell('pos-2', 'total');
    await act(async () => {
      other.focus();
      fireEvent.blur(input!, { relatedTarget: other });
      fireEvent.focusOut(input!, { relatedTarget: other });
    });
    await flush(30);
    expect(editingCells().length, 'blur must close the rate editor').toBe(0);
    expect(onUpdatePosition).toHaveBeenCalledWith(
      'pos-1',
      expect.objectContaining({ unit_rate: 33 }),
      expect.anything(),
    );

    await openEditorByDoubleClick('pos-2', 'unit_rate');
    expect(editingCells().length, 'rate editor must reopen after a blur-commit').toBeGreaterThan(0);
    const again = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(again!, { key: 'Escape' });
    });
    await flush(20);
  });

  it('ordinal gestures: single click must NOT edit, F2 opens repeatedly', async () => {
    renderGrid();
    await flush(50);

    // A single click on the Ordnungszahl merely selects - the exact stray
    // click that used to open an invisible editor over the OZ. (Grid-level
    // singleClickEdit cannot be overridden per column; the gesture arming
    // in columnDefs.ts is what enforces this.)
    const target = cell('pos-1', 'ordinal');
    await act(async () => {
      fireEvent.mouseDown(target);
      fireEvent.mouseUp(target);
      fireEvent.click(target);
    });
    await flush(30);
    expect(editingCells().length, 'single click must NOT open the ordinal editor').toBe(0);

    // Typing over the focused cell must not start an edit either.
    await act(async () => {
      fireEvent.keyDown(target, { key: 'W' });
    });
    await flush(20);
    expect(editingCells().length, 'type-to-replace must stay off for the ordinal').toBe(0);

    // F2 opens - first session.
    await act(async () => {
      fireEvent.keyDown(target, { key: 'F2' });
    });
    await flush(30);
    expect(editingCells().length, 'F2 must open the ordinal editor').toBeGreaterThan(0);
    let input = activeEditorInput();
    await act(async () => {
      fireEvent.input(input!, { target: { value: '03.10' } });
      fireEvent.keyDown(input!, { key: 'Enter' });
    });
    await flush(20);
    expect(editingCells().length, 'Enter must commit-close').toBe(0);

    // F2 must reopen - second session on the focused cell.
    const focusedCell = document.querySelector<HTMLElement>('.ag-cell-focus') ?? target;
    await act(async () => {
      fireEvent.keyDown(focusedCell, { key: 'F2' });
    });
    await flush(30);
    expect(editingCells().length, 'F2 must reopen an editor after a previous session').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);
    expect(editingCells().length).toBe(0);

    // And a third session via F2 again.
    const focusedCell2 = document.querySelector<HTMLElement>('.ag-cell-focus') ?? target;
    await act(async () => {
      fireEvent.keyDown(focusedCell2, { key: 'F2' });
    });
    await flush(30);
    expect(editingCells().length, 'F2 must open a third session too').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);
  });

  it('rate editor: German decimal comma parses to the decimal, not 100x', async () => {
    const { onUpdatePosition } = renderGrid();
    await flush(50);
    await waitUntil(
      () => !!document.querySelector('.ag-row[row-id="pos-1"]'),
      'rows rendered',
    );

    await openAndAwaitEditor('pos-1', 'unit_rate', 'first rate edit');
    const input = activeEditorInput();
    expect(input, 'rate editor must open').toBeTruthy();
    // The editor must be a TEXT input: a number input drops the comma
    // keystroke and 48,60 became 4860.
    expect((input as HTMLInputElement).type).toBe('text');

    await act(async () => {
      fireEvent.input(input!, { target: { value: '48,60' } });
      fireEvent.keyDown(input!, { key: 'Enter' });
    });
    await waitUntil(
      () => onUpdatePosition.mock.calls.some((c) => c[0] === 'pos-1'),
      'comma commit dispatched',
    );
    expect(onUpdatePosition).toHaveBeenCalledWith(
      'pos-1',
      expect.objectContaining({ unit_rate: 48.6 }),
      expect.anything(),
    );

    // Thousands + comma decimals in one entry.
    await openAndAwaitEditor('pos-2', 'unit_rate', 'second rate edit');
    const input2 = activeEditorInput();
    await act(async () => {
      fireEvent.input(input2!, { target: { value: '1.234,56' } });
      fireEvent.keyDown(input2!, { key: 'Enter' });
    });
    await waitUntil(
      () => onUpdatePosition.mock.calls.some((c) => c[0] === 'pos-2'),
      'thousands commit dispatched',
    );
    expect(onUpdatePosition).toHaveBeenCalledWith(
      'pos-2',
      expect.objectContaining({ unit_rate: 1234.56 }),
      expect.anything(),
    );

    // Garbage reverts (keeps the stored rate) and shows the warning toast.
    const { useToastStore } = await import('@/stores/useToastStore');
    const toastsBefore = useToastStore.getState().toasts.length;
    await openAndAwaitEditor('pos-3', 'unit_rate', 'third rate edit');
    const input3 = activeEditorInput();
    await act(async () => {
      fireEvent.input(input3!, { target: { value: 'abc' } });
      fireEvent.keyDown(input3!, { key: 'Enter' });
    });
    await waitUntil(() => editingCells().length === 0, 'garbage entry closes the editor');
    expect(onUpdatePosition).not.toHaveBeenCalledWith(
      'pos-3',
      expect.anything(),
      expect.anything(),
    );
    await waitUntil(
      () => useToastStore.getState().toasts.length > toastsBefore,
      'garbage revert toast',
    );

    // And the editor still reopens afterwards.
    await openAndAwaitEditor('pos-3', 'unit_rate', 'reopen after garbage revert');
  });

  it('unit-rate editor: opens, commits via Enter, and reopens on the same and other rows', async () => {
    const { onUpdatePosition } = renderGrid();
    await flush(50);

    // Rate cell edits on single click (grid-wide singleClickEdit).
    await openEditorByDoubleClick('pos-1', 'unit_rate');
    let input = activeEditorInput();
    expect(input, 'rate editor must open').toBeTruthy();

    await act(async () => {
      fireEvent.input(input!, { target: { value: '77' } });
      fireEvent.keyDown(input!, { key: 'Enter' });
    });
    await flush(20);
    expect(editingCells().length, 'Enter must close the rate editor').toBe(0);
    expect(onUpdatePosition).toHaveBeenCalledWith(
      'pos-1',
      expect.objectContaining({ unit_rate: 77 }),
      expect.anything(),
    );

    // Reopen the SAME cell.
    await openEditorByDoubleClick('pos-1', 'unit_rate');
    expect(editingCells().length, 'same rate cell must reopen after a commit').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);
    expect(editingCells().length, 'Escape must close the rate editor').toBe(0);

    // Reopen on ANOTHER row after the Escape close.
    await openEditorByDoubleClick('pos-2', 'unit_rate');
    expect(editingCells().length, 'other rate cell must open after Escape').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);
  });

  it('StrictMode: ordinal and rate editors reopen after commit and Escape', async () => {
    renderGrid({}, { strict: true });
    await flush(50);

    // Ordinal: open, commit, reopen on another row.
    await openEditorByDoubleClick('pos-1', 'ordinal');
    let input = activeEditorInput();
    expect(input, 'StrictMode: first ordinal editor must open').toBeTruthy();
    await act(async () => {
      fireEvent.input(input!, { target: { value: '09.01' } });
      fireEvent.keyDown(input!, { key: 'Enter' });
    });
    await flush(20);
    expect(editingCells().length, 'StrictMode: Enter must close').toBe(0);

    await openEditorByDoubleClick('pos-2', 'ordinal');
    expect(editingCells().length, 'StrictMode: ordinal must reopen on row 2').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);

    // Rate: open, commit, reopen.
    await openEditorByDoubleClick('pos-1', 'unit_rate');
    input = activeEditorInput();
    expect(input, 'StrictMode: rate editor must open').toBeTruthy();
    await act(async () => {
      fireEvent.input(input!, { target: { value: '55' } });
      fireEvent.keyDown(input!, { key: 'Enter' });
    });
    await flush(20);
    expect(editingCells().length, 'StrictMode: rate Enter must close').toBe(0);

    await openEditorByDoubleClick('pos-3', 'unit_rate');
    expect(editingCells().length, 'StrictMode: rate must reopen on row 3').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);
  });

  it('quantity popup editor: opens, commits, and reopens', async () => {
    renderGrid();
    await flush(50);

    await openEditorByDoubleClick('pos-1', 'quantity');
    let input = activeEditorInput();
    expect(input, 'quantity editor must open').toBeTruthy();

    await act(async () => {
      fireEvent.input(input!, { target: { value: '42' } });
      fireEvent.keyDown(input!, { key: 'Enter' });
    });
    await flush(20);
    expect(editingCells().length, 'Enter must close the quantity editor').toBe(0);

    await openEditorByDoubleClick('pos-2', 'quantity');
    expect(editingCells().length, 'quantity editor must reopen on another row').toBeGreaterThan(0);
    input = activeEditorInput();
    await act(async () => {
      fireEvent.keyDown(input!, { key: 'Escape' });
    });
    await flush(20);
  });
});
