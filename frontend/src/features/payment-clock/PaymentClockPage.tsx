// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Payment Clock page.
 *
 * The explainer sits at page level, above the working area, so it stays
 * findable rather than disappearing with whatever is selected.
 */

import { useTranslation } from 'react-i18next';
import { Scale } from 'lucide-react';

import { CollapsibleSection } from '@/shared/ui/CollapsibleSection';

import { PaymentClockPanel } from './PaymentClockPanel';

export function PaymentClockPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 p-4">
      <CollapsibleSection
        storageKey="payment_clock.how"
        icon={<Scale size={15} className="text-oe-blue" />}
        title={t('payment_clock.flow_title', {
          defaultValue: 'How the payment clock works, and what it protects',
        })}
      >
        <p className="text-xs text-content-tertiary">
          {t('payment_clock.flow_intro', {
            defaultValue:
              'Construction payment statutes give each application a timetable, and missing a step on it changes what is legally payable. This module keeps that timetable per application so the deadline is known before it passes rather than after.',
          })}
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-content-tertiary">
          <li>
            {t('payment_clock.flow_step1', {
              defaultValue:
                'Open a clock over a payment application and pick the statutory regime the contract falls under.',
            })}
          </li>
          <li>
            {t('payment_clock.flow_step2', {
              defaultValue:
                'The due date, payment notice deadline, pay less deadline and final date for payment are computed from that regime, counting calendar or business days as the statute counts them.',
            })}
          </li>
          <li>
            {t('payment_clock.flow_step3', {
              defaultValue:
                'Record each notice as it is served. A notice served late is still recorded, because that fact is the point.',
            })}
          </li>
          <li>
            {t('payment_clock.flow_step4', {
              defaultValue:
                'The sum payable follows: where a valid notice was served it is the notified sum, and where the window closed it is the sum applied for.',
            })}
          </li>
        </ol>
        <p className="mt-2 text-xs text-content-tertiary">
          {t('payment_clock.flow_links', {
            defaultValue:
              'Feeds from Contracts progress claims and Subcontractor payment applications, and its breaches show up in Validation.',
          })}
        </p>
      </CollapsibleSection>

      <PaymentClockPanel />
    </div>
  );
}
