// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * FX page.
 *
 * The explainer sits at page level, above the tab strip, so it stays findable
 * from the converter, the register and the project policy alike.
 */

import { useTranslation } from 'react-i18next';
import { Coins } from 'lucide-react';

import { CollapsibleSection } from '@/shared/ui/CollapsibleSection';

import { FxPanel } from './FxPanel';

export function FxPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 p-4">
      <CollapsibleSection
        storageKey="fx.how"
        icon={<Coins size={15} className="text-oe-blue" />}
        title={t('fx.flow_title', {
          defaultValue: 'How a converted figure stays explainable',
        })}
      >
        <p className="text-xs text-content-tertiary">
          {t('fx.flow_intro', {
            defaultValue:
              'A project priced in one currency and paid in another is normal, and so is being asked a year later why a number was what it was. The answer has to name the rates it used, which is why every set is kept as it was recorded rather than overwritten.',
          })}
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-content-tertiary">
          <li>
            {t('fx.flow_step1', {
              defaultValue:
                'Rates arrive as sets: the quotes of one base currency on one day, from one source. A set is never edited in place, so two figures converted on different days can both be explained.',
            })}
          </li>
          <li>
            {t('fx.flow_step2', {
              defaultValue:
                'Lock a set you intend to rely on. Locking is what stops the next refresh rewriting it, and it is the only thing that makes pinning worth doing.',
            })}
          </li>
          <li>
            {t('fx.flow_step3', {
              defaultValue:
                'Give the project a policy: which currency it estimates in, buys in and reports in, and how old the rates behind it may be. A project without one is not broken, it simply follows the platform defaults.',
            })}
          </li>
          <li>
            {t('fx.flow_step4', {
              defaultValue:
                'Convert. The figure comes back with the set that produced it named beside it, and a pair the rates cannot price returns no figure at all rather than a plausible wrong one.',
            })}
          </li>
        </ol>
        <p className="mt-2 text-xs text-content-tertiary">
          {t('fx.flow_links', {
            defaultValue:
              'Purchasing power is offered beside the market rate and answers a different question: what an amount buys somewhere else, not what it exchanges for. Compare countries with it, never settle an invoice with it.',
          })}
        </p>
      </CollapsibleSection>

      <FxPanel />
    </div>
  );
}
