// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * The top-bar button: who sees it, and what it opens.
 *
 * The visibility check is not access control - the server enforces
 * `module_builder.install` on the call itself - but it is the difference
 * between a header that offers something you can do and one that offers
 * something that will be refused, so it is worth a test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, fetchVocabulary: vi.fn() };
});

import { useAuthStore } from '@/stores/useAuthStore';

import { fetchVocabulary, type Vocabulary } from './api';
import { ModuleBuilderButton } from './ModuleBuilderButton';
// The button loads the wizard with `React.lazy`. Importing it here resolves
// that dynamic import from the module cache instead of leaving the test to
// wait on Vitest's loader, which is not what any of these assertions are
// about. Nothing about the lazy boundary changes: the wizard still mounts
// only after the click, which is what the third test checks.
import './ModuleBuilderWizard';

const VOCABULARY: Vocabulary = {
  field_types: [{ type: 'text', label: 'Text', hint: '' }],
  rule_kinds: [
    { kind: 'required', label: 'Must be filled in', hint: '', applies_to: ['text'], needs_other_field: false, needs_bounds: false },
  ],
  reserved_field_names: [],
  reserved_keys: [],
  max_fields: 40,
  assistant_available: false,
};

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ModuleBuilderButton />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchVocabulary).mockResolvedValue(VOCABULARY);
  useAuthStore.setState({ userRole: 'admin' });
});

describe('ModuleBuilderButton', () => {
  it('is there for an administrator', () => {
    renderButton();
    expect(screen.getByTestId('header-module-builder')).toBeTruthy();
  });

  it('is not there for anyone who could not install a module', () => {
    for (const role of ['viewer', 'editor', 'manager', null]) {
      useAuthStore.setState({ userRole: role });
      const { unmount } = renderButton();
      expect(screen.queryByTestId('header-module-builder')).toBeNull();
      unmount();
    }
  });

  it('opens the wizard, which is not in the bundle until it is asked for', async () => {
    const user = userEvent.setup();
    renderButton();
    // Nothing of the wizard has been loaded yet: the header is on every page
    // and this screen is opened by almost none of them.
    expect(fetchVocabulary).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('header-module-builder'));
    expect(await screen.findByTestId('module-builder-wizard')).toBeTruthy();
  });
});
