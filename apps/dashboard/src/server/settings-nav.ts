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
export type SettingsNavKey = 'settings' | 'brand' | 'members' | 'permissions' | 'plan';

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
  { key: 'members', path: '/members', labelKey: 'nav.members', permission: 'member.read' },
  /*
   * PERMISSIONS IS OPEN TO EVERY MEMBER ON PURPOSE. It shows the reader their
   * OWN effective permissions, which is information they already have by
   * definition — `requireWorkspace(locale)` with no permission argument.
   */
  { key: 'permissions', path: '/permissions', labelKey: 'perms.title', permission: null },
  { key: 'plan', path: '/plan', labelKey: 'nav.plan', permission: 'billing.read' },
];

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
