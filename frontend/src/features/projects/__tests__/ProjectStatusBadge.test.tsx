// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  ProjectStatusBadge,
  CURATED_PROJECT_STATUSES,
} from '../ProjectStatusBadge';

describe('ProjectStatusBadge', () => {
  it('renders curated statuses with Chinese labels', () => {
    render(<ProjectStatusBadge status="active" />);
    // active = in-progress construction (在建); token stays English in DB
    expect(screen.getByText('在建')).toBeInTheDocument();
  });

  it('includes close-out / settlement statuses in the curated set', () => {
    expect(CURATED_PROJECT_STATUSES).toContain('closing');
    expect(CURATED_PROJECT_STATUSES).toContain('settling');
    expect(CURATED_PROJECT_STATUSES).toContain('settled');
    render(<ProjectStatusBadge status="settling" />);
    expect(screen.getByText('结算中')).toBeInTheDocument();
  });

  it('labels on_hold as 暂停', () => {
    render(<ProjectStatusBadge status="on_hold" />);
    expect(screen.getByText('暂停')).toBeInTheDocument();
  });

  it('humanises an unknown custom status (in_review -> In review)', () => {
    render(<ProjectStatusBadge status="in_review" />);
    expect(screen.getByText('In review')).toBeInTheDocument();
  });

  it('renders the curated "cancelled" status with its Chinese label (#284)', () => {
    render(<ProjectStatusBadge status="cancelled" />);
    expect(screen.getByText('已取消')).toBeInTheDocument();
  });

  it('includes "cancelled" in the curated set so pickers/filters offer it (#284)', () => {
    // The status picker + any status-driven UI map over CURATED_PROJECT_STATUSES,
    // so membership here is what surfaces the option everywhere it is chosen.
    expect(CURATED_PROJECT_STATUSES).toContain('cancelled');
  });

  it('renders every curated status without throwing', () => {
    for (const s of CURATED_PROJECT_STATUSES) {
      const { unmount } = render(<ProjectStatusBadge status={s} />);
      unmount();
    }
    expect(CURATED_PROJECT_STATUSES).toContain('archived');
  });

  it('falls back to the raw value when the status has no separators', () => {
    render(<ProjectStatusBadge status="paused" />);
    // "paused" is title-cased to "Paused".
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });
});
