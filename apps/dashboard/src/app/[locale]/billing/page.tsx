import Link from 'next/link';
import { ceilingFor, planDisplayName } from '../../../server/plan-usage';
import {
  MULTI_BRAND_FEATURE,
  QUOTA_FEATURES,
  TOTAL_RESOURCE_DIMENSIONS,
} from '@brandspace/entitlements';
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
import { MoreDisclosure } from '../../../components/more-disclosure';
import { CustomerBanner, CustomerEmpty, WorkspaceShell } from '../../../components/workspace-shell';
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
  const access = await requireWorkspacePage(locale, '/billing');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
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

  /*
   * Review of #67 — THE PROTOTYPE'S USAGE BARS (`Main.dc.html` line 1450):
   * brands (with multi-brand), connected accounts, scheduled posts this month
   * and storage, each against the plan's resolved ceiling — the same
   * decisions, counters and live counts the Usage & limits tab shows. A
   * dimension with no stated ceiling draws no bar to nowhere.
   */
  const usage = await inWorkspace(
    workspace.workspaceId,
    async ({ db, entitlements, usage: meter }) => {
      const [effective, counters, multiBrand, brands, accounts] = await Promise.all([
        entitlements.resolveAll(workspace.workspaceId),
        meter.currentCounters(workspace.workspaceId),
        entitlements.can(workspace.workspaceId, MULTI_BRAND_FEATURE),
        TOTAL_RESOURCE_DIMENSIONS.brands.live(db, workspace.workspaceId),
        TOTAL_RESOURCE_DIMENSIONS.socialAccounts.live(db, workspace.workspaceId),
      ]);
      const counted = (featureKey: string): number =>
        Number(counters.find((counter) => counter.featureKey === featureKey)?.used ?? 0);
      const rows = [
        ...(multiBrand
          ? [
              {
                key: 'brands',
                label: t('plan.usageBrands'),
                used: brands,
                feature: QUOTA_FEATURES.brands,
              },
            ]
          : []),
        {
          key: 'social-accounts',
          label: t('plan.usageSocialAccounts'),
          used: accounts,
          feature: QUOTA_FEATURES.socialAccounts,
        },
        {
          key: 'scheduled',
          label: t('plan.usageScheduled'),
          used: counted(QUOTA_FEATURES.scheduledPostsPerMonth),
          feature: QUOTA_FEATURES.scheduledPostsPerMonth,
        },
        {
          key: 'storage',
          label: t('plan.usageStorage'),
          used: counted(QUOTA_FEATURES.storageGb),
          feature: QUOTA_FEATURES.storageGb,
          unit: ' GB',
        },
      ];
      return rows.map((row) => {
        const ceiling = ceilingFor(effective.decisions, row.feature);
        const unit = 'unit' in row ? row.unit : '';
        return {
          key: row.key,
          label: row.label,
          value:
            ceiling.kind === 'limited'
              ? `${row.used}${unit} / ${ceiling.limit}${unit}`
              : t('plan.usageUnstated').replace('{used}', `${row.used}${unit}`),
          pct:
            ceiling.kind === 'limited' && ceiling.limit > 0
              ? Math.max(2, Math.min(100, Math.round((row.used / ceiling.limit) * 100)))
              : null,
        };
      });
    },
  ).catch(() => []);

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
  const currentPrice = subscription
    ? (snapshot.availability.find((a) => a.planKey === subscription.planKey)?.monthly ?? null)
    : null;

  const exportForm = (
    <>
      {/*
        PHASE 10 §24 — THE ACCOUNTING EXPORT.

        A PLAIN GET FORM, deliberately. The browser turns it into a download
        with no JavaScript at all, which is what an accountant on a locked-down
        machine actually gets to use. The period is required and bounded by the
        route; a whole commercial record in one unbounded file is a query nobody
        bounded.
      */}
      <div className="bsp-fdis-field" data-testid="accounting-export-card">
        <span className="bsp-fdis-label">{t('billing.export')}</span>
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
      </div>
    </>
  );
  const cancelForm =
    mayManage && subscription && !subscription.cancelAtPeriodEnd ? (
      <div className="bsp-fdis-field" data-testid="cancel-card">
        <span className="bsp-fdis-label">{t('billing.cancel')}</span>
        <CancelSubscriptionForm
          failedLabel={t('billing.actionFailed')}
          title={t('billing.cancelTitle')}
          body={t('billing.cancelBody')}
          reasonLabel={t('billing.cancelReason')}
          confirmLabel={t('billing.cancelConfirm')}
          submitLabel={t('billing.cancelSubmit')}
          busyLabel={t('billing.checkoutOpening')}
        />
      </div>
    ) : null;
  const buyCreditsLabel =
    snapshot.packs.length === 1 && snapshot.packs[0]
      ? fill('billing.buyCredits', {
          // Western digits with grouping in both languages, as the prototype's "1,000".
          credits: snapshot.packs[0].pack.credits.toLocaleString('en'),
        })
      : t('billing.packs');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('nav.settings')}
      description={t('settings.p.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <SettingsFrame locale={locale} permissionKeys={workspace.permissionKeys} selected="billing">
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

        {/*
          D-468 — THE PROTOTYPE'S PLAN & BILLING, `Main.dc.html` lines 1445–1463:
          the plan and the credits side by side (1.2fr / 1fr), the plans, the
          packs, then the invoices as rows.
        */}
        <div className="bsp-bl-top">
          <section
            className="bsp-card bsp-bl-card"
            data-testid="subscription-card"
            aria-label={t('billing.subscription')}
          >
            {subscription ? (
              <>
                <div className="bsp-bl-planh">
                  <span className="bsp-bl-pname" data-testid="billing-plan">
                    {planDisplayName(subscription.planKey, snapshot.plans, locale) ?? ''}
                  </span>
                  {currentPrice ? (
                    <span className="bsp-ltr bsp-bl-price">
                      {show(currentPrice)} / {t('billing.perMonth')}
                    </span>
                  ) : null}
                </div>
                <span className="bsp-bl-sub">
                  <span data-testid="billing-status">
                    {t(`billing.status.${subscription.status}` as MessageKey)}
                  </span>
                  {' · '}
                  {subscription.status === 'TRIALING'
                    ? t('billing.trialEnds')
                    : t('billing.renews')}{' '}
                  <span data-testid="billing-period">
                    {day(
                      subscription.status === 'TRIALING'
                        ? subscription.trialEndsAt
                        : subscription.currentPeriodEnd,
                    )}
                  </span>
                </span>
              </>
            ) : (
              <>
                <p data-testid="no-subscription" className="bsp-bl-pname">
                  {t('billing.noSubscription')}
                </p>
                <p className="bsp-bl-sub">{t('billing.noSubscriptionBody')}</p>
              </>
            )}

            {subscription?.pendingPlanKey ? (
              <div className="bsp-bl-pending" data-testid="pending-change">
                <span className="bsp-xstatus bsp-info">{t('billing.pendingChange')}</span>
                <p className="bsp-bl-sub">
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
            {usage.length > 0 ? (
              <div className="bsp-bl-usage" data-testid="billing-usage">
                {usage.map((row) => (
                  <div
                    key={row.key}
                    className="bsp-bl-urow"
                    data-testid={`billing-usage-${row.key}`}
                  >
                    <div className="bsp-bl-uhead">
                      <span>{row.label}</span>
                      <span className="bsp-ltr bsp-bl-uval">{row.value}</span>
                    </div>
                    {row.pct !== null ? (
                      <div className="bsp-bl-ubar" aria-hidden="true">
                        <div style={{ width: `${row.pct}%` }} />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="bsp-bl-acts">
              {/*
                "Change plan" opens the plans in place, as the prototype's does
                (line 1452); "Usage & limits" is the detail page; the export and
                cancelling, which the prototype does not draw, are under "⋯".
              */}
              <details className="bsp-bl-change">
                <summary className="bsp-btn bsp-sm bsp-sec" data-testid="billing-change-plan">
                  {mayManage ? t('billing.changePlan') : t('billing.plans')}
                </summary>
                <div className="bsp-bl-plans" data-testid="plans-card">
                  <p style={mutedStyle}>
                    {fill('billing.plansIn', { currency: snapshot.currency })}
                  </p>
                  <p style={mutedStyle}>{t('billing.downgradeNotice')}</p>
                  <div className="bsp-bl-tiles">
                    {snapshot.plans.map((plan) => {
                      const availability = snapshot.availability.find(
                        (a) => a.planKey === plan.key,
                      );
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
                          className="bsp-bl-tile"
                          data-current={isCurrent ? 'true' : undefined}
                        >
                          <h3 className="bsp-bl-tname">
                            {locale === 'ar' ? plan.nameAr : plan.nameEn}
                          </h3>
                          <p style={mutedStyle}>
                            {locale === 'ar' ? plan.descriptionAr : plan.descriptionEn}
                          </p>

                          {availability?.available && availability.monthly ? (
                            <p
                              data-testid={`plan-price-${plan.key}`}
                              className="bsp-ltr bsp-bl-tprice"
                            >
                              {show(availability.monthly)}{' '}
                              <span
                                style={{
                                  ...typographyTokens.caption,
                                  color: colorTokens.textMuted,
                                }}
                              >
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
                            <span
                              data-testid={`plan-current-${plan.key}`}
                              className="bsp-xstatus bsp-ai bsp-bl-start"
                            >
                              {t('billing.currentPlan')}
                            </span>
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
                </div>
              </details>
              <Link
                href={`/${locale}/plan`}
                className="bsp-btn bsp-sm bsp-ghost"
                data-testid="billing-usage-link"
              >
                {t('billing.usageLink')} →
              </Link>
              <MoreDisclosure label={t('billing.more')} testId="billing-more" align="start">
                {exportForm}
                {cancelForm}
                <p style={mutedStyle}>{t('billing.creditNoteNotice')}</p>
              </MoreDisclosure>
            </div>
          </section>

          <section className="bsp-card bsp-bl-card" data-testid="credits-card">
            <span className="bsp-lbl">{t('billing.credits')}</span>
            {wallet ? (
              <>
                <p
                  data-testid="credit-balance"
                  className="bsp-ltr bsp-bl-big"
                  aria-label={t('billing.creditsBalance')}
                >
                  {wallet.balanceCredits}
                </p>
                {/* D-196 stated where the customer can act on it, not buried in a
                  policy page: prepaid, hard stop, no debt. */}
                <p className="bsp-bl-sub">
                  {wallet.balanceCredits === 0
                    ? t('billing.creditsZero')
                    : t('billing.creditsPrepaid')}
                </p>
              </>
            ) : (
              <p className="bsp-bl-sub">{t('billing.creditsPrepaid')}</p>
            )}
            {snapshot.packs.length > 0 ? (
              <details className="bsp-bl-change">
                <summary className="bsp-btn bsp-sm bsp-pur" data-testid="billing-buy-credits">
                  {buyCreditsLabel}
                </summary>
                <div className="bsp-bl-plans" data-testid="packs-card">
                  <p style={mutedStyle}>{t('billing.creditsPrepaid')}</p>
                  {snapshot.packs.length === 0 ? (
                    <CustomerEmpty message={t('billing.packsEmpty')} />
                  ) : (
                    <div className="bsp-bl-tiles">
                      {snapshot.packs.map((offer) => (
                        <section
                          key={offer.pack.key}
                          data-testid={`pack-${offer.pack.key}`}
                          className="bsp-bl-tile"
                        >
                          <h3 className="bsp-bl-tname">
                            {locale === 'ar' ? offer.pack.name.ar : offer.pack.name.en}
                          </h3>
                          <p style={{ margin: 0, ...typographyTokens.bodySm }}>
                            {fill('billing.packCredits', { credits: String(offer.pack.credits) })}
                          </p>
                          <p className="bsp-ltr bsp-bl-tprice">{show(offer.price)}</p>
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
                </div>
              </details>
            ) : null}
          </section>
        </div>

        {/* The invoices, as the prototype's card of rows (line 1462), no heading. */}
        <section className="bsp-card bsp-bl-invcard" data-testid="invoices-card">
          {overview.invoices.length === 0 ? (
            <p className="bsp-bl-none">{t('billing.invoicesEmpty')}</p>
          ) : (
            <ul
              className="bsp-bl-inv"
              aria-label={t('billing.invoices')}
              data-testid="invoices-table"
            >
              {overview.invoices.map((invoice) => (
                <li key={invoice.id} className="bsp-row" data-testid={`invoice-${invoice.id}`}>
                  <span className="bsp-ltr bsp-bl-ino">{invoice.number ?? '—'}</span>
                  <span className="bsp-bl-idate">{day(invoice.issuedAt)}</span>
                  <span className="bsp-ltr bsp-bl-iamt">{show(invoice.total)}</span>
                  <span
                    className={`bsp-pill ${invoice.status === 'PAID' ? 'bsp-p-ok' : 'bsp-p-neu'}`}
                  >
                    {t(`billing.invoiceStatus.${invoice.status}` as MessageKey)}
                  </span>
                  <Link
                    href={`/${locale}/billing/invoices/${invoice.id}`}
                    className="bsp-btn bsp-sm bsp-ghost"
                  >
                    {t('billing.invoiceView')}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </SettingsFrame>
    </WorkspaceShell>
  );
}

const mutedStyle = {
  margin: 0,
  ...typographyTokens.caption,
  color: colorTokens.textMuted,
} as const;
