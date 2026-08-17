// DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
// Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
/**
 * Tax Withholding page.
 *
 * The explainer sits at page level, above the working area, so it stays
 * findable rather than disappearing with whatever is selected.
 */

import { useTranslation } from 'react-i18next';
import { Receipt } from 'lucide-react';

import { CollapsibleSection } from '@/shared/ui/CollapsibleSection';

import { TaxWithholdingPanel } from './TaxWithholdingPanel';

export function TaxWithholdingPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 p-4">
      <CollapsibleSection
        storageKey="tax_withholding.how"
        icon={<Receipt size={15} className="text-oe-blue" />}
        title={t('tax_withholding.flow_title', {
          defaultValue: 'How construction tax withholding works, and what it protects',
        })}
      >
        <p className="text-xs text-content-tertiary">
          {t('tax_withholding.flow_intro', {
            defaultValue:
              'Several countries make the payer deduct tax at source when paying a construction subcontractor, at a rate that depends on whether that subcontractor is verified with the tax authority. Deducting at the wrong rate is the payer problem, not the payee problem, so this module works the figure out before the payment rather than after.',
          })}
        </p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-content-tertiary">
          <li>
            {t('tax_withholding.flow_step1', {
              defaultValue:
                'Install the schemes for the countries you work in. Each one carries its rate bands, whether materials and VAT come out of the taxable base, and any exemption limit.',
            })}
          </li>
          <li>
            {t('tax_withholding.flow_step2', {
              defaultValue:
                'Record each party standing under a scheme: the band they are entitled to, the reference the authority gave, and the dates the verification covers.',
            })}
          </li>
          <li>
            {t('tax_withholding.flow_step3', {
              defaultValue:
                'Before a payment, preview the deduction. A band that needs a verification is only kept while that verification holds, and a party who has lost it drops to the scheme default, which is its highest rate.',
            })}
          </li>
          <li>
            {t('tax_withholding.flow_step4', {
              defaultValue:
                'The preview reports the drop rather than only applying it, so a rate that went up is a decision somebody made and not a surprise on a remittance.',
            })}
          </li>
        </ol>
        <p className="mt-2 text-xs text-content-tertiary">
          {t('tax_withholding.flow_links', {
            defaultValue:
              'Schemes and party standings are company-wide rather than per project, because a subcontractor is verified once and not once per job. Recorded deductions and reverse-charge determinations sit on a project and are reached from its payments.',
          })}
        </p>
      </CollapsibleSection>

      <TaxWithholdingPanel />
    </div>
  );
}
