/** Display helpers for cost-board amounts (万泰铢) and rates. */

export function fmtWan(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  // Values are 0–1 fractions in the snapshot
  const pct = Math.abs(n) <= 1.5 ? n * 100 : n;
  return `${pct.toFixed(digits)}%`;
}

export function riskBadgeClass(risk: string | null | undefined): string {
  switch ((risk || '').toLowerCase()) {
    case 'danger':
    case 'high':
    case '风险':
      return 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200';
    case 'warn':
    case 'warning':
    case 'medium':
      return 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100';
    case 'ok':
    case 'low':
    case 'safe':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-100';
    default:
      return 'bg-surface-secondary text-content-secondary';
  }
}

export const LABOR_CAT_LABELS: Record<string, string> = {
  zh_formal: '中方正式工',
  zh_labor: '中方劳务工',
  local_labor: '属地工',
  outsourcing_labor: '劳务公司',
  visa_fee: '签证费',
  total_labor: '合计',
};

export const LABOR_CAT_COLORS: Record<string, string> = {
  zh_formal: '#3b82f6',
  zh_labor: '#8b5cf6',
  local_labor: '#10b981',
  outsourcing_labor: '#f59e0b',
  visa_fee: '#ef4444',
  total_labor: '#0f172a',
};
