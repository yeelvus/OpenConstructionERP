// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
/**
 * Form controls for contract FX policy (fixed / spot-at-payment / project table).
 */
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import {
  type ContractFxMode,
  type ContractFxPolicy,
  convertContractAmountToProject,
  fxModeLabel,
} from './fx';
import { MoneyDisplay } from '@/shared/ui/MoneyDisplay';

const inputCls =
  'h-9 w-full rounded-md border border-border bg-surface-primary px-2.5 text-sm text-content-primary';

export function ContractFxFields({
  value,
  onChange,
  contractCurrency,
  projectCurrency,
  sampleAmount,
  compact,
}: {
  value: ContractFxPolicy;
  onChange: (next: ContractFxPolicy) => void;
  contractCurrency?: string;
  projectCurrency?: string;
  /** Optional amount to preview conversion (e.g. total_value). */
  sampleAmount?: number | string | null;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const ccy = (contractCurrency || '').toUpperCase();
  const base = (projectCurrency || '').toUpperCase();
  const same = !!ccy && !!base && ccy === base;

  const preview =
    sampleAmount != null && !same
      ? convertContractAmountToProject(sampleAmount, {
          contractCurrency: ccy,
          projectCurrency: base,
          fx: value,
        })
      : null;

  return (
    <div className={clsx('space-y-3', compact && 'space-y-2')}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-content-tertiary">
          {t('contracts.fx_mode', { defaultValue: '汇率方式' })}
          <select
            value={value.mode}
            onChange={(e) =>
              onChange({ ...value, mode: e.target.value as ContractFxMode })
            }
            className={clsx(inputCls, 'mt-0.5')}
            data-testid="contract-fx-mode"
          >
            {(
              [
                'none',
                'fixed',
                'spot_at_payment',
                'project',
              ] as ContractFxMode[]
            ).map((m) => (
              <option key={m} value={m}>
                {fxModeLabel(m, t)}
              </option>
            ))}
          </select>
        </label>

        {(value.mode === 'fixed' || value.mode === 'spot_at_payment') && (
          <label className="block text-xs text-content-tertiary">
            {value.mode === 'fixed'
              ? t('contracts.fx_rate_fixed', {
                  defaultValue: '固定汇率（项目币 / 1 合同币）',
                })
              : t('contracts.fx_rate_spot_last', {
                  defaultValue: '最近付款汇率（项目币 / 1 合同币）',
                })}
            <input
              type="number"
              step="any"
              min="0"
              value={
                value.mode === 'spot_at_payment'
                  ? value.last_spot_rate ?? value.rate ?? ''
                  : value.rate ?? ''
              }
              onChange={(e) => {
                const v = e.target.value;
                if (value.mode === 'spot_at_payment') {
                  onChange({ ...value, last_spot_rate: v || null });
                } else {
                  onChange({ ...value, rate: v || null });
                }
              }}
              placeholder={
                ccy && base ? `1 ${ccy} = ? ${base}` : 'e.g. 7.25'
              }
              className={clsx(inputCls, 'mt-0.5 font-mono')}
              data-testid="contract-fx-rate"
            />
          </label>
        )}

        {value.mode === 'fixed' && (
          <label className="block text-xs text-content-tertiary">
            {t('contracts.fx_rate_date', { defaultValue: '汇率约定日期' })}
            <input
              type="date"
              value={value.rate_date ?? ''}
              onChange={(e) =>
                onChange({ ...value, rate_date: e.target.value || null })
              }
              className={clsx(inputCls, 'mt-0.5')}
            />
          </label>
        )}

        {value.mode === 'spot_at_payment' && (
          <label className="block text-xs text-content-tertiary">
            {t('contracts.fx_spot_date', { defaultValue: '最近付款汇率日期' })}
            <input
              type="date"
              value={value.last_spot_date ?? ''}
              onChange={(e) =>
                onChange({ ...value, last_spot_date: e.target.value || null })
              }
              className={clsx(inputCls, 'mt-0.5')}
            />
          </label>
        )}
      </div>

      <label className="block text-xs text-content-tertiary">
        {t('contracts.fx_note', { defaultValue: '汇率备注 / 条款说明' })}
        <input
          value={value.note ?? ''}
          onChange={(e) => onChange({ ...value, note: e.target.value || null })}
          placeholder={t('contracts.fx_note_ph', {
            defaultValue: '例如：按合同第 X 条固定汇率；或付款当日银行中间价',
          })}
          className={clsx(inputCls, 'mt-0.5')}
        />
      </label>

      <p className="text-[11px] leading-relaxed text-content-tertiary">
        {same
          ? t('contracts.fx_same_currency', {
              defaultValue:
                '合同币种与项目本位币相同，无需换算。',
            })
          : value.mode === 'fixed'
            ? t('contracts.fx_hint_fixed', {
                defaultValue:
                  '固定汇率：合同金额 × 汇率 = 项目本位币。汇率定义：1 单位合同币 = N 单位项目币。',
              })
            : value.mode === 'spot_at_payment'
              ? t('contracts.fx_hint_spot', {
                  defaultValue:
                    '付款时时汇率：签约时不定死汇率，每次付款按当日汇率换算；可在此登记最近一次付款汇率供参考。',
                })
              : value.mode === 'project'
                ? t('contracts.fx_hint_project', {
                    defaultValue:
                      '使用项目设置中的 FX 汇率表（与 BOQ 资源换算同一套）。',
                  })
                : t('contracts.fx_hint_none', {
                    defaultValue:
                      '不设置换算策略时，列表仅显示合同原币；需要汇总到项目币时请选择一种方式。',
                  })}
        {ccy && base && !same && (
          <span className="ml-1 font-mono text-content-secondary">
            {ccy} → {base}
          </span>
        )}
      </p>

      {preview && base && (
        <div className="rounded-md border border-border-light bg-surface-secondary/60 px-3 py-2 text-xs">
          <span className="text-content-tertiary">
            {t('contracts.fx_preview', { defaultValue: '换算预览' })}:
          </span>{' '}
          {preview.amount != null ? (
            <span className="font-medium text-content-primary">
              <MoneyDisplay amount={preview.amount} currency={base} />
              <span className="ml-2 font-normal text-content-tertiary">
                ({preview.label})
              </span>
            </span>
          ) : (
            <span className="text-amber-700 dark:text-amber-400">
              {t('contracts.fx_preview_unavailable', {
                defaultValue: '暂无法换算 — {{reason}}',
                reason: preview.label,
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
