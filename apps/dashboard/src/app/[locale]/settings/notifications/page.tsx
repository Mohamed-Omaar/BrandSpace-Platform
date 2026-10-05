import { DraftForm } from '@brandspace/ui';
import { NOTIFICATION_CATEGORIES, NotificationPreferenceService } from '@brandspace/notifications';
import { inWorkspace, requireWorkspace } from '../../../../server/customer-context';
import { brandContextFor } from '../../../../server/brand-context';
import { SettingsFrame } from '../../../../components/settings-frame';
import { saveBarLabels } from '../../../../server/save-bar-labels';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { saveNotificationPreferencesAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * SETTINGS → NOTIFICATIONS (A10 / G2, prototype v94 Phase 2B-1, D-331).
 *
 * The reader's OWN switches for their in-app notifications, so it is open to
 * every member, like Security: nobody can see or change another person's.
 * Each switch filters one category of the bell; a notice about the workspace
 * itself is not switchable and always arrives. Under the save bar (G1).
 *
 * DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): `SettingsSplit`, `Card`,
 * `SectionHeader` and the composed checkbox row with its hint line.
 */
export default async function NotificationSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const { customer, workspace, messageLocale } = await requireWorkspace(locale);
  const t = translator(messageLocale);

  const preferences = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    new NotificationPreferenceService({ db, workspaceId: workspace.workspaceId }).forUser(
      customer.userId,
    ),
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
        selected="notifications"
      >
        {/*
          ROUND 4, GATE 2b — THE PROTOTYPE'S NOTIFICATIONS (`Main.dc.html`
          lines 1363–1367): an `xcard` table — a head row (Event · In app) and
          one row per event with its switch centred in a 90px column. The
          Email column is BLOCKED (owner decision, Gate 2: per-event email
          preferences do not exist), so only "In app" is drawn. Each switch is
          the same category checkbox, posted to the same action.
        */}
        <DraftForm
          key={JSON.stringify(preferences)}
          action={saveNotificationPreferencesAction}
          // Gate 2b review (4b): the bar on the frame's bottom edge, as on General.
          className="bsp-nt bsp-sg-form"
          testId="notification-preferences-form"
          barTestId="notification-preferences-bar"
          saveTestId="notification-preferences-save"
          labels={saveBarLabels(t)}
        >
          <input type="hidden" name="locale" value={locale} />
          <section className="bsp-xcard bsp-nt-card" data-testid="notification-preferences">
            <div className="bsp-nt-head" aria-hidden="true">
              <span>{t('notificationPrefs.colEvent')}</span>
              <span className="bsp-nt-c">{t('notificationPrefs.colInApp')}</span>
            </div>
            {NOTIFICATION_CATEGORIES.map((category) => (
              <label key={category} className="bsp-nt-row">
                <span className="bsp-nt-l">
                  {t(`notificationPrefs.${category}`)}
                  <span className="bsp-nt-hint" id={`notification-pref-${category}-hint`}>
                    {t(`notificationPrefs.${category}.hint`)}
                  </span>
                </span>
                <span className="bsp-nt-c">
                  <input
                    type="checkbox"
                    name="category"
                    value={category}
                    defaultChecked={preferences[category]}
                    className="bsp-tgl-in"
                    aria-describedby={`notification-pref-${category}-hint`}
                    data-testid={`notification-pref-${category}`}
                  />
                </span>
              </label>
            ))}
          </section>
        </DraftForm>
      </SettingsFrame>
    </WorkspaceShell>
  );
}
