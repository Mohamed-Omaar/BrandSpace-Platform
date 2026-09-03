import Link from 'next/link';
import { notFound } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { colorTokens, spacingTokens } from '@brandspace/ui';
import {
  getCreditService,
  getEntitlementService,
  getInvitationService,
  getMembershipService,
  getPlatformPrisma,
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
  adjustCreditsAction,
  assignPlanAction,
  changeStatusAction,
  inviteMemberAction,
  revokeInvitationAction,
  revokeOverrideAction,
  setOverrideAction,
  updateWorkspaceAction,
} from '../actions';

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
  const t = translator(locale);

  const workspaceService = getWorkspaceService();
  const workspace = await workspaceService.get(serviceActor(actor), workspaceId).catch(() => null);
  // A workspace that does not exist and one this actor may not see are the same
  // 404, so the URL cannot be used to probe for tenants.
  if (!workspace) notFound();

  const entitlements = getEntitlementService();
  const credits = getCreditService();

  const [members, invitations, effective, overrides, wallet, ledger, activity, plans, roles] =
    await Promise.all([
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
    ]);

  const may = (key: string) => actor.permissionKeys.includes(key);
  const errorCode = typeof query['error'] === 'string' ? query['error'] : null;
  const okCode = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <div>
      <p style={{ marginBlockStart: 0 }}>
        <Link href={`/${locale}/console/workspaces`} style={{ color: colorTokens.brandPurple }}>
          ← {t('ws.backToList')}
        </Link>
      </p>

      <h1 style={{ marginBlockStart: 0, fontSize: '1.35rem' }} data-testid="workspace-name">
        {workspace.name} <StatusPill status={workspace.status} />
      </h1>

      {errorCode && <Banner tone="error">{errorMessage(errorCode, locale, ref)}</Banner>}
      {okCode && successMessage(okCode, locale) && (
        <Banner tone="success">{successMessage(okCode, locale)}</Banner>
      )}

      {/* --- Summary -------------------------------------------------- */}
      <Card title={locale === 'ar' ? 'الملخّص' : 'Summary'} testId="workspace-summary">
        <TableScroll>
          <table style={tableStyle()}>
            <tbody>
              <Row label={t('ws.slug')} value={workspace.slug} />
              <Row label={t('ws.type')} value={workspace.type} />
              <Row label={t('ws.country')} value={workspace.country} />
              <Row label={t('ws.locale')} value={workspace.defaultLocale} />
              <Row label={t('ws.timezone')} value={workspace.timezone} />
              <Row label={t('ws.currency')} value={workspace.currency} />
              <Row label={t('ws.ownerEmail')} value={workspace.ownerEmail ?? t('ws.noData')} />
              <Row label={t('ws.plan')} value={workspace.planKey ?? t('ws.noPlan')} />
              <Row
                label={t('common.created')}
                value={workspace.createdAt.toISOString().slice(0, 10)}
              />
              <Row
                label={t('ws.lastActivity')}
                value={
                  workspace.lastActivityAt
                    ? workspace.lastActivityAt.toISOString().slice(0, 16).replace('T', ' ')
                    : t('ws.never')
                }
              />
              {workspace.statusReason && (
                <Row
                  label={t('ws.statusReason')}
                  value={`${workspace.statusReason}${
                    workspace.statusChangedBy ? ` — ${workspace.statusChangedBy}` : ''
                  }${
                    workspace.statusChangedAt
                      ? ` (${workspace.statusChangedAt.toISOString().slice(0, 10)})`
                      : ''
                  }`}
                />
              )}
            </tbody>
          </table>
        </TableScroll>
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
                id="edit-name"
                name="name"
                defaultValue={workspace.name}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.slug')} htmlFor="edit-slug">
              <input
                id="edit-slug"
                name="slug"
                defaultValue={workspace.slug}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.locale')} htmlFor="edit-locale">
              <select
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
                id="edit-timezone"
                name="timezone"
                defaultValue={workspace.timezone}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.country')} htmlFor="edit-country">
              <input
                id="edit-country"
                name="country"
                defaultValue={workspace.country}
                maxLength={2}
                style={inputStyle()}
              />
            </Field>
            <Field label={t('ws.currency')} htmlFor="edit-currency">
              <input
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
              <select id="nextStatus" name="nextStatus" style={inputStyle()}>
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
              hint={locale === 'ar' ? '٨ أحرف على الأقل.' : 'At least 8 characters.'}
            >
              <input id="status-reason" name="reason" required minLength={8} style={inputStyle()} />
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
              <input id="plan-reason" name="reason" style={inputStyle()} />
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
              <input id="featureKey" name="featureKey" required style={inputStyle()} />
            </Field>
            <Field label={t('ws.status')} htmlFor="override-enabled">
              <select id="override-enabled" name="enabled" defaultValue="true" style={inputStyle()}>
                <option value="true">{t('ws.enabled')}</option>
                <option value="false">{t('ws.disabled')}</option>
              </select>
            </Field>
            <Field label={t('ws.limit')} htmlFor="limitValue">
              <input id="limitValue" name="limitValue" type="number" style={inputStyle()} />
            </Field>
            <Field
              label={t('ws.reason')}
              htmlFor="override-reason"
              hint={locale === 'ar' ? '٨ أحرف على الأقل.' : 'At least 8 characters.'}
            >
              <input
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
        <p style={{ marginBlockStart: 0, fontSize: '1.5rem', fontWeight: 700 }}>
          <span data-testid="credit-balance">{wallet.balanceCredits}</span>{' '}
          <span style={{ fontSize: '0.875rem', color: colorTokens.textSecondary }}>
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
              <input id="credits" name="credits" type="number" required style={inputStyle()} />
            </Field>
            <Field
              label={t('ws.reason')}
              htmlFor="credits-reason"
              hint={locale === 'ar' ? '٨ أحرف على الأقل.' : 'At least 8 characters.'}
            >
              <input
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
              <input id="invite-email" name="email" type="email" required style={inputStyle()} />
            </Field>
            <Field label={t('ws.inviteRole')} htmlFor="invite-role">
              <select id="invite-role" name="roleId" style={inputStyle()}>
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <th scope="row" style={{ ...thStyle(), inlineSize: '14rem' }}>
        {label}
      </th>
      <td style={tdStyle()}>{value}</td>
    </tr>
  );
}
