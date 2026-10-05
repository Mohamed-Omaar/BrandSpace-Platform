import type { ReactNode } from 'react';
import Link from 'next/link';
import { settingsNavItems, type SettingsNavKey } from '../server/settings-nav';
import { translator, type MessageKey } from '../i18n/messages';
import { requestMessageLocale } from '../server/message-locale';
import { listAccessibleBrands } from '../server/brand-context';
import type { BrandContextSource } from '../server/brand-selection';

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
  { labelKey: 'settings.group.people', keys: ['members', 'approvals'] },
  {
    labelKey: 'settings.group.publishing',
    keys: ['connections', 'publishing', 'notifications'],
  },
  { labelKey: 'settings.group.aiBilling', keys: ['ai', 'billing'] },
  { labelKey: 'settings.group.security', keys: ['security', 'data'] },
];

/**
 * ONE PAGE, TITLED "SETTINGS" (review of #67): the prototype's inner menu —
 * General · Brands · Team & roles · Approvals · Accounts · Publishing defaults
 * · Notifications · AI · Plan & billing · Security · Data — and each section's
 * own heading and line under it. Every product route keeps its address and its
 * own permission check; Roles & permissions belongs to Team & roles and the
 * activity log to Security, as the prototype words them, so their routes light
 * those rows and are reached from inside those sections.
 */
const SECTION: Readonly<Record<SettingsNavKey, string>> = {
  settings: 'biz',
  brand: 'brands',
  members: 'team',
  permissions: 'team',
  approvals: 'appr',
  connections: 'conn',
  publishing: 'pub',
  notifications: 'notif',
  ai: 'ai',
  billing: 'bill',
  security: 'sec',
  activity: 'sec',
  data: 'data',
};
const ROW_OF: Partial<Record<SettingsNavKey, SettingsNavKey>> = {
  permissions: 'members',
  activity: 'security',
};
/** Inside a section: the product page that belongs to it, one link away. */
const RELATED: Partial<
  Record<SettingsNavKey, { readonly key: SettingsNavKey; readonly labelKey: MessageKey }>
> = {
  members: { key: 'permissions', labelKey: 'perms.title' },
  permissions: { key: 'members', labelKey: 'members.title' },
  security: { key: 'activity', labelKey: 'nav.activity' },
  activity: { key: 'security', labelKey: 'security.title' },
};

export async function SettingsFrame({
  locale,
  permissionKeys,
  brandSource,
  selected,
  more,
  children,
}: {
  readonly locale: string;
  readonly permissionKeys: readonly string[];
  /** The session's workspace, so the frame can count the brands it may see. */
  readonly brandSource: BrandContextSource;
  readonly selected: SettingsNavKey;
  /**
   * Gate 2b review — a section's "⋯" at the end of its head: where a product
   * control the prototype does not draw is kept (D-471), e.g. Post templates.
   */
  readonly more?: ReactNode;
  readonly children: ReactNode;
}) {
  const t = translator(requestMessageLocale(locale));
  /*
   * ROUND 4 (4.2) — "BRANDS" ONLY WHEN THERE IS MORE THAN ONE. The owner's
   * decision: a workspace with exactly one brand has no Brands row. The
   * capability stays — the route, its permission, and a "Brand profile →"
   * link on General, the section a one-brand workspace edits it from. Counted
   * as the member may see them (the same list the brand switcher reads), so
   * nothing about brands they cannot see is inferred from the menu.
   */
  const oneBrand = (await listAccessibleBrands(brandSource).catch(() => [])).length === 1;
  const items = settingsNavItems({ locale, permissionKeys, selected }).filter(
    (item) => !(oneBrand && item.key === 'brand' && selected !== 'brand'),
  );
  const brandItem = oneBrand
    ? settingsNavItems({ locale, permissionKeys, selected }).find((item) => item.key === 'brand')
    : undefined;
  const row = ROW_OF[selected] ?? selected;
  const section = SECTION[selected];
  const related =
    selected === 'settings' && brandItem
      ? { key: 'brand' as const, labelKey: 'brand.profile' as MessageKey }
      : RELATED[selected];
  const relatedItem = related
    ? (items.find((item) => item.key === related.key) ??
      (related.key === 'brand' ? brandItem : undefined))
    : undefined;
  return (
    <div className="bs-settings-split bsp-sg" data-testid="settings-split">
      <nav aria-label={t('settings.navLabel')} className="bsp-sg-nav" data-testid="settings-nav">
        {GROUPS.map((group) => {
          // In the prototype's order within each group, not the table's.
          const rows = group.keys.flatMap((key) => items.filter((item) => item.key === key));
          if (rows.length === 0) return null;
          return (
            <div key={group.labelKey} className="bsp-sg-grp">
              <span className="bsp-sg-gl">{t(group.labelKey)}</span>
              {rows.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="bsp-nav bsp-sg-item"
                  aria-current={item.key === row ? 'page' : undefined}
                  data-testid={`settings-nav-${item.key}`}
                >
                  {t(`settings.sec.${SECTION[item.key]}` as MessageKey)}
                </Link>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="bsp-sg-main">
        {/*
          The section's heading: `h2.sech` at 20px and the line under it
          (12.5px, the muted grey), `Main.dc.html` line 1340.
        */}
        <div className="bsp-sg-head" data-testid="settings-section-head">
          <span className="bsp-sg-headtext">
            <h2 className="bsp-sech bsp-sg-title">{t(`settings.sec.${section}` as MessageKey)}</h2>
            <span className="bsp-sg-sub">{t(`settings.sec.${section}.sub` as MessageKey)}</span>
          </span>
          {relatedItem && related ? (
            <Link
              href={relatedItem.href}
              className="bsp-btn bsp-sm bsp-ghost"
              data-testid={`settings-related-${related.key}`}
            >
              {t(related.labelKey)} →
            </Link>
          ) : null}
          {more}
        </div>
        {children}
      </div>
    </div>
  );
}
