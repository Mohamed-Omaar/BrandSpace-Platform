import Link from 'next/link';
import { planDisplayName } from '../../../server/plan-usage';
import { formatMoney, systemClock, type Money, mayReadCreditBalance } from '@brandspace/shared';
import {
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import {
  inWorkspace,
  memberDisplayName,
  workspaceOwnerName,
  requireWorkspacePage,
} from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { PermissionNotice } from '../../../components/permission-notice';
import { billingOverviewFor, commerceSnapshotFor } from '../../../server/commerce-context';
import { brandContextFor } from '../../../server/brand-context';
import { translator, type MessageKey } from '../../../i18n/messages';
import { SettingsFrame } from '../../../components/settings-frame';
import { BillingTabs } from '../../../components/billing-tabs';
import {
  CustomerBanner,
  CustomerCard,
  CustomerEmpty,
  WorkspaceShell,
  customerTableStyle,
  customerTdStyle,
  customerThStyle,
} from '../../../components/workspace-shell';
import {
  BuyPackButton,
  BuyPlanButton,
  CancelSubscriptionForm,
  ScheduleDowngradeButton,
  SimpleActionButton,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * Billing & Usage — what this workspace is on, what it owes, what it has bought.
 *
 * EVERY AMOUNT IS SHOWN IN THE WORKSPACE'S OWN CURRENCY, at that currency's own
 * number of decimal places. A three-digit currency renders three digits and a
 * two-digit currency renders two, because the scale travels with the money
 * rather than being assumed (§6).
 *
 * A PLAN THIS WORKSPACE CANNOT BUY IS SHOWN WITH ITS REASON, not omitted. "We do
 * not sell this plan in your country" and "this plan has no price in your
 * currency" are different facts, and an empty list leaves a customer unable to
 * act on either (§21).
 *
 * NOTHING ON THIS PAGE CAN CONFIRM A PAYMENT. Every button posts a key and gets
 * back a URL to somebody else's page.
 */
export default async function BillingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  const access = await requireWorkspacePage(locale, '/billing');
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;
  const mayManage = workspace.permissionKeys.includes('billing.manage');
  // Q18 — the balance is shown to the people who spend it (`credits.read` + `copilot.use`).
  const mayReadCredits = mayReadCreditBalance(workspace.permissionKeys);

  const snapshot = await commerceSnapshotFor(workspace.workspaceId);
  const overview = await billingOverviewFor(workspace.workspaceId, snapshot.currencyScale);
  const wallet = mayReadCredits
    ? await inWorkspace(workspace.workspaceId, async ({ credits }) =>
        credits.wallet(workspace.workspaceId),
      )
    : null;

  const show = (value: Money): string => formatMoney(value, locale === 'ar' ? 'ar' : 'en');
  const day = (value: Date | null): string => (value ? value.toISOString().slice(0, 10) : '—');

  /*
   * A DEFAULT PERIOD OF THE LAST TWELVE MONTHS, which is the span an accountant
   * asks for most often and which the route's ceiling allows in one file. It is
   * only a default: both fields are editable and required.
   */
  const today = systemClock.now();
  const defaultExportTo = today.toISOString().slice(0, 10);
  const defaultExportFrom = new Date(
    Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate() + 1),
  )
    .toISOString()
    .slice(0, 10);
  const fill = (key: MessageKey, values: Record<string, string>): string =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, value),
      t(key),
    );

  const subscription = overview.subscription;
  const currentTier = snapshot.plans.find((plan) => plan.key === subscription?.planKey)?.tier ?? -1;

  const brandContext = await brandContextFor(workspace, '/billing');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('billing.title')}
      description={t('billing.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <SettingsFrame locale={locale} permissionKeys={workspace.permissionKeys} selected="billing">
        <BillingTabs locale={locale} current="billing" />
        {/* A5/E6 — changing the plan or payment method is owner-only; say so
          once, where the buttons would be, instead of leaving them missing. */}
        {mayManage ? null : (
          <PermissionNotice
            locale={locale}
            permissionKey="billing.manage"
            memberName={memberDisplayName(customer)}
            ownerName={await workspaceOwnerName(workspace.workspaceId)}
          />
        )}
        {/* The three states dunning can put a workspace in, each said plainly and
          each stating what is NOT happening: nothing is being deleted. */}
        {subscription?.status === 'SUSPENDED' ? (
          <CustomerBanner tone="error">
            <strong>{t('billing.suspendedTitle')}</strong> {t('billing.suspendedBody')}
          </CustomerBanner>
        ) : null}
        {subscription?.status === 'PAST_DUE' ? (
          <CustomerBanner tone="warning">
            <strong>{t('billing.pastDue')}</strong>{' '}
            {fill('billing.pastDueBody', { date: day(subscription.graceEndsAt) })}
          </CustomerBanner>
        ) : null}
        {subscription?.cancelAtPeriodEnd ? (
          <CustomerBanner tone="warning">
            {fill('billing.cancelScheduled', { date: day(subscription.currentPeriodEnd) })}{' '}
            {mayManage ? (
              <SimpleActionButton
                failedLabel={t('billing.actionFailed')}
                path="/api/commerce/subscription/resume"
                label={t('billing.resume')}
                busyLabel={t('billing.checkoutOpening')}
                testId="resume-subscription"
              />
            ) : null}
          </CustomerBanner>
        ) : null}

        <div className="bs-split-main">
          <CustomerCard title={t('billing.subscription')} testId="subscription-card">
            {subscription ? (
              <dl style={{ margin: 0, display: 'grid', gap: spacingTokens.xs }}>
                <Row
                  label={t('billing.plan')}
                  value={planDisplayName(subscription.planKey, snapshot.plans, locale) ?? ''}
                  testId="billing-plan"
                />
                <Row
                  label={t('billing.status')}
                  value={t(`billing.status.${subscription.status}` as MessageKey)}
                  testId="billing-status"
                />
                <Row
                  label={
                    subscription.status === 'TRIALING'
                      ? t('billing.trialEnds')
                      : t('billing.renews')
                  }
                  value={day(
                    subscription.status === 'TRIALING'
                      ? subscription.trialEndsAt
                      : subscription.currentPeriodEnd,
                  )}
                  testId="billing-period"
                />
              </dl>
            ) : (
              <>
                <p data-testid="no-subscription" style={{ margin: 0, ...typographyTokens.bodySm }}>
                  {t('billing.noSubscription')}
                </p>
                <p style={mutedStyle}>{t('billing.noSubscriptionBody')}</p>
              </>
            )}

            {subscription?.pendingPlanKey ? (
              <div style={{ marginBlockStart: spacingTokens.sm }} data-testid="pending-change">
                <p style={{ margin: 0, ...typographyTokens.bodySm }}>
                  {t('billing.pendingChange')}
                </p>
                <p style={mutedStyle}>
                  {fill('billing.pendingChangeBody', {
                    plan:
                      planDisplayName(subscription.pendingPlanKey, snapshot.plans, locale) ??
                      subscription.pendingPlanKey,
                    date: day(subscription.pendingPlanEffectiveAt),
                  })}
                </p>
                {mayManage ? (
                  <SimpleActionButton
                    failedLabel={t('billing.actionFailed')}
                    path="/api/commerce/subscription/downgrade-cancel"
                    label={t('billing.pendingChangeCancel')}
                    busyLabel={t('billing.checkoutOpening')}
                    testId="clear-pending-change"
                  />
                ) : null}
              </div>
            ) : null}
          </CustomerCard>

          <CustomerCard title={t('billing.credits')} testId="credits-card">
            {wallet ? (
              <>
                <p
                  data-testid="credit-balance"
                  style={{ margin: 0, ...typographyTokens.h3 }}
                  aria-label={t('billing.creditsBalance')}
                >
                  {wallet.balanceCredits}
                </p>
                {/* D-196 stated where the customer can act on it, not buried in a
                  policy page: prepaid, hard stop, no debt. */}
                <p style={mutedStyle}>
                  {wallet.balanceCredits === 0
                    ? t('billing.creditsZero')
                    : t('billing.creditsPrepaid')}
                </p>
              </>
            ) : (
              <CustomerEmpty message={t('billing.creditsPrepaid')} />
            )}
          </CustomerCard>
        </div>

        <CustomerCard title={t('billing.plans')} testId="plans-card">
          <p style={mutedStyle}>{fill('billing.plansIn', { currency: snapshot.currency })}</p>
          <p style={mutedStyle}>{t('billing.downgradeNotice')}</p>
          <div
            style={{
              display: 'grid',
              gap: spacingTokens.md,
              gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))',
              marginBlockStart: spacingTokens.sm,
            }}
          >
            {snapshot.plans.map((plan) => {
              const availability = snapshot.availability.find((a) => a.planKey === plan.key);
              /*
               * "CURRENT" MEANS PAID FOR, not merely assigned.
               *
               * A trial runs ON a plan, so treating that as current left a
               * trialing customer looking at "Your current plan" with no way to
               * pay for it — the conversion the whole trial exists to produce.
               * Found by the end-to-end journey, which could not buy anything.
               */
              const isCurrent =
                subscription?.planKey === plan.key && subscription.status !== 'TRIALING';
              const isDowngrade = plan.tier < currentTier;
              return (
                <section
                  key={plan.key}
                  data-testid={`plan-${plan.key}`}
                  style={{
                    border: `1px solid ${colorTokens.hairline}`,
                    borderRadius: '0.75rem',
                    padding: spacingTokens.md,
                    display: 'grid',
                    gap: spacingTokens.xs,
                    alignContent: 'start',
                  }}
                >
                  <h3 style={{ margin: 0, ...typographyTokens.h3 }}>
                    {locale === 'ar' ? plan.nameAr : plan.nameEn}
                  </h3>
                  <p style={mutedStyle}>
                    {locale === 'ar' ? plan.descriptionAr : plan.descriptionEn}
                  </p>

                  {availability?.available && availability.monthly ? (
                    <p
                      data-testid={`plan-price-${plan.key}`}
                      style={{ margin: 0, ...typographyTokens.h3 }}
                    >
                      {show(availability.monthly)}{' '}
                      <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                        {t('billing.perMonth')}
                      </span>
                    </p>
                  ) : (
                    /* THE REASON, NOT AN OMISSION. A plan with no price in this
                     currency says so — nothing is converted to fill the gap. */
                    <p data-testid={`plan-unavailable-${plan.key}`} style={mutedStyle}>
                      {fill(
                        `billing.unavailable.${availability?.reason ?? 'not_active'}` as MessageKey,
                        { currency: snapshot.currency },
                      )}
                    </p>
                  )}

                  {isCurrent ? (
                    <p data-testid={`plan-current-${plan.key}`} style={mutedStyle}>
                      {t('billing.currentPlan')}
                    </p>
                  ) : mayManage && availability?.available ? (
                    isDowngrade ? (
                      <ScheduleDowngradeButton
                        failedLabel={t('billing.actionFailed')}
                        planKey={plan.key}
                        label={t('billing.downgradeSchedule')}
                        busyLabel={t('billing.checkoutOpening')}
                        testId={`plan-downgrade-${plan.key}`}
                      />
                    ) : (
                      <BuyPlanButton
                        locale={locale}
                        planKey={plan.key}
                        billingInterval="MONTH"
                        label={t('billing.choosePlan')}
                        busyLabel={t('billing.checkoutOpening')}
                        failedLabel={t('billing.checkoutFailed')}
                        redirectNotice={t('billing.checkoutRedirect')}
                        testId={`plan-buy-${plan.key}`}
                      />
                    )
                  ) : null}
                </section>
              );
            })}
          </div>
        </CustomerCard>

        <CustomerCard title={t('billing.packs')} testId="packs-card">
          <p style={mutedStyle}>{t('billing.creditsPrepaid')}</p>
          {snapshot.packs.length === 0 ? (
            <CustomerEmpty message={t('billing.packsEmpty')} />
          ) : (
            <div
              style={{
                display: 'grid',
                gap: spacingTokens.md,
                gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
              }}
            >
              {snapshot.packs.map((offer) => (
                <section
                  key={offer.pack.key}
                  data-testid={`pack-${offer.pack.key}`}
                  style={{
                    border: `1px solid ${colorTokens.hairline}`,
                    borderRadius: '0.75rem',
                    padding: spacingTokens.md,
                    display: 'grid',
                    gap: spacingTokens.xs,
                  }}
                >
                  <h3 style={{ margin: 0, ...typographyTokens.h3 }}>
                    {locale === 'ar' ? offer.pack.name.ar : offer.pack.name.en}
                  </h3>
                  <p style={{ margin: 0, ...typographyTokens.bodySm }}>
                    {fill('billing.packCredits', { credits: String(offer.pack.credits) })}
                  </p>
                  <p style={{ margin: 0, ...typographyTokens.h3 }}>{show(offer.price)}</p>
                  {offer.pack.expiryDays ? (
                    <p style={mutedStyle}>
                      {fill('billing.packExpiry', { days: String(offer.pack.expiryDays) })}
                    </p>
                  ) : null}
                  {mayManage ? (
                    <BuyPackButton
                      locale={locale}
                      packKey={offer.pack.key}
                      label={t('billing.packBuy')}
                      busyLabel={t('billing.checkoutOpening')}
                      failedLabel={t('billing.checkoutFailed')}
                      confirm={{
                        title: t('billing.packConfirmTitle'),
                        body: fill('billing.packConfirmBody', {
                          credits: String(offer.pack.credits),
                          price: show(offer.price),
                        }),
                        submitLabel: t('billing.packConfirmSubmit'),
                        cancelLabel: t('billing.packConfirmCancel'),
                        closeLabel: t('common.close'),
                      }}
                      testId={`pack-buy-${offer.pack.key}`}
                    />
                  ) : null}
                </section>
              ))}
            </div>
          )}
        </CustomerCard>

        <CustomerCard title={t('billing.invoices')} testId="invoices-card">
          {overview.invoices.length === 0 ? (
            <CustomerEmpty message={t('billing.invoicesEmpty')} />
          ) : (
            <table style={customerTableStyle()} data-testid="invoices-table">
              <thead>
                <tr>
                  <th style={customerThStyle()}>{t('billing.invoiceNumber')}</th>
                  <th style={customerThStyle()}>{t('billing.invoiceDate')}</th>
                  <th style={customerThStyle()}>{t('billing.status')}</th>
                  <th style={customerThStyle()}>{t('billing.invoiceTotal')}</th>
                  <th style={customerThStyle()}>
                    <span className="bs-visually-hidden">{t('billing.invoiceView')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {overview.invoices.map((invoice) => (
                  <tr key={invoice.id} data-testid={`invoice-${invoice.id}`}>
                    <td style={customerTdStyle()}>{invoice.number ?? '—'}</td>
                    <td style={customerTdStyle()}>{day(invoice.issuedAt)}</td>
                    <td style={customerTdStyle()}>
                      {t(`billing.invoiceStatus.${invoice.status}` as MessageKey)}
                    </td>
                    <td style={customerTdStyle()}>{show(invoice.total)}</td>
                    <td style={customerTdStyle()}>
                      <Link href={`/${locale}/billing/invoices/${invoice.id}`}>
                        {t('billing.invoiceView')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p style={mutedStyle}>{t('billing.creditNoteNotice')}</p>
        </CustomerCard>

        {/*
        PHASE 10 §24 — THE ACCOUNTING EXPORT.

        A PLAIN GET FORM, deliberately. The browser turns it into a download
        with no JavaScript at all, which is what an accountant on a locked-down
        machine actually gets to use. The period is required and bounded by the
        route; a whole commercial record in one unbounded file is a query nobody
        bounded.
      */}
        <CustomerCard title={t('billing.export')} testId="accounting-export-card">
          <p style={mutedStyle}>{t('billing.exportNote')}</p>
          <form
            action="/api/billing/export"
            method="get"
            data-testid="accounting-export-form"
            style={{
              display: 'flex',
              gap: spacingTokens.md,
              alignItems: 'flex-end',
              flexWrap: 'wrap',
              marginBlockStart: spacingTokens.sm,
            }}
          >
            <div style={{ display: 'grid', gap: spacingTokens.xs }}>
              <label htmlFor="export-from" style={{ ...typographyTokens.caption }}>
                {t('billing.exportFrom')}
              </label>
              <input
                className="bs-control"
                id="export-from"
                name="from"
                type="date"
                required
                defaultValue={defaultExportFrom}
                data-testid="export-from"
                style={inputStyle()}
              />
            </div>
            <div style={{ display: 'grid', gap: spacingTokens.xs }}>
              <label htmlFor="export-to" style={{ ...typographyTokens.caption }}>
                {t('billing.exportTo')}
              </label>
              <input
                className="bs-control"
                id="export-to"
                name="to"
                type="date"
                required
                defaultValue={defaultExportTo}
                data-testid="export-to"
                style={inputStyle()}
              />
            </div>
            {/*
            THE DESIGN SYSTEM'S BUTTON, NOT THE BROWSER'S (P6-02).

            This shipped as a bare `<button>` with no class and no style, so it
            rendered in the browser's own button chrome — a grey bevelled box
            beside two design-system date fields. It is the control the owner
            reported, and it is the reason P6-02 fixes this through
            `buttonStyle`/`buttonClass` rather than a rule on this page: one
            call site forgetting the system is a defect the system should not
            allow, and `tests/unit/phase6-control-consistency.test.ts` now fails
            if another appears.

            A plain submit, NOT the `Button` component: `Button` is a client
            component that defaults to `type="button"`, and this form's whole
            point is that the browser performs the GET with no JavaScript at all
            (an accountant on a locked-down machine). So it takes the same
            style and the same interaction classes by the same functions.
          */}
            <button
              type="submit"
              data-testid="export-submit"
              className={buttonClass('primary')}
              style={buttonStyle('primary')}
            >
              {t('billing.exportSubmit')}
            </button>
          </form>
        </CustomerCard>

        {mayManage && subscription && !subscription.cancelAtPeriodEnd ? (
          <CustomerCard title={t('billing.cancel')} testId="cancel-card">
            <CancelSubscriptionForm
              failedLabel={t('billing.actionFailed')}
              title={t('billing.cancelTitle')}
              body={t('billing.cancelBody')}
              reasonLabel={t('billing.cancelReason')}
              confirmLabel={t('billing.cancelConfirm')}
              submitLabel={t('billing.cancelSubmit')}
              busyLabel={t('billing.checkoutOpening')}
            />
          </CustomerCard>
        ) : null}
      </SettingsFrame>
    </WorkspaceShell>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: spacingTokens.sm }}>
      <dt style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>{label}</dt>
      <dd data-testid={testId} style={{ margin: 0, ...typographyTokens.caption, textAlign: 'end' }}>
        {value}
      </dd>
    </div>
  );
}

const mutedStyle = {
  margin: 0,
  ...typographyTokens.caption,
  color: colorTokens.textMuted,
} as const;
