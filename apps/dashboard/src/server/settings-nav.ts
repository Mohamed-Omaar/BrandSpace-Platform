/**
 * THE SETTINGS SECTION NAVIGATION, IN ONE PLACE.
 *
 * WHY THIS FILE EXISTS. The Settings nav was written out by hand on each page
 * that renders it, and the two copies had already drifted: workspace Settings
 * gated Members and Plan on their permissions, while Brand Profile listed
 * `/settings` unconditionally — a row a member holding only `brand.read` could
 * click and be answered 404 by a route doing exactly what it should. A list of
 * links each page re-derives is a list each page can get wrong.
 *
 * WHAT A GATE HERE IS, AND WHAT IT IS NOT. It is DEAD-LINK PREVENTION and
 * nothing else. Every route below calls `requireWorkspace(locale, <permission>)`
 * itself and answers 404 without it, so hiding a row removes a broken promise
 * from the screen — it does not remove an authorization check, and no
 * authorization rule anywhere depends on the row being hidden (CLAUDE.md §2.1,
 * docs/SECURITY.md). Typing the URL still fails, and fails identically to a
 * route that does not exist.
 *
 * THE PERMISSION COLUMN MIRRORS THE ROUTE. `tests/unit/phase8-settings-nav.test.ts`
 * reads each page's own `requireWorkspace` call and fails if this table and the
 * route disagree, so the mirror cannot rot the way the hand-written copies did.
 */

import type { MessageKey } from '../i18n/messages';

/** The Settings-section destinations, in the order they are shown. */
export type SettingsNavKey =
  | 'settings'
  | 'brand'
  | 'security'
  | 'connections'
  | 'data'
  | 'members'
  | 'permissions'
  | 'activity'
  | 'billing';

export interface SettingsNavEntry {
  readonly key: SettingsNavKey;
  readonly href: string;
  /** A translation key: §4 forbids user-facing copy in a component. */
  readonly labelKey: MessageKey;
  readonly selected: boolean;
}

interface SettingsNavRoute {
  readonly key: SettingsNavKey;
  readonly path: string;
  readonly labelKey: MessageKey;
  /** What the route's own `requireWorkspace` demands; `null` means any member. */
  readonly permission: string | null;
}

export const SETTINGS_NAV_ROUTES: readonly SettingsNavRoute[] = [
  {
    key: 'settings',
    path: '/settings',
    labelKey: 'settings.title',
    permission: 'workspace.update',
  },
  { key: 'brand', path: '/settings/brand', labelKey: 'brand.profile', permission: 'brand.read' },
  /*
   * P6-13 — CONNECTIONS, reached from Settings as well as from the PUBLISH
   * group. The connected accounts are workspace configuration as much as a
   * publishing tool, and a person looking in Settings for "where are our
   * accounts" was not told. The same route, not a second screen.
   */
  {
    key: 'connections',
    path: '/integrations',
    labelKey: 'settings.connections',
    permission: 'integrations.read',
  },
  { key: 'members', path: '/members', labelKey: 'nav.members', permission: 'member.read' },
  /*
   * PERMISSIONS IS OPEN TO EVERY MEMBER ON PURPOSE. It shows the reader their
   * OWN effective permissions, which is information they already have by
   * definition — `requireWorkspace(locale)` with no permission argument.
   */
  { key: 'permissions', path: '/permissions', labelKey: 'perms.title', permission: null },
  /*
   * SECURITY IS OPEN TO EVERY MEMBER, for the reason `permissions` is: it shows
   * the reader their OWN second factor and their own sessions, which belong to
   * the person rather than to the workspace. No permission gates it because
   * there is no other person whose security it could show.
   */
  { key: 'security', path: '/settings/security', labelKey: 'security.title', permission: null },
  /*
   * P6-13 — DATA CONTROLS: one page naming every control this product has over
   * a workspace's data, and saying plainly which ones it does not have yet.
   */
  {
    key: 'data',
    path: '/settings/data',
    labelKey: 'settings.data',
    permission: 'workspace.update',
  },
  /*
   * ACTIVITY (Phase 6 final, D-277 §44/§47) — the workspace's audit trail,
   * graded by what the reader may see rather than refused, which is why it asks
   * no permission here, exactly as its route does.
   */
  { key: 'activity', path: '/activity', labelKey: 'nav.activity', permission: null },
  /*
   * BILLING & USAGE IS ONE SECTION (Phase 6 final, D-277 §44/§46, D-298). The
   * plan and payments (`/billing`) and the usage, limits and credit history
   * (`/plan`) are two tabs of it, not two Settings rows. Both routes keep their
   * own `billing.read` check; `/plan` is listed in `SETTINGS_SUBPATHS` so the
   * sidebar still marks Settings current there.
   */
  { key: 'billing', path: '/billing', labelKey: 'nav.billing', permission: 'billing.read' },
];

/** Routes that are TABS of a Settings section rather than rows of their own. */
export const SETTINGS_SUBPATHS: readonly string[] = ['/plan'];

/**
 * The rows this member can actually open, with one marked current.
 *
 * The selected row is included even when the table says it is gated, because a
 * member who is READING the page has already passed the route's own check —
 * omitting it would leave the section nav with no current entry.
 */
export function settingsNavItems(input: {
  readonly locale: string;
  readonly permissionKeys: readonly string[];
  readonly selected: SettingsNavKey;
}): readonly SettingsNavEntry[] {
  return SETTINGS_NAV_ROUTES.filter(
    (route) =>
      route.key === input.selected ||
      route.permission === null ||
      input.permissionKeys.includes(route.permission),
  ).map((route) => ({
    key: route.key,
    href: `/${input.locale}${route.path}`,
    labelKey: route.labelKey,
    selected: route.key === input.selected,
  }));
}

/**
 * WHERE "SETTINGS" OPENS for this member (Phase 6 final, D-277 §3/§44).
 *
 * Settings is now the single home of workspace administration, and it is on
 * the sidebar for EVERY member — but its first section, Workspace, needs
 * `workspace.update`. So the sidebar entry opens the first section this member
 * may actually read, in the order above, rather than a 404. Security, Roles &
 * permissions and Activity ask no permission, so there is always one.
 */
export function settingsLandingPath(permissionKeys: readonly string[]): string {
  const first = SETTINGS_NAV_ROUTES.find(
    (route) => route.permission === null || permissionKeys.includes(route.permission),
  );
  return first ? first.path : '/settings/security';
}

/** Every path that belongs to Settings, so the sidebar can mark it current. */
export const SETTINGS_PATHS: readonly string[] = [
  ...SETTINGS_NAV_ROUTES.map((route) => route.path),
  ...SETTINGS_SUBPATHS,
];
