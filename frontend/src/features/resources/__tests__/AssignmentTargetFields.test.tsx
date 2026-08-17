// @ts-nocheck
/**
 * Tests for the project + schedule-activity pickers shared by the propose and
 * edit assignment modals.
 *
 * These are the fields that answer "what is this booking for". The behaviours
 * worth pinning are the ones a reviewer cannot see from the markup: the
 * activity list is scoped to the chosen project and says so while it is empty,
 * and changing the project drops the chosen activity instead of carrying an id
 * from one project's schedule onto another.
 *
 * Network is stubbed via ``vi.mock`` on the projects and schedule api modules;
 * React Query retries are off so a rejection surfaces immediately.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/features/projects/api', () => ({
  projectsApi: { list: vi.fn() },
}));

vi.mock('@/features/schedule/api', () => ({
  scheduleApi: { listSchedules: vi.fn(), getGantt: vi.fn() },
}));

import { projectsApi } from '@/features/projects/api';
import { scheduleApi } from '@/features/schedule/api';
import { AssignmentTargetFields } from '../AssignmentTargetFields';

const PROJECTS = [
  { id: 'p1', name: 'Tower A' },
  { id: 'p2', name: 'Depot B' },
];

const SCHEDULES = [
  { id: 's1', project_id: 'p1', name: 'Main schedule' },
  { id: 's2', project_id: 'p1', name: 'Fit-out' },
];

const GANTT = {
  s1: {
    activities: [
      { id: 'a1', name: 'Foundation', wbs_code: '01', start_date: '2026-03-02', activity_type: 'task' },
      { id: 'a2', name: 'Walls', wbs_code: '02', start_date: '2026-03-09', activity_type: 'task' },
    ],
  },
  s2: {
    activities: [
      { id: 'a3', name: 'Plasterboard', wbs_code: '10', start_date: '2026-04-06', activity_type: 'task' },
    ],
  },
};

function renderFields(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const merged = {
    projectId: '',
    activityId: '',
    onChange: vi.fn(),
    projectTestId: 'target-project',
    activityTestId: 'target-activity',
    ...props,
  };
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AssignmentTargetFields {...merged} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, props: merged };
}

describe('AssignmentTargetFields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom does not implement scrollIntoView; SearchableSelect calls it to
    // keep the highlighted row visible whenever the popover opens.
    if (!('scrollIntoView' in HTMLElement.prototype)) {
      // @ts-expect-error — jsdom prototype patch
      HTMLElement.prototype.scrollIntoView = () => {};
    } else {
      vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    }
    (projectsApi.list as any).mockResolvedValue(PROJECTS);
    (scheduleApi.listSchedules as any).mockResolvedValue({
      items: SCHEDULES,
      total: SCHEDULES.length,
      offset: 0,
      limit: 50,
    });
    (scheduleApi.getGantt as any).mockImplementation(async (id: string) => GANTT[id]);
  });

  it('offers every project it fetched', async () => {
    renderFields();
    fireEvent.click(await screen.findByTestId('target-project'));
    expect(await screen.findByText('Tower A')).toBeInTheDocument();
    expect(screen.getByText('Depot B')).toBeInTheDocument();
  });

  it('disables the activity picker and says why until a project is chosen', async () => {
    renderFields();
    await screen.findByTestId('target-project');
    expect(screen.getByTestId('target-activity')).toBeDisabled();
    // Twice over: the disabled trigger says it, and so does the field hint.
    expect(screen.getAllByText(/activities belong to its schedule/i)).toHaveLength(2);
    // Nothing was asked of the schedule module without a project to scope it.
    expect(scheduleApi.listSchedules).not.toHaveBeenCalled();
  });

  it('lists the activities of the chosen project, under their schedule', async () => {
    renderFields({ projectId: 'p1' });
    fireEvent.click(await screen.findByTestId('target-activity'));
    expect(await screen.findByText('Foundation')).toBeInTheDocument();
    expect(screen.getByText('Walls')).toBeInTheDocument();
    expect(screen.getByText('Plasterboard')).toBeInTheDocument();
    // Grouped by the schedule each activity belongs to.
    expect(screen.getByText('Main schedule')).toBeInTheDocument();
    expect(screen.getByText('Fit-out')).toBeInTheDocument();
    expect(scheduleApi.listSchedules).toHaveBeenCalledWith('p1');
  });

  it('reports a picked activity together with the project it belongs to', async () => {
    const { props } = renderFields({ projectId: 'p1' });
    fireEvent.click(await screen.findByTestId('target-activity'));
    fireEvent.click(await screen.findByText('Walls'));
    expect(props.onChange).toHaveBeenCalledWith({ project_id: 'p1', activity_id: 'a2' });
  });

  it('clears the chosen activity when the project changes', async () => {
    const { props } = renderFields({ projectId: 'p1', activityId: 'a2' });
    fireEvent.click(await screen.findByTestId('target-project'));
    fireEvent.click(await screen.findByText('Depot B'));
    expect(props.onChange).toHaveBeenCalledWith({ project_id: 'p2', activity_id: '' });
  });

  it('says a project has no activities rather than showing an empty picker', async () => {
    (scheduleApi.listSchedules as any).mockResolvedValue({
      items: [],
      total: 0,
      offset: 0,
      limit: 50,
    });
    renderFields({ projectId: 'p1' });
    expect(
      await screen.findByText(/no schedule activities yet/i),
    ).toBeInTheDocument();
  });

  it('keeps the other schedules when one of them cannot be read', async () => {
    (scheduleApi.getGantt as any).mockImplementation(async (id: string) => {
      if (id === 's1') throw new Error('boom');
      return GANTT[id];
    });
    renderFields({ projectId: 'p1' });
    fireEvent.click(await screen.findByTestId('target-activity'));
    expect(await screen.findByText('Plasterboard')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Foundation')).not.toBeInTheDocument());
  });
});
