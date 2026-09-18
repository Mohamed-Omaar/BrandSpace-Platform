import { Stack, spacingTokens } from '@brandspace/ui';
import { brandScopeFilter } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { translator } from '../../../i18n/messages';
import { WorkspaceShell } from '../../../components/workspace-shell';
import { CopilotView } from './copilot-view';

export const dynamic = 'force-dynamic';

/**
 * THE AI COPILOT.
 *
 * WHO MAY OPEN IT: a member holding `copilot.use`, and nobody else. A Viewer
 * (read-only) holds `workspace.read` and nothing else (D-62, D-130).
 *
 * `copilot.use` IS NOT A WAY TO EXCEED YOUR OWN PERMISSIONS. Every tool the
 * assistant offers is filtered by what this person already holds, and every tool
 * it executes re-resolves their permissions, brand scope and entitlements from
 * the LIVE membership at the moment it runs. The assistant can do nothing its
 * user could not do by hand — and it does it through the same domain services
 * they would.
 *
 * THE CREDIT BALANCE IS SHOWN ONLY WHERE IT CAN BE READ. `credits.read` gates it,
 * and a member without the permission is shown no number rather than a
 * plausible-looking placeholder (CLAUDE.md §2.2).
 */
export default async function CopilotPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  const session = await requireWorkspace(locale, 'copilot.use');
  const { workspace } = session;

  const maySeeCredits = workspace.permissionKeys.includes('credits.read');

  const { brands, wallet } = await inWorkspace(workspace.workspaceId, async (services) => ({
    brands: await services.db.brand.findMany({
      where: { status: 'ACTIVE', ...brandScopeFilter(workspace.brandScope) },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
    wallet: maySeeCredits ? await services.credits.wallet(workspace.workspaceId) : null,
  }));

  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en');

  const brandContext = await brandContextFor(session.workspace, '/copilot');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('copilot.title')}
      description={t('copilot.subtitle')}
      activePath="/copilot"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.name ?? session.customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <Stack gap={spacingTokens.lg}>
        <CopilotView
          locale={locale}
          brands={brands}
          creditsLabel={wallet ? number.format(wallet.balanceCredits) : null}
          labels={{
            title: t('copilot.title'),
            subtitle: t('copilot.subtitle'),
            open: t('copilot.title'),
            close: t('common.close'),
            promptLabel: t('copilot.promptLabel'),
            promptPlaceholder: t('copilot.promptPlaceholder'),
            send: t('copilot.send'),
            attach: t('copilot.promptLabel'),
            attachmentsLabel: t('copilot.promptLabel'),
            suggestionsLabel: t('copilot.plan'),
            conversationLabel: t('copilot.title'),
            streaming: t('copilot.send'),
            errorTitle: t('copilot.undoRefused'),
            errorBody: t('copilot.planEmpty'),
            insufficientCreditsTitle: t('insights.insufficientTitle'),
            insufficientCreditsBody: t('insights.insufficientBody'),
            approvalTitle: t('copilot.plan'),
            approvalBody: t('copilot.externalWarning'),
            approve: t('copilot.confirm'),
            reject: t('copilot.reject'),
            mutatingWarning: t('copilot.externalWarning'),
            disabledNotice: t('copilot.promptLabel'),
            surfaceNames: {
              general: t('copilot.title'),
              calendar: t('nav.calendar'),
              posts: t('nav.content'),
              composer: t('nav.content'),
              studio: t('nav.content'),
            },
            contextLabel: t('analytics.brandLabel'),
            toolsLabel: t('copilot.plan'),
            previewTitle: t('copilot.plan'),
            beforeLabel: t('copilot.preview.status'),
            afterLabel: t('copilot.preview.status'),
            assistantName: t('copilot.title'),
            userName: session.customer.name ?? session.customer.email,
          }}
        />
      </Stack>
    </WorkspaceShell>
  );
}
