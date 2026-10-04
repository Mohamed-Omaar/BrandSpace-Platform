import type { ReactNode } from 'react';
import Link from 'next/link';
import { settingsNavItems, type SettingsNavKey } from '../server/settings-nav';
import { translator, type MessageKey } from '../i18n/messages';
import { requestMessageLocale } from '../server/message-locale';

/**
 * SETTINGS AS ONE PLACE (Phase 6 final, D-277 §3/§44).
 *
 * Team, Roles & permissions, Activity, Plan, Billing and Connections left the
 * main sidebar and moved under Settings. This frame is what makes that true on
 * the screen: every one of those routes renders inside the same Settings split
 * and section navigation, so a member moving between them stays visibly in
 * Settings. The section list is `settingsNavItems`, the table the guard test
 * pins against each route's own permission.
 *
 * D-468 — THE PROTOTYPE'S SETTINGS COLUMN, `Main.dc.html` lines 1337–1340: a
 * 210px column of groups, each with its small capitalised label and its rows
 * drawn as the rail's `.nav` items, beside the section. The groups are the
 * prototype's (Workspace · People · Publishing · AI & billing · Security); the
 * rows in them are the product's routes, each in the group the prototype puts
 * it in. Below 1100px — the phone layout, and a tablet's, where a 210px column
 * would leave the section too narrow — the sections are one card above it.
 */
const GROUPS: readonly {
  readonly labelKey: MessageKey;
  readonly keys: readonly SettingsNavKey[];
}[] = [
  { labelKey: 'settings.group.workspace', keys: ['settings', 'brand'] },
  { labelKey: 'settings.group.people', keys: ['members', 'permissions', 'approvals'] },
  {
    labelKey: 'settings.group.publishing',
    keys: ['connections', 'publishing', 'notifications'],
  },
  { labelKey: 'settings.group.aiBilling', keys: ['ai', 'billing'] },
  { labelKey: 'settings.group.security', keys: ['security', 'data', 'activity'] },
];

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
  const t = translator(requestMessageLocale(locale));
  const items = settingsNavItems({ locale, permissionKeys, selected });
  return (
    <div className="bs-settings-split bsp-sg" data-testid="settings-split">
      <nav aria-label={t('settings.navLabel')} className="bsp-sg-nav" data-testid="settings-nav">
        {GROUPS.map((group) => {
          const rows = items.filter((item) => group.keys.includes(item.key));
          if (rows.length === 0) return null;
          return (
            <div key={group.labelKey} className="bsp-sg-grp">
              <span className="bsp-sg-gl">{t(group.labelKey)}</span>
              {rows.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="bsp-nav bsp-sg-item"
                  aria-current={item.selected ? 'page' : undefined}
                >
                  {t(item.labelKey)}
                </Link>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="bsp-sg-main">{children}</div>
    </div>
  );
}
