import { Card, DraftForm, SectionHeader, SettingsSplit, spacingTokens } from '@brandspace/ui';
import { NOTIFICATION_CATEGORIES, NotificationPreferenceService } from '@brandspace/notifications';
import { inWorkspace, requireWorkspace } from '../../../../server/customer-context';
import { brandContextFor } from '../../../../server/brand-context';
import { settingsNavItems } from '../../../../server/settings-nav';
import { saveBarLabels } from '../../../../server/save-bar-labels';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { CheckboxRow } from '../../../../components/checkbox-row';
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
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale);

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
      heading={t('settings.notifications')}
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
          selected: 'notifications',
        }).map((item) => ({ href: item.href, label: t(item.labelKey), selected: item.selected }))}
      >
        <Card testId="notification-preferences">
          <SectionHeader
            title={t('notificationPrefs.title')}
            description={t('notificationPrefs.body')}
          />
          <DraftForm
            key={JSON.stringify(preferences)}
            action={saveNotificationPreferencesAction}
            style={{ display: 'grid', gap: spacingTokens.sm }}
            testId="notification-preferences-form"
            barTestId="notification-preferences-bar"
            saveTestId="notification-preferences-save"
            labels={saveBarLabels(t)}
          >
            <input type="hidden" name="locale" value={locale} />
            {NOTIFICATION_CATEGORIES.map((category) => (
              <CheckboxRow
                key={category}
                name="category"
                value={category}
                label={t(`notificationPrefs.${category}`)}
                hint={t(`notificationPrefs.${category}.hint`)}
                checked={preferences[category]}
                testId={`notification-pref-${category}`}
              />
            ))}
          </DraftForm>
        </Card>
      </SettingsSplit>
    </WorkspaceShell>
  );
}
