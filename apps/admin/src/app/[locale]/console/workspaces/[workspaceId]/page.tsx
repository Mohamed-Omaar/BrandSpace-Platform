import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import {
  Breadcrumbs,
  PageHeader,
  colorTokens,
  spacingTokens,
  typographyTokens,
  buttonClass,
  StateMessage,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
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
  Field,
  StatusPill,
  TableScroll,
  inputStyle,
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
          <Link href={`/${locale}/console/workspaces`} className={buttonClass('neutral', 'sm')}>
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
                className="bs-control bs-field"
                id="edit-name"
                name="name"
                defaultValue={workspace.name}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.slug')} htmlFor="edit-slug">
              <input
                className="bs-control bs-field"
                id="edit-slug"
                name="slug"
                defaultValue={workspace.slug}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.locale')} htmlFor="edit-locale">
              <select
                className="bs-control bs-field"
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
                className="bs-control bs-field"
                id="edit-timezone"
                name="timezone"
                defaultValue={workspace.timezone}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.country')} htmlFor="edit-country">
              <input
                className="bs-control bs-field"
                id="edit-country"
                name="country"
                defaultValue={workspace.country}
                maxLength={2}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.currency')} htmlFor="edit-currency">
              <input
                className="bs-control bs-field"
                id="edit-currency"
                name="currency"
                defaultValue={workspace.currency}
                maxLength={3}
                style={inputStyle()}
              />
            </Field>
            <button type="submit" data-testid="workspace-save" className={buttonClass('primary')}>
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
              <select
                className="bs-control bs-field"
                id="nextStatus"
                name="nextStatus"
                style={inputStyle()}
              >
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
                className="bs-control bs-field"
                id="status-reason"
                name="reason"
                required
                minLength={8}
                style={inputStyle()}
              />
            </Field>
            <button
              type="submit"
              data-testid="workspace-status-submit"
              className={buttonClass('danger')}
            >
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
                className="bs-control bs-field"
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
              <input
                className="bs-control bs-field"
                id="plan-reason"
                name="reason"
                style={inputStyle()}
              />
            </Field>
            <button
              type="submit"
              data-testid="assign-plan-submit"
              className={buttonClass('primary')}
            >
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
          <StateMessage
            title={
              locale === 'ar'
                ? 'لا توجد ميزات مُعرّفة في الإعدادات النشطة بعد.'
                : 'No features are defined in the active configuration yet.'
            }
          />
        ) : (
          <TableScroll>
            <table className={TABLE_CLASS} data-testid="entitlement-table">
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('ws.feature')}</th>
                  <th className={TH_CLASS}>{t('ws.status')}</th>
                  <th className={TH_CLASS}>{t('ws.limit')}</th>
                  <th className={TH_CLASS}>{t('ws.trace')}</th>
                </tr>
              </thead>
              <tbody>
                {effective.decisions.map((d) => (
                  <tr key={d.featureKey} data-testid={`entitlement-${d.featureKey}`}>
                    <td className={TD_CLASS}>{d.featureKey}</td>
                    <td className={TD_CLASS}>{d.enabled ? t('ws.enabled') : t('ws.disabled')}</td>
                    <td className={TD_CLASS}>{d.limitValue ?? t('ws.unlimited')}</td>
                    <td className={TD_CLASS} style={{ color: colorTokens.textSecondary }}>
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
            <StateMessage
              title={locale === 'ar' ? 'لا توجد استثناءات نشطة.' : 'No active overrides.'}
            />
          ) : (
            <TableScroll>
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('ws.feature')}</th>
                    <th className={TH_CLASS}>{t('ws.status')}</th>
                    <th className={TH_CLASS}>{t('ws.limit')}</th>
                    <th className={TH_CLASS}>{t('ws.reason')}</th>
                    <th className={TH_CLASS} />
                  </tr>
                </thead>
                <tbody>
                  {overrides.map((o) => (
                    <tr key={o.featureKey}>
                      <td className={TD_CLASS}>{o.featureKey}</td>
                      <td className={TD_CLASS}>{o.enabled ? t('ws.enabled') : t('ws.disabled')}</td>
                      <td className={TD_CLASS}>{o.limitValue ?? t('ws.unlimited')}</td>
                      <td className={TD_CLASS}>{o.reason}</td>
                      <td className={TD_CLASS}>
                        <form action={revokeOverrideAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="featureKey" value={o.featureKey} />
                          <button type="submit" className={buttonClass('neutral')}>
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
                className="bs-control bs-field"
                id="featureKey"
                name="featureKey"
                required
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.status')} htmlFor="override-enabled">
              <select
                className="bs-control bs-field"
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
                className="bs-control bs-field"
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
                className="bs-control bs-field"
                id="override-reason"
                name="reason"
                required
                minLength={8}
                style={inputStyle()}
              />
            </Field>
            <button type="submit" data-testid="override-submit" className={buttonClass('primary')}>
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
                className="bs-control bs-field"
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
                className="bs-control bs-field"
                id="credits-reason"
                name="reason"
                required
                minLength={8}
                style={inputStyle()}
              />
            </Field>
            <button type="submit" data-testid="credits-submit" className={buttonClass('primary')}>
              {t('ws.creditsAdjust')}
            </button>
          </form>
        )}

        {ledger.length > 0 && (
          <TableScroll>
            <table className={TABLE_CLASS} style={{ marginBlockStart: spacingTokens.md }}>
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('common.created')}</th>
                  <th className={TH_CLASS}>{t('ws.creditsAmount')}</th>
                  <th className={TH_CLASS}>{t('ws.reason')}</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td className={TD_CLASS}>
                      {entry.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className={TD_CLASS}>{Number(entry.amountMilliCredits / 1000n)}</td>
                    <td className={TD_CLASS}>{entry.reason}</td>
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
          <StateMessage
            title={
              locale === 'ar'
                ? 'لا يوجد اشتراك بعد. يُنشأ عند تعيين خطة أو بدء تجربة.'
                : 'No subscription yet. One is created when a plan is assigned or a trial starts.'
            }
          />
        ) : (
          <TableScroll>
            <table className={TABLE_CLASS} data-testid="subscription-table">
              <tbody>
                <tr>
                  <th className={TH_CLASS}>{locale === 'ar' ? 'الخطة' : 'Plan'}</th>
                  <td className={TD_CLASS} data-testid="subscription-plan">
                    {subscription.planKey}
                  </td>
                </tr>
                <tr>
                  <th className={TH_CLASS}>{locale === 'ar' ? 'الحالة' : 'Status'}</th>
                  <td className={TD_CLASS}>
                    <StatusPill status={subscription.status} />
                  </td>
                </tr>
                <tr>
                  <th className={TH_CLASS}>
                    {locale === 'ar' ? 'السعر المثبَّت (شهري)' : 'Pinned price (monthly)'}
                  </th>
                  <td className={TD_CLASS} data-testid="subscription-pinned-price">
                    {/* Minor units in the currency that was agreed. Nothing
                        converts it (D-08). */}
                    {(subscription.pinnedMonthlyMinor / 100).toFixed(2)} {subscription.currency}
                  </td>
                </tr>
                <tr>
                  <th className={TH_CLASS}>
                    {locale === 'ar' ? 'الدورة الحالية' : 'Current period'}
                  </th>
                  <td className={TD_CLASS}>
                    {subscription.currentPeriodStart.toISOString().slice(0, 10)} →{' '}
                    {subscription.currentPeriodEnd.toISOString().slice(0, 10)}
                  </td>
                </tr>
                <tr>
                  <th className={TH_CLASS}>{locale === 'ar' ? 'التجربة' : 'Trial'}</th>
                  <td className={TD_CLASS} data-testid="subscription-trial">
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
                    <th className={TH_CLASS}>
                      {locale === 'ar' ? 'تغيير مجدول' : 'Scheduled change'}
                    </th>
                    <td className={TD_CLASS} data-testid="subscription-pending">
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
            <StateMessage
              title={locale === 'ar' ? 'لا توجد دفعات رصيد نشطة.' : 'No live credit allocations.'}
            />
          ) : (
            <TableScroll>
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{locale === 'ar' ? 'المصدر' : 'Source'}</th>
                    <th className={TH_CLASS}>{locale === 'ar' ? 'مُنح' : 'Granted'}</th>
                    <th className={TH_CLASS}>{locale === 'ar' ? 'المتبقي' : 'Remaining'}</th>
                    <th className={TH_CLASS}>{locale === 'ar' ? 'محجوز' : 'Reserved'}</th>
                    <th className={TH_CLASS}>{locale === 'ar' ? 'ينتهي' : 'Expires'}</th>
                  </tr>
                </thead>
                <tbody>
                  {grants.map((grant) => (
                    <tr key={grant.id} data-testid={`grant-${grant.id}`}>
                      <td className={TD_CLASS}>{grant.source}</td>
                      <td className={TD_CLASS}>{Number(grant.amountMilliCredits / 1000n)}</td>
                      <td className={TD_CLASS}>{Number(grant.remainingMilliCredits / 1000n)}</td>
                      <td className={TD_CLASS}>{Number(grant.reservedMilliCredits / 1000n)}</td>
                      <td className={TD_CLASS}>
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
          <StateMessage
            title={locale === 'ar' ? 'لم يُسجَّل استهلاك بعد.' : 'No usage has been recorded yet.'}
          />
        ) : (
          <TableScroll>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('ws.feature')}</th>
                  <th className={TH_CLASS}>{locale === 'ar' ? 'المستهلك' : 'Used'}</th>
                  <th className={TH_CLASS}>{t('ws.limit')}</th>
                  <th className={TH_CLASS}>{locale === 'ar' ? 'تنتهي النافذة' : 'Window ends'}</th>
                </tr>
              </thead>
              <tbody>
                {counters.map((counter) => {
                  const decision = effective.decisions.find(
                    (d) => d.featureKey === counter.featureKey,
                  );
                  return (
                    <tr key={counter.featureKey} data-testid={`usage-${counter.featureKey}`}>
                      <td className={TD_CLASS}>{counter.featureKey}</td>
                      <td className={TD_CLASS}>{counter.used}</td>
                      <td className={TD_CLASS}>{decision?.limitValue ?? t('ws.unlimited')}</td>
                      <td className={TD_CLASS}>{counter.periodEnd.toISOString().slice(0, 10)}</td>
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
            <StateMessage
              title={
                locale === 'ar'
                  ? 'مساحة العمل ليست في أي مجموعة تجربة.'
                  : 'This workspace is in no beta cohort.'
              }
            />
          ) : (
            <TableScroll>
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{locale === 'ar' ? 'المجموعة' : 'Cohort'}</th>
                    <th className={TH_CLASS}>{t('ws.reason')}</th>
                    <th className={TH_CLASS}>{t('common.created')}</th>
                    <th className={TH_CLASS} />
                  </tr>
                </thead>
                <tbody>
                  {cohortMemberships.map((membership) => (
                    <tr key={membership.cohortKey} data-testid={`cohort-${membership.cohortKey}`}>
                      <td className={TD_CLASS}>{membership.cohortKey}</td>
                      <td className={TD_CLASS}>{membership.reason}</td>
                      <td className={TD_CLASS}>{membership.addedAt.toISOString().slice(0, 10)}</td>
                      <td className={TD_CLASS}>
                        <form action={removeCohortAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="workspaceId" value={workspaceId} />
                          <input type="hidden" name="cohortKey" value={membership.cohortKey} />
                          <button type="submit" className={buttonClass('neutral')}>
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
                className="bs-control bs-field"
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
                className="bs-control bs-field"
                id="cohort-reason"
                name="reason"
                required
                minLength={8}
                style={inputStyle()}
                data-testid="cohort-reason"
              />
            </Field>
            <button type="submit" className={buttonClass('primary')} data-testid="cohort-submit">
              {locale === 'ar' ? 'إضافة إلى المجموعة' : 'Add to cohort'}
            </button>
          </form>
        </Card>
      )}

      {/* --- Members -------------------------------------------------- */}
      <Card title={t('ws.members')} testId="workspace-members">
        {members.length === 0 ? (
          <StateMessage title={t('ws.noData')} />
        ) : (
          <TableScroll>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th className={TH_CLASS}>{t('ws.inviteEmail')}</th>
                  <th className={TH_CLASS}>{t('ws.inviteRole')}</th>
                  <th className={TH_CLASS}>{t('ws.status')}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.membershipId} data-testid={`member-${m.email}`}>
                    <td className={TD_CLASS}>{m.email}</td>
                    <td className={TD_CLASS}>{locale === 'ar' ? m.roleNameAr : m.roleNameEn}</td>
                    <td className={TD_CLASS}>
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
            <StateMessage title={locale === 'ar' ? 'لا توجد دعوات بعد.' : 'No invitations yet.'} />
          ) : (
            <TableScroll>
              <table className={TABLE_CLASS}>
                <thead>
                  <tr>
                    <th className={TH_CLASS}>{t('ws.inviteEmail')}</th>
                    <th className={TH_CLASS}>{t('ws.inviteRole')}</th>
                    <th className={TH_CLASS}>{t('ws.status')}</th>
                    <th className={TH_CLASS} />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((i) => (
                    <tr key={i.id} data-testid={`invitation-${i.email}`}>
                      <td className={TD_CLASS}>{i.email}</td>
                      <td className={TD_CLASS}>{i.roleKey}</td>
                      <td className={TD_CLASS}>
                        <StatusPill status={i.status} />
                      </td>
                      <td className={TD_CLASS}>
                        {i.status === 'PENDING' && (
                          <form action={revokeInvitationAction}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="workspaceId" value={workspaceId} />
                            <input type="hidden" name="invitationId" value={i.id} />
                            <button type="submit" className={buttonClass('neutral')}>
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
                className="bs-control bs-field"
                id="invite-email"
                name="email"
                type="email"
                required
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.inviteRole')} htmlFor="invite-role">
              <select
                className="bs-control bs-field"
                id="invite-role"
                name="roleId"
                style={inputStyle()}
              >
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {locale === 'ar' ? r.nameAr : r.nameEn}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" data-testid="invite-submit" className={buttonClass('primary')}>
              {t('ws.inviteSend')}
            </button>
          </form>
        </Card>
      )}

      {/* --- Activity ------------------------------------------------- */}
      <Card title={t('ws.activity')} testId="workspace-activity">
        {activity.length === 0 ? (
          <StateMessage title={t('ws.noData')} />
        ) : (
          <TableScroll>
            <table className={TABLE_CLASS}>
              <thead>
                <tr>
                  <th className={TH_CLASS}>{locale === 'ar' ? 'الإجراء' : 'Action'}</th>
                  <th className={TH_CLASS}>{locale === 'ar' ? 'الفاعل' : 'Actor'}</th>
                  <th className={TH_CLASS}>{locale === 'ar' ? 'النتيجة' : 'Outcome'}</th>
                  <th className={TH_CLASS}>{locale === 'ar' ? 'التاريخ' : 'When'}</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((a) => (
                  <tr key={a.id}>
                    <td className={TD_CLASS}>{a.action}</td>
                    <td className={TD_CLASS}>{a.actorType}</td>
                    <td className={TD_CLASS}>{a.outcome}</td>
                    <td className={TD_CLASS}>
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
