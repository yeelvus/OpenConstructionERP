// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/**
 * Contract FX policy helpers.
 *
 * Contracts may be priced in a currency different from the project base.
 * Per commercial agreement the conversion to project currency uses either:
 *   - fixed — rate locked in the contract
 *   - spot_at_payment — market rate at each payment
 *   - project — reuse the project's fx_rates table
 *
 * Rate convention matches project.fx_rates: **project-base units per 1 unit
 * of the contract (foreign) currency**.
 *
 * Stored under ``contract.metadata.fx`` so it remains editable after sign
 * (spot rates must be recordable on payment); ``terms`` freezes after draft.
 */

export type ContractFxMode = 'none' | 'fixed' | 'spot_at_payment' | 'project';

export interface ContractFxPolicy {
  /** How this contract converts into the project base currency. */
  mode: ContractFxMode;
  /**
   * Fixed rate (project base per 1 contract currency). Required when
   * mode === 'fixed'. Also used as an optional last-known rate for spot.
   */
  rate?: string | null;
  /** Effective / agreement date for the fixed rate (YYYY-MM-DD). */
  rate_date?: string | null;
  /** Free-text note, e.g. clause reference or bank source. */
  note?: string | null;
  /** Last recorded spot rate (for spot_at_payment bookkeeping). */
  last_spot_rate?: string | null;
  last_spot_date?: string | null;
  /** Optional pair label e.g. "USD→CNY". */
  pair_label?: string | null;
}

export interface ProjectFxRateLike {
  code?: string;
  currency?: string;
  rate: string | number;
  label?: string | null;
}

const EMPTY: ContractFxPolicy = { mode: 'none' };

export function parseContractFx(
  metadata: Record<string, unknown> | null | undefined,
): ContractFxPolicy {
  const raw = metadata?.fx;
  if (!raw || typeof raw !== 'object') return { ...EMPTY };
  const o = raw as Record<string, unknown>;
  const modeRaw = String(o.mode || 'none').toLowerCase();
  const mode: ContractFxMode =
    modeRaw === 'fixed' ||
    modeRaw === 'spot_at_payment' ||
    modeRaw === 'project' ||
    modeRaw === 'none'
      ? modeRaw
      : 'none';
  return {
    mode,
    rate: o.rate != null && o.rate !== '' ? String(o.rate) : null,
    rate_date: o.rate_date != null && o.rate_date !== '' ? String(o.rate_date) : null,
    note: o.note != null && o.note !== '' ? String(o.note) : null,
    last_spot_rate:
      o.last_spot_rate != null && o.last_spot_rate !== ''
        ? String(o.last_spot_rate)
        : null,
    last_spot_date:
      o.last_spot_date != null && o.last_spot_date !== ''
        ? String(o.last_spot_date)
        : null,
    pair_label:
      o.pair_label != null && o.pair_label !== '' ? String(o.pair_label) : null,
  };
}

/** Build metadata patch that merges fx policy into existing metadata. */
export function withContractFx(
  metadata: Record<string, unknown> | null | undefined,
  fx: ContractFxPolicy,
): Record<string, unknown> {
  const base = { ...(metadata || {}) };
  const cleaned: Record<string, unknown> = { mode: fx.mode };
  if (fx.mode === 'none') {
    base.fx = { mode: 'none' };
    return base;
  }
  if (fx.rate != null && String(fx.rate).trim() !== '') {
    cleaned.rate = String(fx.rate).trim();
  }
  if (fx.rate_date) cleaned.rate_date = fx.rate_date;
  if (fx.note) cleaned.note = fx.note;
  if (fx.last_spot_rate) cleaned.last_spot_rate = String(fx.last_spot_rate).trim();
  if (fx.last_spot_date) cleaned.last_spot_date = fx.last_spot_date;
  if (fx.pair_label) cleaned.pair_label = fx.pair_label;
  base.fx = cleaned;
  return base;
}

