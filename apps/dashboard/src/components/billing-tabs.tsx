import { LinkTabs } from '@brandspace/ui';
import { translator } from '../i18n/messages';
import { requestMessageLocale } from '../server/message-locale';
import { paymentsSwitchedOn } from '../server/payments-switch';

/**
 * BILLING & USAGE — ONE SETTINGS SECTION, TWO TABS (Phase 6 final, D-277
 * §44/§46, D-298).
 *
 * The plan and its payments (`/billing`) and the usage, limits and credit
 * history (`/plan`) were two Settings rows a person had to guess between. They
 * are now two addressable tabs of one section, each still its own route with
 * its own `billing.read` check. `LinkTabs`, the existing URL-tab primitive.
 */
export async function BillingTabs({
  locale,
  current,
}: {
  readonly locale: string;
  readonly current: 'billing' | 'usage';
}) {
  const t = translator(requestMessageLocale(locale));
  // PR F (a): with payments off the first tab is the plan alone.
  const payments = await paymentsSwitchedOn();
  return (
    <LinkTabs
      label={t('nav.billing')}
      testId="billing-tabs"
      currentId={current}
      tabs={[
        {
          id: 'billing',
          href: `/${locale}/billing`,
          label: t(payments ? 'billing.tabPayments' : 'billing.tabPlan'),
        },
        { id: 'usage', href: `/${locale}/plan`, label: t('billing.tabUsage') },
      ]}
    />
  );
}
