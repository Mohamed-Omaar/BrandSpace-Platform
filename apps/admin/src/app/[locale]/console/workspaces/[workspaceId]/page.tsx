import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import {
  Breadcrumbs,
  PageHeader,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { UsageService } from '@brandspace/entitlements';
import {
  getBetaCohortService,
  getCreditLedgerService,
  getCreditService,
  getEntitlementService,
  getInvitationService,
  getMembershipService,
  getPlatformPrisma,
  getSubscriptionService,
  getWorkspaceService,
  requirePageActor,
  serviceActor,
} from '../../../../../server/platform-context';
import { translator } from '../../../../../i18n/messages';
import { errorMessage, successMessage } from '../../../../../i18n/status-messages';
import {
  Banner,
  Card,
  EmptyState,
  Field,
  StatusPill,
  TableScroll,
  dangerButtonStyle,
  inputStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  tableStyle,
  tdStyle,
  thStyle,
} from '../../../../../components/console-ui';
import {
  addCohortAction,
  adjustCreditsAction,
  assignPlanAction,
  removeCohortAction,
  changeStatusAction,
  inviteMemberAction,
  revokeInvitationAction,
  revokeOverrideAction,
  setOverrideAction,
  updateWorkspaceAction,
} from '../actions';
import { SimpleCustomerDetail } from '../../../../../components/simple/customers';
import { getConsoleMode } from '../../../../../server/console-mode-cookie';

export const dynamic = 'force-dynamic';

/**
 * Workspace detail — everything the Control Center actually knows.
 *
 * Each section is rendered only when the actor holds the permission that
 * governs it. That is a convenience for the operator; the SERVICE behind every
 * form checks again, so a hand-crafted POST from a role without the permission
 * is refused server-side (R-02).
 */
export default async function WorkspaceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; workspaceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, workspaceId } = await params;
  const query = await searchParams;
  const actor = await requirePageActor(locale, 'platform.workspace.read');
  // Simple mode: the customer summarised, with the existing actions (D-307).
  if ((await getConsoleMode()) === 'simple') {
    return (
      <SimpleCustomerDetail locale={locale} actor={actor} workspaceId={workspaceId} query={query} />
    );
  }
  const t = translator(locale);

  const workspaceService = getWorkspaceService();
  const workspace = await workspaceService.get(serviceActor(actor), workspaceId).catch(() => null);
  // A workspace that does not exist and one this actor may not see are the same
  // 404, so the URL cannot be used to probe for tenants.
  if (!workspace) notFound();

  const entitlements = getEntitlementService();
  const credits = getCreditService();

  const ledgerService = await getCreditLedgerService();

  const [
    members,
    invitations,
    effective,
    overrides,
    wallet,
    ledger,
    activity,
    plans,
    roles,
    subscription,
    grants,
    cohortMemberships,
    reconciliation,
    counters,
  ] = await Promise.all([
    getMembershipService().list(workspaceId),
    getInvitationService().list(workspaceId),
    entitlements.resolveAll(workspaceId),
    entitlements.listOverrides(workspaceId),
    credits.wallet(workspaceId),
    credits.ledger(workspaceId, 10),
    workspaceService.recentActivity(serviceActor(actor), workspaceId, 15),
    entitlements.plans(),
    getPlatformPrisma().role.findMany({
      where: { realm: 'WORKSPACE', workspaceId: null },
      orderBy: { key: 'asc' },
    }),
    // --- Phase 3 ---
    getSubscriptionService().get(workspaceId),
    ledgerService.grants(workspaceId),
    getBetaCohortService().membershipsFor(workspaceId),
    // Replay against the projection. A non-zero drift is a critical alert, so
    // it is shown here rather than only in a nightly job's log.
    credits.reconcile(workspaceId),
    new UsageService({ prisma: getPlatformPrisma() }).currentCounters(workspaceId),
  ]);

  const may = (key: string) => actor.permissionKeys.includes(key);
  const errorCode = typeof query['error'] === 'string' ? query['error'] : null;
  const okCode = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <div className="bs-section-stack">
      {/* Breadcrumbs, not a bare back-link: the directory is a real level in
          the hierarchy, and a reader arriving from a deep link needs to know
          where they are as well as how to leave. */}
      <Breadcrumbs
        label={locale === 'ar' ? 'مسار التنقل' : 'Breadcrumb'}
        items={[
          { label: t('ws.title'), href: `/${locale}/console/workspaces` },
          { label: workspace.name },
        ]}
      />

      <PageHeader
        title={workspace.name}
        description={workspace.slug}
        meta={
          <span data-testid="workspace-name" style={{ display: 'inline-flex' }}>
            <StatusPill status={workspace.status} />
          </span>
        }
        actions={
          <Link
            href={`/${locale}/console/workspaces`}
            style={{ ...buttonStyle('neutral', 'sm'), textDecoration: 'none' }}
          >
            {t('ws.backToList')}
          </Link>
        }
      />

      {errorCode && <Banner tone="error">{errorMessage(errorCode, locale, ref)}</Banner>}
      {okCode && successMessage(okCode, locale) && (
        <Banner tone="success">{successMessage(okCode, locale)}</Banner>
      )}

      {/* --- Summary -------------------------------------------------- */}
      <Card title={locale === 'ar' ? 'الملخّص' : 'Summary'} testId="workspace-summary">
        <SummaryList
          rows={[
            { label: t('ws.slug'), value: workspace.slug },
            { label: t('ws.type'), value: workspace.type },
            { label: t('ws.country'), value: workspace.country },
            { label: t('ws.locale'), value: workspace.defaultLocale },
            { label: t('ws.timezone'), value: workspace.timezone },
            { label: t('ws.currency'), value: workspace.currency },
            { label: t('ws.ownerEmail'), value: workspace.ownerEmail ?? t('ws.noData') },
            { label: t('ws.plan'), value: workspace.planKey ?? t('ws.noPlan') },
            { label: t('common.created'), value: workspace.createdAt.toISOString().slice(0, 10) },
            {
              label: t('ws.lastActivity'),
              value: workspace.lastActivityAt
                ? workspace.lastActivityAt.toISOString().slice(0, 16).replace('T', ' ')
                : t('ws.never'),
            },
            ...(workspace.statusReason
              ? [
                  {
                    label: t('ws.statusReason'),
                    value: `${workspace.statusReason}${
                      workspace.statusChangedBy ? ` — ${workspace.statusChangedBy}` : ''
                    }${
                      workspace.statusChangedAt
                        ? ` (${workspace.statusChangedAt.toISOString().slice(0, 10)})`
                        : ''
                    }`,
                  },
                ]
              : []),
          ]}
        />
      </Card>

      {/* --- Edit ----------------------------------------------------- */}
      {may('platform.workspace.update') && (
        <Card title={locale === 'ar' ? 'تعديل البيانات' : 'Edit details'} testId="workspace-edit">
          <form action={updateWorkspaceAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="lockVersion" value={workspace.lockVersion} />
            <Field label={t('ws.name')} htmlFor="edit-name">
              <input
                className="bs-control"
                id="edit-name"
                name="name"
                defaultValue={workspace.name}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.slug')} htmlFor="edit-slug">
              <input
                className="bs-control"
                id="edit-slug"
                name="slug"
                defaultValue={workspace.slug}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.locale')} htmlFor="edit-locale">
              <select
                className="bs-control"
                id="edit-locale"
                name="defaultLocale"
                defaultValue={workspace.defaultLocale}
                style={inputStyle()}
              >
                <option value="AR">AR</option>
                <option value="EN">EN</option>
              </select>
            </Field>
            <Field label={t('ws.timezone')} htmlFor="edit-timezone">
              <input
                className="bs-control"
                id="edit-timezone"
                name="timezone"
                defaultValue={workspace.timezone}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.country')} htmlFor="edit-country">
              <input
                className="bs-control"
                id="edit-country"
                name="country"
                defaultValue={workspace.country}
                maxLength={2}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.currency')} htmlFor="edit-currency">
              <input
                className="bs-control"
                id="edit-currency"
                name="currency"
                defaultValue={workspace.currency}
                maxLength={3}
                style={inputStyle()}
              />
            </Field>
            <button type="submit" data-testid="workspace-save" style={primaryButtonStyle()}>
              {t('common.save')}
            </button>
          </form>
        </Card>
      )}

      {/* --- Lifecycle ------------------------------------------------ */}
      {may('platform.workspace.suspend') && (
        <Card
          title={t('ws.changeStatus')}
          description={
            locale === 'ar'
              ? 'التعليق يمنع الجلسات والوصول ويحتفظ بالبيانات. لا يوجد حذف نهائي من الواجهة.'
              : 'Suspension blocks sessions and access, and retains all data. There is no hard delete from any interface.'
          }
          testId="workspace-lifecycle"
        >
          <form action={changeStatusAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="lockVersion" value={workspace.lockVersion} />
            <Field label={t('ws.status')} htmlFor="nextStatus">
              <select className="bs-control" id="nextStatus" name="nextStatus" style={inputStyle()}>
                {['ACTIVE', 'SUSPENDED', 'TRIALING', 'PAST_DUE', 'CANCELLED', 'ARCHIVED'].map(
                  (s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ),
                )}
              </select>
            </Field>
            <Field
              label={t('ws.statusReason')}
              htmlFor="status-reason"
              hint={locale === 'ar' ? '8 أحرف على الأقل.' : 'At least 8 characters.'}
            >
              <input
                className="bs-control"
                id="status-reason"
                name="reason"
                required
                minLength={8}
                style={inputStyle()}
              />
            </Field>
            <button type="submit" data-testid="workspace-status-submit" style={dangerButtonStyle()}>
              {t('ws.changeStatus')}
            </button>
          </form>
        </Card>
      )}

      {/* --- Plan ----------------------------------------------------- */}
      {may('platform.plan.assign') && (
        <Card
          title={t('ws.assignPlan')}
          description={
            plans.length === 0
              ? locale === 'ar'
                ? 'لا توجد خطط مُعتمدة بعد. الخطط والأسعار إعدادات يديرها المالك، وليست كودًا.'
                : 'No plans are configured yet. Plans and prices are owner-managed configuration, not code.'
              : undefined
          }
          testId="workspace-plan"
        >
          <form action={assignPlanAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <Field label={t('ws.plan')} htmlFor="planKey">
              <select
                className="bs-control"
                id="planKey"
                name="planKey"
                defaultValue={workspace.planKey ?? ''}
                style={inputStyle()}
              >
                <option value="">{t('ws.noPlan')}</option>
                {plans.map((p) => (
                  <option key={p.key} value={p.key}>
                    {locale === 'ar' ? p.nameAr : p.nameEn}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('ws.reason')} htmlFor="plan-reason">
              <input className="bs-control" id="plan-reason" name="reason" style={inputStyle()} />
            </Field>
            <button type="submit" data-testid="assign-plan-submit" style={primaryButtonStyle()}>
              {t('ws.assignPlan')}
            </button>
          </form>
        </Card>
      )}

      {/* --- Effective entitlements + trace --------------------------- */}
      <Card
        title={t('ws.effective')}
        description={
          locale === 'ar'
            ? 'كل قيمة مصحوبة بمصدر القرار — نفس الشيفرة التي تقرر هي التي تشرح.'
            : 'Every value carries the rule that decided it — the same code that decides is the code that explains.'
        }
        testId="workspace-entitlements"
      >
        {effective.decisions.length === 0 ? (
          <EmptyState
            message={
              locale === 'ar'
                ? 'لا توجد ميزات مُعرّفة في الإعدادات النشطة بعد.'
                : 'No features are defined in the active configuration yet.'
            }
          />
        ) : (
          <TableScroll>
            <table style={tableStyle()} data-testid="entitlement-table">
              <thead>
                <tr>
                  <th style={thStyle()}>{t('ws.feature')}</th>
                  <th style={thStyle()}>{t('ws.status')}</th>
                  <th style={thStyle()}>{t('ws.limit')}</th>
                  <th style={thStyle()}>{t('ws.trace')}</th>
                </tr>
              </thead>
              <tbody>
                {effective.decisions.map((d) => (
                  <tr key={d.featureKey} data-testid={`entitlement-${d.featureKey}`}>
                    <td style={tdStyle()}>{d.featureKey}</td>
                    <td style={tdStyle()}>{d.enabled ? t('ws.enabled') : t('ws.disabled')}</td>
                    <td style={tdStyle()}>{d.limitValue ?? t('ws.unlimited')}</td>
                    <td style={{ ...tdStyle(), color: colorTokens.textSecondary }}>
                      <code data-testid={`entitlement-source-${d.featureKey}`}>{d.source}</code>
                      <br />
                      {d.trace
                        .filter((s) => s.decided)
                        .map((s) => s.detail)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>

      {/* --- Overrides ------------------------------------------------ */}
      {may('platform.entitlement.override') && (
        <Card title={t('ws.override')} testId="workspace-overrides">
          {overrides.length === 0 ? (
            <EmptyState
              message={locale === 'ar' ? 'لا توجد استثناءات نشطة.' : 'No active overrides.'}
            />
          ) : (
            <TableScroll>
              <table style={tableStyle()}>
                <thead>
                  <tr>
                    <th style={thStyle()}>{t('ws.feature')}</th>
                    <th style={thStyle()}>{t('ws.status')}</th>
                    <th style={thStyle()}>{t('ws.limit')}</th>
                    <th style={thStyle()}>{t('ws.reason')}</th>
                    <th style={thStyle()} />
                  </tr>
                </thead>
                <tbody>
                  {overrides.map((o) => (
                    <tr key={o.featureKey}>
                      <td style={tdStyle()}>{o.featureKey}</td>
                      <td style={tdStyle()}>{o.enabled ? t('ws.enabled') : t('ws.disabled')}</td>
                      <td style={tdStyle()}>{o.limitValue ?? t('ws.unlimited')}</td>
                      <td style={tdStyle()}>{o.reason}</td>
                      <td style={tdStyle()}>
                        <form action={revokeOverrideAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="featureKey" value={o.featureKey} />
                          <button type="submit" style={secondaryButtonStyle()}>
                            {t('ws.overrideRevoke')}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}

          <form action={setOverrideAction} style={{ marginBlockStart: spacingTokens.lg }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <Field label={t('ws.feature')} htmlFor="featureKey">
              <input
                className="bs-control"
                id="featureKey"
                name="featureKey"
                required
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.status')} htmlFor="override-enabled">
              <select
                className="bs-control"
                id="override-enabled"
                name="enabled"
                defaultValue="true"
                style={inputStyle()}
              >
                <option value="true">{t('ws.enabled')}</option>
                <option value="false">{t('ws.disabled')}</option>
              </select>
            </Field>
            <Field label={t('ws.limit')} htmlFor="limitValue">
              <input
                className="bs-control"
                id="limitValue"
                name="limitValue"
                type="number"
                style={inputStyle()}
              />
            </Field>
            <Field
              label={t('ws.reason')}
              htmlFor="override-reason"
              hint={locale === 'ar' ? '8 أحرف على الأقل.' : 'At least 8 characters.'}
            >
              <input
                className="bs-control"
                id="override-reason"
                name="reason"
                required
                minLength={8}
                style={inputStyle()}
              />
            </Field>
            <button type="submit" data-testid="override-submit" style={primaryButtonStyle()}>
              {t('ws.overrideAdd')}
            </button>
          </form>
        </Card>
      )}

      {/* --- Credits -------------------------------------------------- */}
      <Card title={t('ws.credits')} testId="workspace-credits">
        <p style={{ marginBlockStart: 0, ...typographyTokens.numeric }}>
          <span data-testid="credit-balance">{wallet.balanceCredits}</span>{' '}
          <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
            {locale === 'ar' ? 'وحدة' : 'credits'}
          </span>
        </p>

        {may('platform.credit.adjust') && (
          <form action={adjustCreditsAction}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="workspaceId" value={workspaceId} />
            {/* A per-render key: a double submit replays the SAME logical
                adjustment rather than applying a second one. */}
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <Field label={t('ws.creditsAmount')} htmlFor="credits">
              <input
                className="bs-control"
                id="credits"
                name="credits"
                type="number"
                required
                style={inputStyle()}
              />
            </Field>
            <Field
              label={t('ws.reason')}
              htmlFor="credits-reason"
              hint={locale === 'ar' ? '8 أحرف على الأقل.' : 'At least 8 characters.'}
            >
              <input
                className="bs-control"
                id="credits-reason"
                name="reason"
                required
                minLength={8}
                style={inputStyle()}
              />
            </Field>
            <button type="submit" data-testid="credits-submit" style={primaryButtonStyle()}>
              {t('ws.creditsAdjust')}
            </button>
          </form>
        )}

        {ledger.length > 0 && (
          <TableScroll>
            <table style={{ ...tableStyle(), marginBlockStart: spacingTokens.md }}>
              <thead>
                <tr>
                  <th style={thStyle()}>{t('common.created')}</th>
                  <th style={thStyle()}>{t('ws.creditsAmount')}</th>
                  <th style={thStyle()}>{t('ws.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td style={tdStyle()}>
                      {entry.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td style={tdStyle()}>{Number(entry.amountMilliCredits / 1000n)}</td>
                    <td style={tdStyle()}>{entry.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>

      {/* --- Subscription (Phase 3) ----------------------------------- */}
      <Card
        title={locale === 'ar' ? 'الاشتراك' : 'Subscription'}
        description={
          locale === 'ar'
            ? 'السعر مثبَّت وقت تعيين الخطة. تعديل سعر الخطة في الكتالوج لا يعيد تسعير هذا الاشتراك.'
            : 'The price is pinned when the plan is assigned. Repricing the plan in the catalogue never reprices this subscription.'
        }
        testId="workspace-subscription"
      >
        {!subscription ? (
          <EmptyState
            message={
              locale === 'ar'
                ? 'لا يوجد اشتراك بعد. يُنشأ عند تعيين خطة أو بدء تجربة.'
                : 'No subscription yet. One is created when a plan is assigned or a trial starts.'
            }
          />
        ) : (
          <TableScroll>
            <table style={tableStyle()} data-testid="subscription-table">
              <tbody>
                <tr>
                  <th style={thStyle()}>{locale === 'ar' ? 'الخطة' : 'Plan'}</th>
                  <td style={tdStyle()} data-testid="subscription-plan">
                    {subscription.planKey}
                  </td>
                </tr>
                <tr>
                  <th style={thStyle()}>{locale === 'ar' ? 'الحالة' : 'Status'}</th>
                  <td style={tdStyle()}>
                    <StatusPill status={subscription.status} />
                  </td>
                </tr>
                <tr>
                  <th style={thStyle()}>
                    {locale === 'ar' ? 'السعر المثبَّت (شهري)' : 'Pinned price (monthly)'}
                  </th>
                  <td style={tdStyle()} data-testid="subscription-pinned-price">
                    {/* Minor units in the currency that was agreed. Nothing
                        converts it (D-08). */}
                    {(subscription.pinnedMonthlyMinor / 100).toFixed(2)} {subscription.currency}
                  </td>
                </tr>
                <tr>
                  <th style={thStyle()}>{locale === 'ar' ? 'الدورة الحالية' : 'Current period'}</th>
                  <td style={tdStyle()}>
                    {subscription.currentPeriodStart.toISOString().slice(0, 10)} →{' '}
                    {subscription.currentPeriodEnd.toISOString().slice(0, 10)}
                  </td>
                </tr>
                <tr>
                  <th style={thStyle()}>{locale === 'ar' ? 'التجربة' : 'Trial'}</th>
                  <td style={tdStyle()} data-testid="subscription-trial">
                    {subscription.trialStartedAt
                      ? `${subscription.trialStartedAt.toISOString().slice(0, 10)} → ${
                          subscription.trialEndsAt?.toISOString().slice(0, 10) ?? '—'
                        }`
                      : locale === 'ar'
                        ? 'لم تُستخدم بعد'
                        : 'not used yet'}
                  </td>
                </tr>
                {subscription.pendingPlanKey ? (
                  <tr>
                    <th style={thStyle()}>
                      {locale === 'ar' ? 'تغيير مجدول' : 'Scheduled change'}
                    </th>
                    <td style={tdStyle()} data-testid="subscription-pending">
                      {/* A downgrade takes effect at period end (D-12). Nothing
                          is removed at request time and nothing is deleted. */}
                      {subscription.pendingPlanKey} —{' '}
                      {subscription.pendingPlanEffectiveAt?.toISOString().slice(0, 10) ?? '—'}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>

      {/* --- Credit buckets (Phase 3) --------------------------------- */}
      {may('credits.read') || may('platform.credit.adjust') ? (
        <Card
          title={locale === 'ar' ? 'دفعات الرصيد' : 'Credit allocations'}
          description={
            locale === 'ar'
              ? 'تُستهلك الأقرب انتهاءً أولًا (D-12). المحجوز يخص طلبًا قيد التنفيذ.'
              : 'Consumed soonest-expiry first (D-12). Reserved credits belong to a request in flight.'
          }
          testId="workspace-credit-grants"
        >
          {grants.length === 0 ? (
            <EmptyState
              message={locale === 'ar' ? 'لا توجد دفعات رصيد نشطة.' : 'No live credit allocations.'}
            />
          ) : (
            <TableScroll>
              <table style={tableStyle()}>
                <thead>
                  <tr>
                    <th style={thStyle()}>{locale === 'ar' ? 'المصدر' : 'Source'}</th>
                    <th style={thStyle()}>{locale === 'ar' ? 'مُنح' : 'Granted'}</th>
                    <th style={thStyle()}>{locale === 'ar' ? 'المتبقي' : 'Remaining'}</th>
                    <th style={thStyle()}>{locale === 'ar' ? 'محجوز' : 'Reserved'}</th>
                    <th style={thStyle()}>{locale === 'ar' ? 'ينتهي' : 'Expires'}</th>
                  </tr>
                </thead>
                <tbody>
                  {grants.map((grant) => (
                    <tr key={grant.id} data-testid={`grant-${grant.id}`}>
                      <td style={tdStyle()}>{grant.source}</td>
                      <td style={tdStyle()}>{Number(grant.amountMilliCredits / 1000n)}</td>
                      <td style={tdStyle()}>{Number(grant.remainingMilliCredits / 1000n)}</td>
                      <td style={tdStyle()}>{Number(grant.reservedMilliCredits / 1000n)}</td>
                      <td style={tdStyle()}>
                        {grant.expiresAt
                          ? grant.expiresAt.toISOString().slice(0, 10)
                          : locale === 'ar'
                            ? 'لا ينتهي'
                            : 'never'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}

          {/* Reconciliation. Replaying the ledger must reproduce the balance
              exactly; a non-zero drift is a critical alert, not a rounding
              detail, so it is stated rather than buried. */}
          <p
            data-testid="reconciliation"
            style={{
              marginBlockStart: spacingTokens.md,
              fontSize: typographyTokens.bodySm.fontSize,
              color: reconciliation.drift === 0n ? colorTokens.textSecondary : colorTokens.danger,
            }}
          >
            {reconciliation.drift === 0n
              ? locale === 'ar'
                ? 'إعادة تشغيل الدفتر تطابق الرصيد المخزَّن تمامًا.'
                : 'Ledger replay reproduces the stored balance exactly.'
              : locale === 'ar'
                ? `انحراف ${String(reconciliation.drift)} — تنبيه حرج.`
                : `Drift of ${String(reconciliation.drift)} — a critical alert.`}
          </p>
        </Card>
      ) : null}

      {/* --- Quota usage (Phase 3) ------------------------------------ */}
      <Card
        title={locale === 'ar' ? 'استهلاك الحدود' : 'Quota usage'}
        description={
          locale === 'ar'
            ? 'العدادات في نوافذها الحالية. لا تُعرض قيمة لبُعد لا توجد له بيانات.'
            : 'Counters in their current windows. A dimension with no data is not shown with an invented value.'
        }
        testId="workspace-quota-usage"
      >
        {counters.length === 0 ? (
          <EmptyState
            message={
              locale === 'ar' ? 'لم يُسجَّل استهلاك بعد.' : 'No usage has been recorded yet.'
            }
          />
        ) : (
          <TableScroll>
            <table style={tableStyle()}>
              <thead>
                <tr>
                  <th style={thStyle()}>{t('ws.feature')}</th>
                  <th style={thStyle()}>{locale === 'ar' ? 'المستهلك' : 'Used'}</th>
                  <th style={thStyle()}>{t('ws.limit')}</th>
                  <th style={thStyle()}>{locale === 'ar' ? 'تنتهي النافذة' : 'Window ends'}</th>
                </tr>
              </thead>
              <tbody>
                {counters.map((counter) => {
                  const decision = effective.decisions.find(
                    (d) => d.featureKey === counter.featureKey,
                  );
                  return (
                    <tr key={counter.featureKey} data-testid={`usage-${counter.featureKey}`}>
                      <td style={tdStyle()}>{counter.featureKey}</td>
                      <td style={tdStyle()}>{counter.used}</td>
                      <td style={tdStyle()}>{decision?.limitValue ?? t('ws.unlimited')}</td>
                      <td style={tdStyle()}>{counter.periodEnd.toISOString().slice(0, 10)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>

      {/* --- Beta cohorts (Phase 3) ----------------------------------- */}
      {may('platform.entitlement.override') && (
        <Card
          title={locale === 'ar' ? 'مجموعات التجربة' : 'Beta cohorts'}
          description={
            locale === 'ar'
              ? 'العضوية سجل في قاعدة البيانات — له مؤلف وسبب وتاريخ — وليست إعدادًا.'
              : 'Membership is a database row with an author, a reason and a date — not a configuration entry.'
          }
          testId="workspace-cohorts"
        >
          {cohortMemberships.length === 0 ? (
            <EmptyState
              message={
                locale === 'ar'
                  ? 'مساحة العمل ليست في أي مجموعة تجربة.'
                  : 'This workspace is in no beta cohort.'
              }
            />
          ) : (
            <TableScroll>
              <table style={tableStyle()}>
                <thead>
                  <tr>
                    <th style={thStyle()}>{locale === 'ar' ? 'المجموعة' : 'Cohort'}</th>
                    <th style={thStyle()}>{t('ws.reason')}</th>
                    <th style={thStyle()}>{t('common.created')}</th>
                    <th style={thStyle()} />
                  </tr>
                </thead>
                <tbody>
                  {cohortMemberships.map((membership) => (
                    <tr key={membership.cohortKey} data-testid={`cohort-${membership.cohortKey}`}>
                      <td style={tdStyle()}>{membership.cohortKey}</td>
                      <td style={tdStyle()}>{membership.reason}</td>
                      <td style={tdStyle()}>{membership.addedAt.toISOString().slice(0, 10)}</td>
                      <td style={tdStyle()}>
                        <form action={removeCohortAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="cohortKey" value={membership.cohortKey} />
                          <button type="submit" style={secondaryButtonStyle()}>
                            {locale === 'ar' ? 'إزالة' : 'Remove'}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}

          <form action={addCohortAction} style={{ marginBlockStart: spacingTokens.lg }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <Field label={locale === 'ar' ? 'مفتاح المجموعة' : 'Cohort key'} htmlFor="cohortKey">
              <input
                className="bs-control"
                id="cohortKey"
                name="cohortKey"
                required
                style={inputStyle()}
                data-testid="cohort-key"
              />
            </Field>
            <Field
              label={t('ws.reason')}
              htmlFor="cohort-reason"
              hint={locale === 'ar' ? '8 أحرف على الأقل.' : 'At least 8 characters.'}
            >
              <input
                className="bs-control"
                id="cohort-reason"
                name="reason"
                required
                minLength={8}
                style={inputStyle()}
                data-testid="cohort-reason"
              />
            </Field>
            <button type="submit" style={primaryButtonStyle()} data-testid="cohort-submit">
              {locale === 'ar' ? 'إضافة إلى المجموعة' : 'Add to cohort'}
            </button>
          </form>
        </Card>
      )}

      {/* --- Members -------------------------------------------------- */}
      <Card title={t('ws.members')} testId="workspace-members">
        {members.length === 0 ? (
          <EmptyState message={t('ws.noData')} />
        ) : (
          <TableScroll>
            <table style={tableStyle()}>
              <thead>
                <tr>
                  <th style={thStyle()}>{t('ws.inviteEmail')}</th>
                  <th style={thStyle()}>{t('ws.inviteRole')}</th>
                  <th style={thStyle()}>{t('ws.status')}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.membershipId} data-testid={`member-${m.email}`}>
                    <td style={tdStyle()}>{m.email}</td>
                    <td style={tdStyle()}>{locale === 'ar' ? m.roleNameAr : m.roleNameEn}</td>
                    <td style={tdStyle()}>
                      <StatusPill status={m.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>

      {/* --- Invitations ---------------------------------------------- */}
      {may('platform.workspace.invite') && (
        <Card title={t('ws.invitations')} testId="workspace-invitations">
          {invitations.length === 0 ? (
            <EmptyState message={locale === 'ar' ? 'لا توجد دعوات بعد.' : 'No invitations yet.'} />
          ) : (
            <TableScroll>
              <table style={tableStyle()}>
                <thead>
                  <tr>
                    <th style={thStyle()}>{t('ws.inviteEmail')}</th>
                    <th style={thStyle()}>{t('ws.inviteRole')}</th>
                    <th style={thStyle()}>{t('ws.status')}</th>
                    <th style={thStyle()} />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((i) => (
                    <tr key={i.id} data-testid={`invitation-${i.email}`}>
                      <td style={tdStyle()}>{i.email}</td>
                      <td style={tdStyle()}>{i.roleKey}</td>
                      <td style={tdStyle()}>
                        <StatusPill status={i.status} />
                      </td>
                      <td style={tdStyle()}>
                        {i.status === 'PENDING' && (
                          <form action={revokeInvitationAction}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="workspaceId" value={workspaceId} />
                            <input type="hidden" name="invitationId" value={i.id} />
                            <button type="submit" style={secondaryButtonStyle()}>
                              {t('ws.inviteRevoke')}
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}

          <form action={inviteMemberAction} style={{ marginBlockStart: spacingTokens.lg }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <Field label={t('ws.inviteEmail')} htmlFor="invite-email">
              <input
                className="bs-control"
                id="invite-email"
                name="email"
                type="email"
                required
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.inviteRole')} htmlFor="invite-role">
              <select className="bs-control" id="invite-role" name="roleId" style={inputStyle()}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {locale === 'ar' ? r.nameAr : r.nameEn}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" data-testid="invite-submit" style={primaryButtonStyle()}>
              {t('ws.inviteSend')}
            </button>
          </form>
        </Card>
      )}

      {/* --- Activity ------------------------------------------------- */}
      <Card title={t('ws.activity')} testId="workspace-activity">
        {activity.length === 0 ? (
          <EmptyState message={t('ws.noData')} />
        ) : (
          <TableScroll>
            <table style={tableStyle()}>
              <thead>
                <tr>
                  <th style={thStyle()}>{locale === 'ar' ? 'الإجراء' : 'Action'}</th>
                  <th style={thStyle()}>{locale === 'ar' ? 'الفاعل' : 'Actor'}</th>
                  <th style={thStyle()}>{locale === 'ar' ? 'النتيجة' : 'Outcome'}</th>
                  <th style={thStyle()}>{locale === 'ar' ? 'التاريخ' : 'When'}</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((a) => (
                  <tr key={a.id}>
                    <td style={tdStyle()}>{a.action}</td>
                    <td style={tdStyle()}>{a.actorType}</td>
                    <td style={tdStyle()}>{a.outcome}</td>
                    <td style={tdStyle()}>
                      {a.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Card>
    </div>
  );
}

/**
 * Key/value summary as a description list rather than a borderless table.
 *
 * A two-column table with no header row is a table only in markup: screen
 * readers announce it as tabular data with one meaningless column, and it
 * cannot reflow. A `<dl>` says what this actually is and wraps to one column on
 * a phone without a second implementation.
 */
function SummaryList({
  rows,
}: {
  rows: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}) {
  return (
    <dl
      data-testid="workspace-summary-list"
      style={{ margin: 0, display: 'grid', gap: spacingTokens.sm }}
    >
      {rows.map((row) => (
        <div
          key={row.label}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.sm,
            alignItems: 'baseline',
          }}
        >
          <dt
            style={{
              ...typographyTokens.label,
              color: colorTokens.textSecondary,
              flex: '0 0 12rem',
              minInlineSize: 0,
            }}
          >
            {row.label}
          </dt>
          <dd
            style={{
              margin: 0,
              ...typographyTokens.bodySm,
              flex: '1 1 12rem',
              minInlineSize: 0,
              overflowWrap: 'anywhere',
            }}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