function numRate(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Resolve the conversion rate (project base per 1 contract currency unit),
 * or null when conversion is not available yet.
 */
export function resolveContractFxRate(opts: {
  contractCurrency: string | null | undefined;
  projectCurrency: string | null | undefined;
  fx: ContractFxPolicy;
  projectFxRates?: ProjectFxRateLike[] | null;
}): {
  rate: number | null;
  source: 'same' | 'fixed' | 'spot' | 'project' | 'unavailable';
  label: string;
} {
  const ccy = (opts.contractCurrency || '').trim().toUpperCase();
  const base = (opts.projectCurrency || '').trim().toUpperCase();
  if (!ccy || !base || ccy === base) {
    return { rate: 1, source: 'same', label: '1:1' };
  }

  const mode = opts.fx.mode || 'none';

  if (mode === 'fixed') {
    const r = numRate(opts.fx.rate);
    if (r != null) {
      return {
        rate: r,
        source: 'fixed',
        label: `fixed ${r}`,
      };
    }
    return { rate: null, source: 'unavailable', label: 'fixed (missing rate)' };
  }

  if (mode === 'spot_at_payment') {
    const r = numRate(opts.fx.last_spot_rate ?? opts.fx.rate);
    if (r != null) {
      return {
        rate: r,
        source: 'spot',
        label: opts.fx.last_spot_date
          ? `spot ${r} @ ${opts.fx.last_spot_date}`
          : `spot ${r}`,
      };
    }
    return {
      rate: null,
      source: 'unavailable',
      label: 'spot at payment',
    };
  }

  if (mode === 'project' || mode === 'none') {
    const list = opts.projectFxRates ?? [];
    const hit = list.find((row) => {
      const code = String(row.code || row.currency || '')
        .trim()
        .toUpperCase();
      return code === ccy;
    });
    const r = hit ? numRate(hit.rate) : null;
    if (r != null) {
      return {
        rate: r,
        source: 'project',
        label: `project FX ${r}`,
      };
    }
    if (mode === 'project') {
      return {
        rate: null,
        source: 'unavailable',
        label: 'project FX (missing)',
      };
    }
  }

  return { rate: null, source: 'unavailable', label: 'no FX policy' };
}

/** Convert an amount in contract currency to project base, or null if unknown. */
export function convertContractAmountToProject(
  amount: number | string | null | undefined,
  opts: {
    contractCurrency: string | null | undefined;
    projectCurrency: string | null | undefined;
    fx: ContractFxPolicy;
    projectFxRates?: ProjectFxRateLike[] | null;
  },
): { amount: number | null; rate: number | null; source: string; label: string } {
  const raw =
    typeof amount === 'number' ? amount : Number(String(amount ?? '').replace(/,/g, ''));
  const resolved = resolveContractFxRate(opts);
  if (!Number.isFinite(raw)) {
    return { amount: null, rate: resolved.rate, source: resolved.source, label: resolved.label };
  }
  if (resolved.rate == null) {
    return { amount: null, rate: null, source: resolved.source, label: resolved.label };
  }
  return {
    amount: raw * resolved.rate,
    rate: resolved.rate,
    source: resolved.source,
    label: resolved.label,
  };
}

export function fxModeLabel(
  mode: ContractFxMode,
  t?: (key: string, opts?: { defaultValue?: string }) => string,
): string {
  const tr = t ?? ((_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k);
  switch (mode) {
    case 'fixed':
      return tr('contracts.fx_mode_fixed', { defaultValue: '固定汇率' });
    case 'spot_at_payment':
      return tr('contracts.fx_mode_spot', {
        defaultValue: '付款时时汇率',
      });
    case 'project':
      return tr('contracts.fx_mode_project', {
        defaultValue: '使用项目汇率表',
      });
    default:
      return tr('contracts.fx_mode_none', {
        defaultValue: '不换算 / 同币种',
      });
  }
}
