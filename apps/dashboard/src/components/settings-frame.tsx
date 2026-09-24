import type { ReactNode } from 'react';
import { SettingsSplit } from '@brandspace/ui';
import { settingsNavItems, type SettingsNavKey } from '../server/settings-nav';
import { translator } from '../i18n/messages';

/**
 * SETTINGS AS ONE PLACE (Phase 6 final, D-277 §3/§44).
 *
 * Team, Roles & permissions, Activity, Plan, Billing and Connections left the
 * main sidebar and moved under Settings. This frame is what makes that true on
 * the screen: every one of those routes renders inside the same Settings split
 * and section navigation the Workspace, Brand Profile, Security and Data pages
 * already use, so a member moving between them stays visibly in Settings.
 *
 * The EXISTING `SettingsSplit` — no new layout. The section list is
 * `settingsNavItems`, the table the guard test pins against each route's own
 * permission.
 */
export function SettingsFrame({
  locale,
  permissionKeys,
  selected,
  children,
}: {
  readonly locale: string;
  readonly permissionKeys: readonly string[];
  readonly selected: SettingsNavKey;
  readonly children: ReactNode;
}) {
  const t = translator(locale);
  return (
    <SettingsSplit
      navLabel={t('settings.navLabel')}
      items={settingsNavItems({ locale, permissionKeys, selected }).map((item) => ({
        href: item.href,
        label: t(item.labelKey),
        selected: item.selected,
      }))}
    >
      {children}
    </SettingsSplit>
  );
}
