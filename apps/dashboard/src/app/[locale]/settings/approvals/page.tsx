import { DraftForm } from '@brandspace/ui';
import type { ResolvedApprovalPolicy } from '@brandspace/content';
import Link from 'next/link';
import { initialsFrom } from '@brandspace/ui';
import { inWorkspace, requireWorkspacePage } from '../../../../server/customer-context';
import { NoAccessPage } from '../../../../components/no-access-page';
import { brandContextFor, listAccessibleBrands } from '../../../../server/brand-context';
import { SettingsFrame } from '../../../../components/settings-frame';
import { inContentStudio } from '../../../../server/content-context';
import { customerRoleName, statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { CheckboxRow } from '../../../../components/checkbox-row';
import { saveBarLabels } from '../../../../server/save-bar-labels';
import { saveApprovalPolicyAction } from '../../approvals/actions';

export const dynamic = 'force-dynamic';

/**
 * SETTINGS → APPROVALS (A8, prototype v94 Phase 2B-1).
 *
 * The brand approval rules — require approval before scheduling, allow a
 * reviewer to approve what they sent — moved here from the Approvals queue,
 * because they are workspace configuration rather than a review task. Same
 * permission (`approvals.policy.manage`, Owner and Admin only: a role that can
 * approve must not be able to grant itself self-approval), same server action,
 * same audit event (`content.approval_policy_changed`).
 *
 * One form per brand the member may see — one form while multi-brand is off
 * (D-327).
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): the Settings `SettingsSplit`,
 * `Card`, `SectionHeader` and the composed checkbox row the Approvals screen
 * already used.
 */
export default async function ApprovalSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const access = await requireWorkspacePage(locale, '/settings/approvals');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;

  const brands = await listAccessibleBrands(workspace);
  const policies = await inContentStudio(workspace.workspaceId, async ({ approvals }) => {
    const service = await approvals();
    const rows: {
      brandId: string;
      brandName: string;
      requireApprovalBeforeScheduling: boolean;
      allowSelfApproval: boolean;
      approvers: readonly string[];
    }[] = [];
    for (const brand of brands) {
      const policy: ResolvedApprovalPolicy = await service.policyForBrand(brand.id);
      rows.push({
        brandId: brand.id,
        brandName: brand.name,
        requireApprovalBeforeScheduling: policy.requireApprovalBeforeScheduling,
        allowSelfApproval: policy.allowSelfApproval,
        // Round 4, Gate 2b — the service's own answer to "who may decide a
        // review for this brand": ACTIVE, `content.approve`, the brand in scope.
        approvers: await service.eligibleReviewers({ brandId: brand.id }),
      });
    }
    return rows;
  });
  /*
   * The Team list itself, in its order, so a person has the same avatar colour
   * here as on Team (`.bsp-tm-av[data-c]` is the place in that list).
   */
  const team = await inWorkspace(workspace.workspaceId, async ({ memberships }) =>
    memberships.list(workspace.workspaceId),
  );

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const brandContext = await brandContextFor(workspace, '/settings');

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
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}
      <SettingsFrame
        brandSource={workspace}
        locale={locale}
        permissionKeys={workspace.permissionKeys}
        selected="approvals"
      >
        {/*
          ROUND 4, GATE 2b — "WHO APPROVES" (`Main.dc.html` lines 1436–1440): a
          card per brand listing the active members who can see the brand, each
          marked "Approves", "Approves others' posts" (when the brand bars
          approving your own) or "Doesn't approve". Read-only: who approves is
          set by roles in Team, and the card says so and links there.
        */}
        {policies.map((policy) => {
          const people = team.filter(
            (member) =>
              member.status === 'ACTIVE' &&
              (member.brandScope.length === 0 || member.brandScope.includes(policy.brandId)),
          );
          return (
            <section
              key={`who-${policy.brandId}`}
              className="bsp-xcard bsp-sa-who"
              data-testid={`approvers-${policy.brandId}`}
            >
              <div className="bsp-sa-who-head">
                <h2 className="bsp-sech">
                  {t('settings.whoApproves.title')}
                  {policies.length > 1 ? ` · ${policy.brandName}` : ''}
                </h2>
                <Link
                  href={`/${locale}/members`}
                  className="bsp-btn bsp-sm bsp-ghost bsp-sa-who-edit"
                  data-testid={`approvers-edit-${policy.brandId}`}
                >
                  {t('settings.whoApproves.edit')} →
                </Link>
              </div>
              <span className="bsp-xdesc">
                {t('settings.whoApproves.sub')
                  .replace('{permission}', t('perms.action.content.approve'))
                  .replace('{brand}', policy.brandName)}
              </span>
              {people.map((member) => {
                const approves = policy.approvers.includes(member.userId);
                const name = member.name?.trim() || member.email;
                return (
                  <div
                    key={member.userId}
                    className="bsp-sa-who-row"
                    data-testid={`approver-${policy.brandId}-${member.userId}`}
                    data-approves={approves ? 'true' : 'false'}
                  >
                    <span
                      aria-hidden="true"
                      className="bsp-tm-av bsp-sa-who-av"
                      data-c={team.indexOf(member) % 4}
                    >
                      {initialsFrom(name)}
                    </span>
                    <span className="bsp-sa-who-text">
                      <span className="bsp-sa-who-name">{name}</span>
                      <span className="bsp-sa-who-role">
                        {customerRoleName(locale === 'ar' ? member.roleNameAr : member.roleNameEn)}
                      </span>
                    </span>
                    <span className={approves ? 'bsp-xstatus' : 'bsp-xstatus bsp-neu'}>
                      {approves
                        ? policy.allowSelfApproval
                          ? t('settings.whoApproves.approves')
                          : t('settings.whoApproves.others')
                        : t('settings.whoApproves.not')}
                    </span>
                  </div>
                );
              })}
            </section>
          );
        })}
        {/*
          THE TWO RULES, as the prototype's card of rows (`Main.dc.html` line
          1442): the label at 14px / 700 over its line at 12px, the switch at
          the end. Same form, same action, same permission and audit as before;
          the save bar is the product's (G1, D-330).
        */}
        <section className="bsp-card bsp-sa-pol" data-testid="approvals-policy">
          {policies.length === 0 ? (
            <p className="bsp-sa-pol-empty">{t('settings.approvalsNoBrand')}</p>
          ) : (
            policies.map((policy) => (
              /* G1 (D-330): the save bar — keyed on the saved rules, so a save starts clean. */
              <DraftForm
                key={`${policy.brandId}-${policy.requireApprovalBeforeScheduling}-${policy.allowSelfApproval}`}
                action={saveApprovalPolicyAction}
                className="bsp-sa-pol-form"
                testId={`policy-form-${policy.brandId}`}
                barTestId={`policy-bar-${policy.brandId}`}
                saveTestId={`policy-save-${policy.brandId}`}
                labels={saveBarLabels(t)}
              >
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="brandId" value={policy.brandId} />
                {policies.length > 1 ? (
                  <strong className="bsp-sa-pol-brand">{policy.brandName}</strong>
                ) : null}
                <CheckboxRow
                  name="requireApproval"
                  label={t('approvals.policyRequire')}
                  hint={t('approvals.policyRequireSub')}
                  checked={policy.requireApprovalBeforeScheduling}
                  testId={`policy-require-${policy.brandId}`}
                />
                <CheckboxRow
                  name="allowSelfApproval"
                  label={t('approvals.policySelf')}
                  hint={t('approvals.policySelfSub')}
                  checked={policy.allowSelfApproval}
                  testId={`policy-self-${policy.brandId}`}
                />
              </DraftForm>
            ))
          )}
        </section>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
