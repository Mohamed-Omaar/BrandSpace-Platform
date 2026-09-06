import { Card, Field, buttonStyle, inputStyle, spacingTokens } from '@brandspace/ui';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { statusMessage, translator } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
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

      <Card testId="settings-card">
        {/*
          THE THREE CONTROLS ON THIS PAGE WERE INVISIBLE (F-38).

          They were styled with `customerInputStyle()` and carried no
          `bs-control` class, so under the borderless tokens they rendered as
          transparent rectangles on a white card — F-27 exactly, in three
          controls the original scan could not see because it only looked at
          calls named `inputStyle`. Their labels were hand-rolled `<label>`
          elements with a literal `0.8125rem` rather than `Field`, which is
          what let them drift in the first place.
        */}
        <form action={saveSettingsAction} style={{ display: 'grid', gap: spacingTokens.md }}>
          <input type="hidden" name="locale" value={locale} />

          <Field label={t('settings.name')} htmlFor="name">
            <input
              className="bs-control"
              id="name"
              name="name"
              defaultValue={row.name}
              required
              style={inputStyle()}
            />
          </Field>

          <Field label={t('settings.locale')} htmlFor="defaultLocale">
            <select
              className="bs-control"
              id="defaultLocale"
              name="defaultLocale"
              defaultValue={row.defaultLocale}
              style={inputStyle()}
            >
              <option value="AR">AR</option>
              <option value="EN">EN</option>
            </select>
          </Field>

          <Field label={t('settings.timezone')} htmlFor="timezone">
            <input
              className="bs-control"
              id="timezone"
              name="timezone"
              defaultValue={row.timezone}
              style={inputStyle()}
            />
          </Field>

          <div>
            <button type="submit" data-testid="settings-save" style={buttonStyle('primary')}>
              {t('common.save')}
            </button>
          </div>
        </form>
      </Card>
    </WorkspaceShell>
  );
}
