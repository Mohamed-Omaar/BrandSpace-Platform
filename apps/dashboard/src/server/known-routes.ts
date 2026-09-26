/**
 * THE KNOWN NAVIGATION LIST, AND WHAT EACH PAGE ASKS (E2, Q5).
 *
 * A page on this list that the member's role does not open answers "No access
 * to this page" inside the normal shell, with the E6 denial text, instead of
 * the not-found screen. Q5 limits that to exactly these routes: each is in the
 * sidebar, the Settings list or the top bar, so every member already knows it
 * exists and naming it leaks nothing. Anything else — an unknown URL, a record
 * in another brand or workspace, a resource id — keeps the identical 404
 * (CLAUDE.md §2.1).
 *
 * THE PERMISSION IS THE PAGE'S GATE, stated once. A page on this list calls
 * `requireWorkspacePage(locale, '<route>')` and reads its permission from
 * here; `tests/unit/prototype-v90-phase2a.test.ts` pins that the sidebar
 * (`NAV`), the Settings list (`SETTINGS_NAV_ROUTES`) and the top bar agree with
 * this table, so the three cannot drift from the gate they advertise.
 *
 * PURE, AND NOT `server-only`, so the unit suite reads it directly.
 */
export const KNOWN_PAGE_PERMISSIONS = {
  // Sidebar
  '/brand-brain': 'brand_brain.read',
  '/strategy': 'strategy.read',
  '/campaigns': 'campaigns.read',
  '/content': 'content.read',
  '/creative': 'assets.upload',
  '/assets': 'assets.read',
  '/calendar': 'content.read',
  '/publishing': 'publishing.read',
  '/analytics': 'analytics.read',
  '/intelligence': 'strategy.read',
  '/automations': 'automation.read',
  // Settings list
  '/settings': 'workspace.update',
  '/settings/brand': 'brand.read',
  '/settings/approvals': 'approvals.policy.manage',
  '/settings/data': 'workspace.update',
  '/integrations': 'integrations.read',
  '/members': 'member.read',
  '/billing': 'billing.read',
  '/plan': 'billing.read',
  // Top bar: destinations and creation flows
  '/approvals': 'content.read',
  // `NOTE_PERMISSION` in `@brandspace/collaboration`; the unit suite pins the two equal.
  '/notes': 'content.read',
  '/copilot': 'copilot.use',
  '/content/compose': 'content.read',
  '/campaigns/new': 'campaigns.manage',
} as const satisfies Readonly<Record<string, string>>;

export type KnownPage = keyof typeof KNOWN_PAGE_PERMISSIONS;
