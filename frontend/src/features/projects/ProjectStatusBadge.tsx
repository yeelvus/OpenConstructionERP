// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
import { useTranslation } from 'react-i18next';
import { Badge } from '@/shared/ui';

/**
 * ProjectStatusBadge (#274) - renders a project's lifecycle status as a
 * coloured pill with an i18n label.
 *
 * The backend stores status as a free-form string (<=50 chars), but the UI
 * curates a recommended set. ``active`` means 在建 (in construction).
 * Construction close-out / settlement statuses (closing, settling, settled)
 * sit between active work and finished/cancelled. ``archived`` is soft-delete
 * only — not offered in the status picker for normal edits.
 */

type BadgeVariant = 'neutral' | 'blue' | 'success' | 'warning' | 'error';

/** Curated project statuses in lifecycle order (English tokens). */
export const CURATED_PROJECT_STATUSES = [
  'active', // 在建
  'closing', // 收尾
  'settling', // 结算中
  'settled', // 已结算完成
  'on_hold',
  'finished',
  'cancelled',
  'archived',
] as const;

export type CuratedProjectStatus = (typeof CURATED_PROJECT_STATUSES)[number];

/** Statuses that may be set via bulk / picker (excludes soft-delete archive). */
export const WORKING_PROJECT_STATUSES = CURATED_PROJECT_STATUSES.filter(
  (s) => s !== 'archived',
);

const STATUS_VARIANT: Record<CuratedProjectStatus, BadgeVariant> = {
  active: 'success',
  closing: 'warning',
  settling: 'blue',
  settled: 'success',
  on_hold: 'warning',
  finished: 'neutral',
  cancelled: 'error',
  archived: 'neutral',
};

const STATUS_LABEL_DEFAULT: Record<CuratedProjectStatus, string> = {
  active: 'In progress',
  closing: 'Closing out',
  settling: 'Settling',
  settled: 'Settled',
  on_hold: 'On hold',
  finished: 'Finished',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

/** Title-case an unknown status token (e.g. "in_review" -> "In review"). */
function humanise(status: string): string {
  const spaced = status.replace(/[_-]+/g, ' ').trim();
  if (!spaced) return status;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Resolve a status string to its translated label (curated or humanised). */
export function useProjectStatusLabel(): (status: string) => string {
  const { t } = useTranslation();
  return (status: string): string => {
    const key = status as CuratedProjectStatus;
    if (key in STATUS_LABEL_DEFAULT) {
      return t(`projects.status.${key}`, { defaultValue: STATUS_LABEL_DEFAULT[key] });
    }
    return humanise(status);
  };
}

export function ProjectStatusBadge({
  status,
  size = 'sm',
  dot = true,
  className,
}: {
  status: string;
  size?: 'sm' | 'md';
  dot?: boolean;
  className?: string;
}) {
  const label = useProjectStatusLabel()(status);
  const key = status as CuratedProjectStatus;
  const variant: BadgeVariant = key in STATUS_VARIANT ? STATUS_VARIANT[key] : 'neutral';

  return (
    <Badge variant={variant} size={size} dot={dot} className={className}>
      {label}
    </Badge>
  );
}
