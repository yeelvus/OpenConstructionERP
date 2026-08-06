// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
//
// Tests for <ApprovalAnalyticsPanel /> — the project-scoped approval-cycle
// analytics surface (backlog item #11).
//
// Mocking strategy mirrors ApprovalRoutesPage.test.tsx: stub the
// feature-local `../api` module so the panel's useQuery calls a controlled
// getApprovalAnalytics and the query-key factory is present. The panel
// renders real @/shared/ui primitives, so assertions target the English
// i18n defaultValues and the mocked data values.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import type { ApprovalAnalytics } from '../types';

/* ── Feature-local API mock ───────────────────────────────────────── */

vi.mock('../api', () => ({
  getApprovalAnalytics: vi.fn(),
  approvalRoutesKeys: {
    analytics: (
      projectId?: string | null,
      targetKind?: string | null,
      days?: number,
    ) =>
      [
        'approval-routes',
        'analytics',
        projectId ?? null,
        targetKind ?? null,
        days ?? null,
      ] as const,
  },
}));

import { getApprovalAnalytics } from '../api';
import { ApprovalAnalyticsPanel } from '../ApprovalAnalyticsPanel';

/* ── Helpers ──────────────────────────────────────────────────────── */

const ANALYTICS: ApprovalAnalytics = {
  project_id: 'p1',
  generated_at: '2026-07-24T00:00:00Z',
  range_days: 180,
  started_after: null,
  started_before: null,
  sample_size: 3,
  truncated: false,
  kpis: {
    total_instances: 3,
    pending: 1,
    approved: 2,
    rejected: 0,
    cancelled: 0,
    approval_rate: 1.0,
    avg_cycle_days: 2.0,
    median_cycle_days: 2.0,
    breached_steps_total: 1,
    instances_with_breach: 1,
    open_overdue_now: 1,
  },
  by_role: [
    {
      role: 'manager',
      decided_count: 2,
      avg_hours: 20,
      median_hours: 20,
      max_hours: 30,
      breach_count: 1,
      breach_rate: 0.5,
    },
  ],
  by_step: [
    {
      route_id: 'r1',
      route_name: 'Submittal review',
      ordinal: 1,
      approver_role: 'manager',
      decided_count: 2,
      avg_hours: 20,
      median_hours: 20,
      breach_count: 1,
      breach_rate: 0.5,
      sla_hours: 24,
    },
  ],
  bottlenecks: [
    {
      kind: 'step',
      label: 'Submittal review · Step 1',
      ref: 'r1:1',
      avg_hours: 20,
      median_hours: 20,
      breach_rate: 0.5,
      sample_size: 2,
    },
  ],
};

function renderPanel(props: {
  projectId: string | null;
  targetKind?: string | null;
  onDrill?: (f: { status?: string; targetKind?: string }) => void;
}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ApprovalAnalyticsPanel
          projectId={props.projectId}
          targetKind={props.targetKind}
          onDrill={props.onDrill as never}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const mockAnalytics = getApprovalAnalytics as ReturnType<typeof vi.fn>;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

/* ── Tests ────────────────────────────────────────────────────────── */

describe('<ApprovalAnalyticsPanel />', () => {
  it('renders KPI tiles and bottlenecks from the mocked analytics', async () => {
    mockAnalytics.mockResolvedValue(ANALYTICS);
    renderPanel({ projectId: 'p1' });

    await waitFor(() => {
      expect(screen.getByText('Workflows')).toBeTruthy();
    });
    // Approval rate tile shows the formatted percentage.
    expect(screen.getByText('100%')).toBeTruthy();
    // Bottleneck row rendered from the backend-composed label.
    expect(screen.getByText('Submittal review · Step 1')).toBeTruthy();
    expect(screen.getByText('SLA breaches')).toBeTruthy();
  });

  it('shows the pick-project empty state and fires no fetch when projectId is null', async () => {
    renderPanel({ projectId: null });

    expect(
      screen.getByText(/Select a project to see its approval-cycle analytics/i),
    ).toBeTruthy();
    expect(mockAnalytics).not.toHaveBeenCalled();
  });

  it('shows the empty state when sample_size is 0', async () => {
    mockAnalytics.mockResolvedValue({ ...ANALYTICS, sample_size: 0 });
    renderPanel({ projectId: 'p1' });

    await waitFor(() => {
      expect(
        screen.getByText(/No approval workflows in range/i),
      ).toBeTruthy();
    });
  });

  it('shows a skeleton while the query is pending', () => {
    mockAnalytics.mockReturnValue(new Promise(() => {}));
    renderPanel({ projectId: 'p1' });
    expect(screen.getByTestId('skeleton-table')).toBeTruthy();
  });

  it('shows a RecoveryCard with retry on error', async () => {
    mockAnalytics.mockRejectedValue(new Error('boom'));
    renderPanel({ projectId: 'p1' });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
    });
  });

  it('drills to rejected instances when the Rejected tile is clicked', async () => {
    mockAnalytics.mockResolvedValue(ANALYTICS);
    const onDrill = vi.fn();
    renderPanel({ projectId: 'p1', onDrill });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Rejected/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Rejected/i }));
    expect(onDrill).toHaveBeenCalledWith({ status: 'rejected' });
  });

  it('drills to the target kind when a step bottleneck row is clicked', async () => {
    mockAnalytics.mockResolvedValue(ANALYTICS);
    const onDrill = vi.fn();
    renderPanel({ projectId: 'p1', targetKind: 'submittal', onDrill });

    await waitFor(() => {
      expect(screen.getByText('Submittal review · Step 1')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Submittal review · Step 1'));
    expect(onDrill).toHaveBeenCalledWith({ targetKind: 'submittal' });
  });
});
