import { StateMessage, Stack, spacingTokens } from '@brandspace/ui';
import { copilotSurface } from '../../../server/copilot-surface';
import { copilotLabels } from '../../../server/copilot-labels';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { translator } from '../../../i18n/messages';
import { WorkspaceShell } from '../../../components/workspace-shell';
import { CopilotView } from './copilot-view';

import { EmptyAction } from '../../../components/empty-action';

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
/**
 * P6-12 — THE COPILOT KNOWS WHERE IT WAS OPENED FROM, AND WHICH BRAND.
 *
 * `?from=` names the screen the person came from, narrowed to the closed
 * surface list the API accepts (`COPILOT_SURFACE_KEYS`) — anything else is
 * `general`, so the parameter cannot carry text into the assistant.
 *
 * THE BRAND IS THE RAIL'S (D-190). The screen used to keep its own picker,
 * defaulting to the alphabetically first brand, so the assistant could be
 * acting on a different brand from the one the rail said was selected. It now
 * takes the global brand context and, when that is not exactly one brand, says
 * so rather than guessing — a brand-less conversation has no tools at all.
 */
export default async function CopilotPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const session = await requireWorkspace(locale, 'copilot.use');
  const { workspace } = session;

  const maySeeCredits = workspace.permissionKeys.includes('credits.read');
  const from = typeof query['from'] === 'string' ? query['from'] : null;
  const surface = copilotSurface(from);

  const brandContext = await brandContextFor(
    session.workspace,
    '/copilot',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const brand = requiredBrand(brandContext);

  const wallet = maySeeCredits
    ? await inWorkspace(workspace.workspaceId, async (services) =>
        services.credits.wallet(workspace.workspaceId),
      )
    : null;

  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en');

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
        {!brand ? (
          <StateMessage
            kind="empty"
            title={
              brandContext.resolution.kind === 'unselected'
                ? t('brand.chooseTitle')
                : t('analytics.noBrandTitle')
            }
            description={
              brandContext.resolution.kind === 'unselected'
                ? t('brand.chooseBody')
                : t('copilot.noBrandBody')
            }
            action={
              brandContext.resolution.kind === 'empty' &&
              workspace.permissionKeys.includes('brand.manage') ? (
                <EmptyAction
                  href={`/${locale}/brand-brain`}
                  label={t('bb.createBrand')}
                  testId="no-brand-create"
                />
              ) : undefined
            }
          />
        ) : (
          <CopilotView
            locale={locale}
            brand={{ id: brand.id, name: brand.name }}
            surface={surface}
            // D-296 — a request handed over without script; put in the box, never sent.
            initialRequest={typeof query['ask'] === 'string' ? query['ask'].slice(0, 1_000) : ''}
            creditsLabel={wallet ? number.format(wallet.balanceCredits) : null}
            labels={copilotLabels(locale, session.customer.name ?? session.customer.email)}
          />
        )}
      </Stack>
    </WorkspaceShell>
  );
}
