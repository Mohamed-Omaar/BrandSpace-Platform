import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Money, formatMoney } from '@brandspace/shared';
import { colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { requireWorkspace } from '../../../../../server/customer-context';
import { checkoutStateFor } from '../../../../../server/commerce-context';
import { brandContextFor } from '../../../../../server/brand-context';
import { translator } from '../../../../../i18n/messages';
import {
  CustomerCard,
  WorkspaceShell,
  customerSecondaryButtonStyle,
} from '../../../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * Where the payment provider sends the browser back.
 *
 * THE OUTCOME IN THE URL IS NOT BELIEVED. `/success` is where a provider
 * redirects on its own success page; it is a navigation hint and nothing more,
 * and a customer who edits it to `success` by hand changes nothing. What this
 * page reports is the CHECKOUT ROW's status, which only a verified provider
 * event can move (§22).
 *
 * SO "WE ARE CONFIRMING YOUR PAYMENT" IS A REAL STATE, not a loading spinner
 * standing in for one. For a moment after a genuine payment the event has not
 * arrived yet, and saying so is the honest answer — the alternative is a receipt
 * for money that may never have moved.
 */
export default async function CheckoutReturnPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; outcome: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, outcome } = await params;
  if (outcome !== 'success' && outcome !== 'cancelled') notFound();

  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'billing.read');
  const query = await searchParams;
  const sessionParam = query['session'];
  const checkoutSessionId = typeof sessionParam === 'string' ? sessionParam : null;

  const session = checkoutSessionId
    ? await checkoutStateFor(workspace.workspaceId, checkoutSessionId)
    : null;

  /*
   * FOUR STATES, and the URL decides none of them.
   *
   *   COMPLETED  a verified event arrived and was reconciled.
   *   PENDING    nothing authoritative has arrived yet — including right after a
   *              genuine payment.
   *   CANCELLED  the customer came back without paying.
   *   EXPIRED    the window closed.
   */
  const status = session?.status ?? (outcome === 'cancelled' ? 'CANCELLED' : 'PENDING');
  const copy =
    status === 'COMPLETED'
      ? { title: t('billing.checkoutCompleteTitle'), body: t('billing.checkoutCompleteBody') }
      : status === 'CANCELLED'
        ? { title: t('billing.checkoutCancelledTitle'), body: t('billing.checkoutCancelledBody') }
        : status === 'EXPIRED'
          ? { title: t('billing.checkoutExpiredTitle'), body: t('billing.checkoutExpiredBody') }
          : { title: t('billing.checkoutPendingTitle'), body: t('billing.checkoutPendingBody') };

  const total = session
    ? formatMoney(
        Money.ofMinor(session.currency, session.totalMinor, session.currencyScale),
        locale === 'ar' ? 'ar' : 'en',
      )
    : null;

  const brandContext = await brandContextFor(workspace, '/billing');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('billing.title')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <CustomerCard title={copy.title} testId={`checkout-${status.toLowerCase()}`}>
        <p style={{ margin: 0, ...typographyTokens.bodySm }} data-testid="checkout-status-body">
          {copy.body}
        </p>
        {total ? (
          <p
            data-testid="checkout-total"
            style={{ marginBlockStart: spacingTokens.sm, ...typographyTokens.h3 }}
          >
            {total}
          </p>
        ) : null}
        <div
          style={{
            display: 'flex',
            gap: spacingTokens.sm,
            marginBlockStart: spacingTokens.md,
            flexWrap: 'wrap',
          }}
        >
          {status === 'PENDING' && checkoutSessionId ? (
            // A RELOAD, NOT A POLLING LOOP THAT PRETENDS. The customer asks
            // again when they choose to, and the answer is whatever
            // reconciliation has actually established by then.
            <Link
              href={`/${locale}/billing/checkout/${outcome}?session=${encodeURIComponent(checkoutSessionId)}`}
              style={customerSecondaryButtonStyle()}
              data-testid="checkout-refresh"
            >
              {t('billing.checkoutRefresh')}
            </Link>
          ) : null}
          <Link
            href={`/${locale}/billing`}
            style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
            data-testid="checkout-back"
          >
            {t('billing.backToBilling')}
          </Link>
        </div>
      </CustomerCard>
    </WorkspaceShell>
  );
}
