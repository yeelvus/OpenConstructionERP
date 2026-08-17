// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Registry of COLLAPSED module info blocks on the current page.
 *
 * When a `DismissibleInfo` card or a `CollapsibleSection` explainer is
 * collapsed it disappears from the content flow entirely. The way back is a
 * single `ModuleInfoButton`: an information icon in the top app bar, sitting
 * immediately to the right of the module name (founder 2026-08-07).
 *
 * Mechanics: every collapsed block registers itself here (key + an `expand`
 * callback) and unregisters when expanded or unmounted, so navigating away
 * clears the registry by itself. The icon fires every registered entry's
 * `expand`, which is why one click restores a page carrying both a card and
 * an explainer.
 *
 * There used to be a second, competing control - a labelled pill next to the
 * module's "How it works" button (founder 2026-07-23) - and a `guideKeys`
 * registry whose only job was to let the Header detect that pill and suppress
 * itself. Both are gone rather than left dormant: with one control there is
 * nothing to arbitrate between, and a suppression flag no caller reads is a
 * mechanism the next reader has to disprove.
 */

import { create } from 'zustand';

export interface CollapsedModuleInfo {
  /** Stable identity - the DismissibleInfo localStorage key. */
  key: string;
  /** Re-expands the owning card (persists the expanded state). */
  expand: () => void;
}

interface ModuleInfoState {
  entries: CollapsedModuleInfo[];
  register: (entry: CollapsedModuleInfo) => void;
  unregister: (key: string) => void;
  /** Expand every collapsed card on the page (re-open control click). */
  expandAll: () => void;
}

export const useModuleInfoStore = create<ModuleInfoState>((set, get) => ({
  entries: [],
  register: (entry) =>
    set((s) => ({
      // Replace-on-rekey keeps StrictMode double-mounts and prop updates safe.
      entries: [...s.entries.filter((e) => e.key !== entry.key), entry],
    })),
  unregister: (key) => set((s) => ({ entries: s.entries.filter((e) => e.key !== key) })),
  expandAll: () => {
    // Snapshot first: expand() flips the card to expanded, which unregisters
    // the entry and mutates the array we are iterating.
    const snapshot = [...get().entries];
    snapshot.forEach((e) => e.expand());
  },
}));
