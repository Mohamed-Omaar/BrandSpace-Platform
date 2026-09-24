import { LinkTabs } from '@brandspace/ui';
import { translator } from '../i18n/messages';

/**
 * BILLING & USAGE — ONE SETTINGS SECTION, TWO TABS (Phase 6 final, D-277
 * §44/§46, D-298).
 *
 * The plan and its payments (`/billing`) and the usage, limits and credit
 * history (`/plan`) were two Settings rows a person had to guess between. They
 * are now two addressable tabs of one section, each still its own route with
 * its own `billing.read` check. `LinkTabs`, the existing URL-tab primitive.
 */
export function BillingTabs({
  locale,
  current,
}: {
  readonly locale: string;
  readonly current: 'billing' | 'usage';
}) {
  const t = translator(locale);
  return (
    <LinkTabs
      label={t('nav.billing')}
      testId="billing-tabs"
      currentId={current}
      tabs={[
        { id: 'billing', href: `/${locale}/billing`, label: t('billing.tabPayments') },
        { id: 'usage', href: `/${locale}/plan`, label: t('billing.tabUsage') },
      ]}
    />
  );
}
