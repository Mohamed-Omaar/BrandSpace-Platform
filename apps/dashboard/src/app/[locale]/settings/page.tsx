import { spacingTokens } from '@brandspace/ui';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { statusMessage, translator } from '../../../i18n/messages';
import {
  CustomerBanner,
  CustomerCard,
  WorkspaceShell,
  customerButtonStyle,
  customerInputStyle,
} from '../../../components/workspace-shell';
import { saveSettingsAction } from './actions';

export const dynamic = 'force-dynamic';

/** Workspace settings. Requires `workspace.update`; otherwise a 404. */
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { workspace } = await requireWorkspace(locale, 'workspace.update');

  const row = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.workspace.findUniqueOrThrow({
      where: { id: workspace.workspaceId },
      select: { name: true, defaultLocale: true, timezone: true, slug: true, status: true },
    }),
  );

  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const ref = typeof query['ref'] === 'string' ? query['ref'] : undefined;

  return (
    <WorkspaceShell
      locale={locale}
      heading={t('settings.title')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      permissionKeys={workspace.permissionKeys}
    >
      {error && <CustomerBanner tone="error">{statusMessage(error, locale, ref)}</CustomerBanner>}
      {ok && statusMessage(ok, locale) && (
        <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner>
      )}

      <CustomerCard testId="settings-card">
        <form action={saveSettingsAction}>
          <input type="hidden" name="locale" value={locale} />
          <label
            htmlFor="name"
            style={{ display: 'block', fontWeight: 600, fontSize: '0.8125rem' }}
          >
            {t('settings.name')}
          </label>
          <input
            id="name"
            name="name"
            defaultValue={row.name}
            required
            style={customerInputStyle()}
          />

          <label
            htmlFor="defaultLocale"
            style={{
              display: 'block',
              fontWeight: 600,
              fontSize: '0.8125rem',
              marginBlockStart: spacingTokens.md,
            }}
          >
            {t('settings.locale')}
          </label>
          <select
            id="defaultLocale"
            name="defaultLocale"
            defaultValue={row.defaultLocale}
            style={customerInputStyle()}
          >
            <option value="AR">AR</option>
            <option value="EN">EN</option>
          </select>

          <label
            htmlFor="timezone"
            style={{
              display: 'block',
              fontWeight: 600,
              fontSize: '0.8125rem',
              marginBlockStart: spacingTokens.md,
            }}
          >
            {t('settings.timezone')}
          </label>
          <input
            id="timezone"
            name="timezone"
            defaultValue={row.timezone}
            style={customerInputStyle()}
          />

          <button
            type="submit"
            data-testid="settings-save"
            style={{ ...customerButtonStyle(), marginBlockStart: spacingTokens.lg }}
          >
            {t('common.save')}
          </button>
        </form>
      </CustomerCard>
    </WorkspaceShell>
  );
}
