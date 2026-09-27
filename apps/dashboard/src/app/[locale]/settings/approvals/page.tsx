import {
  Card,
  DraftForm,
  SectionHeader,
  SettingsSplit,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import type { ResolvedApprovalPolicy } from '@brandspace/content';
import { requireWorkspacePage } from '../../../../server/customer-context';
import { NoAccessPage } from '../../../../components/no-access-page';
import { brandContextFor, listAccessibleBrands } from '../../../../server/brand-context';
import { settingsNavItems } from '../../../../server/settings-nav';
import { inContentStudio } from '../../../../server/content-context';
import { statusMessage, translator } from '../../../../i18n/messages';
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
  const t = translator(locale);
  const access = await requireWorkspacePage(locale, '/settings/approvals');
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
    }[] = [];
    for (const brand of brands) {
      const policy: ResolvedApprovalPolicy = await service.policyForBrand(brand.id);
      rows.push({
        brandId: brand.id,
        brandName: brand.name,
        requireApprovalBeforeScheduling: policy.requireApprovalBeforeScheduling,
        allowSelfApproval: policy.allowSelfApproval,
      });
    }
    return rows;
  });

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const brandContext = await brandContextFor(workspace, '/settings');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('settings.approvals')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}
      <SettingsSplit
        navLabel={t('settings.navLabel')}
        items={settingsNavItems({
          locale,
          permissionKeys: workspace.permissionKeys,
          selected: 'approvals',
        }).map((item) => ({ href: item.href, label: t(item.labelKey), selected: item.selected }))}
      >
        <Card testId="approvals-policy">
          <SectionHeader
            title={t('approvals.policyTitle')}
            description={t('approvals.policyBody')}
          />
          {policies.length === 0 ? (
            <p style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary, margin: 0 }}>
              {t('settings.approvalsNoBrand')}
            </p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: spacingTokens.md,
              }}
            >
              {policies.map((policy) => (
                <li key={policy.brandId}>
                  {/* G1 (D-330): the save bar — keyed on the saved rules, so a save starts clean. */}
                  <DraftForm
                    key={`${policy.requireApprovalBeforeScheduling}-${policy.allowSelfApproval}`}
                    action={saveApprovalPolicyAction}
                    style={{ display: 'grid', gap: spacingTokens.sm }}
                    testId={`policy-form-${policy.brandId}`}
                    barTestId={`policy-bar-${policy.brandId}`}
                    saveTestId={`policy-save-${policy.brandId}`}
                    labels={saveBarLabels(t)}
                  >
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="brandId" value={policy.brandId} />
                    {policies.length > 1 ? (
                      <strong style={typographyTokens.bodySm}>{policy.brandName}</strong>
                    ) : null}
                    <CheckboxRow
                      name="requireApproval"
                      label={t('approvals.policyRequire')}
                      checked={policy.requireApprovalBeforeScheduling}
                      testId={`policy-require-${policy.brandId}`}
                    />
                    <CheckboxRow
                      name="allowSelfApproval"
                      label={t('approvals.policySelf')}
                      checked={policy.allowSelfApproval}
                      testId={`policy-self-${policy.brandId}`}
                    />
                  </DraftForm>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </SettingsSplit>
    </WorkspaceShell>
  );
}
