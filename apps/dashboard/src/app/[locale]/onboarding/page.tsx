import Link from 'next/link';
import { colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { onboardingFor } from '../../../server/commerce-context';
import { brandContextFor } from '../../../server/brand-context';
import { translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, CustomerCard, WorkspaceShell } from '../../../components/workspace-shell';

export const dynamic = 'force-dynamic';

/**
 * The first-run checklist.
 *
 * EVERY ROW IS A QUESTION ASKED OF THE DATA, not a saved position. Closing the
 * tab, signing in on another device, or doing a step from its own screen all
 * produce the right answer — and a thing later deleted makes its step incomplete
 * again, which a stored counter could never do (§16).
 *
 * THE ROUTES ARE THE PRODUCT'S OWN. Onboarding does not build a parallel wizard
 * that duplicates the Brands page or the integrations screen; it points at them.
 * A second place to create a brand is a second place for that behaviour to
 * drift.
 */
const STEP_ROUTES: Readonly<Record<string, string>> = {
  workspace: '/settings',
  /*
   * THE BRAND STEP POINTS WHERE A BRAND CAN ACTUALLY BE CREATED (PHASE 2).
   *
   * It used to point at `/settings/brand`, which EDITS a brand: the page calls
   * `requiredBrand`, so a workspace with none of them has nothing for it to
   * show and no way to make one. The first step of onboarding sent a new
   * customer to a screen that could not complete it — they finished the wizard
   * with a workspace and no brand, and every module downstream of a brand was
   * unreachable.
   *
   * `/brand-brain` carries the no-brand branch with the creation form, which is
   * the only path in the product that creates one. `brand_profile` still points
   * at settings, because filling a profile in IS what that page is for.
   */
  brand: '/brand-brain',
  brand_profile: '/settings/brand',
  brand_brain: '/brand-brain',
  social: '/integrations',
  team: '/members',
  plan: '/billing',
};

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale);
  const { state } = await onboardingFor(workspace.workspaceId);
  const brandContext = await brandContextFor(workspace, '/onboarding');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('onboarding.title')}
      description={t('onboarding.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {state.complete ? (
        <CustomerBanner tone="success">
          <strong>{t('onboarding.complete')}</strong> {t('onboarding.completeBody')}
        </CustomerBanner>
      ) : null}

      <CustomerCard
        title={t('onboarding.progress')
          .replace('{done}', String(state.completedCount))
          .replace('{total}', String(state.steps.length))}
        testId="onboarding-checklist"
      >
        <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid' }}>
          {state.steps.map((step, index) => (
            <li
              key={step.key}
              data-testid={`onboarding-step-${step.key}`}
              data-complete={step.complete ? 'true' : 'false'}
              data-current={step.current ? 'true' : 'false'}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: spacingTokens.sm,
                paddingBlock: spacingTokens.sm,
                borderBlockStart: index === 0 ? 'none' : `1px solid ${colorTokens.hairline}`,
              }}
            >
              <span style={{ ...typographyTokens.bodySm }}>
                {t(`onboarding.step.${step.key}` as MessageKey)}
                {step.required ? null : (
                  <span
                    style={{
                      ...typographyTokens.caption,
                      color: colorTokens.textMuted,
                      marginInlineStart: spacingTokens.xs,
                    }}
                  >
                    {t('onboarding.optional')}
                  </span>
                )}
              </span>
              {step.complete ? (
                <span
                  data-testid={`onboarding-done-${step.key}`}
                  style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
                >
                  {t('onboarding.done')}
                </span>
              ) : (
                <Link
                  href={`/${locale}${STEP_ROUTES[step.key] ?? '/overview'}`}
                  data-testid={`onboarding-go-${step.key}`}
                  style={{ ...typographyTokens.bodySm, color: colorTokens.brandPurple }}
                >
                  {t('onboarding.continue')}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </CustomerCard>
    </WorkspaceShell>
  );
}
