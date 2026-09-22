import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_NAV_ROUTES,
  settingsNavItems,
} from '../../apps/dashboard/src/server/settings-nav';

/**
 * PHASE 8 — NO NAVIGATION ROW LEADS TO A 404.
 *
 * THE DEFECT THESE EXIST FOR. Brand Profile requires only `brand.read`, and its
 * section nav listed workspace Settings — which requires `workspace.update` —
 * unconditionally. A brand manager who is not a workspace administrator could
 * legitimately open Brand Profile, click the row above it, and be answered 404
 * by a route behaving exactly as designed. The Brand Selector had the same
 * shape of bug pointing the other way: it offered the Brand Profile row to any
 * member with a resolved brand, whether or not they could read one.
 *
 * WHAT IS NOT BEING TESTED HERE. Authorization. Every route calls
 * `requireWorkspace` itself and answers 404 without the permission; these
 * assertions are about not PROMISING a destination the reader cannot reach.
 * Hiding a link is never the thing that keeps anybody out, and the isolation
 * suite proves the routes refuse independently.
 */

const ROOT = path.resolve(__dirname, '../..');

const MEMBER_ONLY: readonly string[] = [];
const BRAND_MANAGER: readonly string[] = ['brand.read', 'brand.manage'];
const WORKSPACE_ADMIN: readonly string[] = [
  'workspace.update',
  'brand.read',
  'member.read',
  'billing.read',
];

describe('P8: the settings nav offers only what the member can open', () => {
  it('hides workspace settings from somebody who may only read a brand', () => {
    const items = settingsNavItems({
      locale: 'en',
      permissionKeys: BRAND_MANAGER,
      selected: 'brand',
    });
    expect(items.map((item) => item.href)).not.toContain('/en/settings');
    expect(items.map((item) => item.href)).toContain('/en/settings/brand');
  });

  it('hides brand profile from a workspace administrator without brand.read', () => {
    const items = settingsNavItems({
      locale: 'en',
      permissionKeys: ['workspace.update'],
      selected: 'settings',
    });
    expect(items.map((item) => item.href)).not.toContain('/en/settings/brand');
  });

  it('shows every row to a member who holds every permission', () => {
    const items = settingsNavItems({
      locale: 'ar',
      permissionKeys: WORKSPACE_ADMIN,
      selected: 'settings',
    });
    expect(items.map((item) => item.href)).toEqual([
      '/ar/settings',
      '/ar/settings/brand',
      '/ar/settings/security',
      '/ar/members',
      '/ar/permissions',
      '/ar/plan',
      '/ar/billing',
    ]);
  });

  /*
   * PERMISSIONS IS THE ONE ROW EVERY MEMBER GETS, because it shows the reader
   * their own effective permissions and the route asks for nothing.
   */
  it('always offers the permissions row, and nothing else, to a plain member', () => {
    const items = settingsNavItems({
      locale: 'en',
      permissionKeys: MEMBER_ONLY,
      selected: 'permissions',
    });
    // SECURITY JOINS PERMISSIONS as a row every member gets: both are about the
    // reader themselves, and neither route asks for anything.
    expect(items.map((item) => item.href)).toEqual(['/en/settings/security', '/en/permissions']);
  });

  /*
   * THE PAGE THE READER IS ON IS ALWAYS IN THE LIST. They have already passed
   * the route's own check to be reading it, and a section nav with no current
   * entry tells them they are nowhere.
   */
  it('keeps the current page in the list even when the table would gate it', () => {
    const items = settingsNavItems({ locale: 'en', permissionKeys: [], selected: 'brand' });
    expect(items.map((item) => item.href)).toContain('/en/settings/brand');
    expect(items.find((item) => item.selected)?.href).toBe('/en/settings/brand');
  });

  it('never marks more than one row current', () => {
    const items = settingsNavItems({
      locale: 'en',
      permissionKeys: WORKSPACE_ADMIN,
      selected: 'members',
    });
    expect(items.filter((item) => item.selected)).toHaveLength(1);
  });
});

/**
 * THE MIRROR CANNOT ROT.
 *
 * The nav's permission column is a copy of what each route demands, and a copy
 * is exactly what drifted the first time. This reads the route's OWN
 * `requireWorkspace` call out of its page and fails if the two disagree — so
 * changing a route's permission without changing the table breaks a test rather
 * than shipping a dead link.
 */
describe('P8: the settings nav permission column matches the routes themselves', () => {
  const PAGE_FOR: Readonly<Record<string, string>> = {
    '/settings': 'apps/dashboard/src/app/[locale]/settings/page.tsx',
    '/settings/brand': 'apps/dashboard/src/app/[locale]/settings/brand/page.tsx',
    '/settings/security': 'apps/dashboard/src/app/[locale]/settings/security/page.tsx',
    '/members': 'apps/dashboard/src/app/[locale]/members/page.tsx',
    '/permissions': 'apps/dashboard/src/app/[locale]/permissions/page.tsx',
    '/plan': 'apps/dashboard/src/app/[locale]/plan/page.tsx',
    '/billing': 'apps/dashboard/src/app/[locale]/billing/page.tsx',
  };

  it.each(SETTINGS_NAV_ROUTES.map((route) => [route.path, route.permission] as const))(
    '%s is gated on what its page requires',
    (routePath, permission) => {
      const file = PAGE_FOR[routePath];
      expect(file, `no page mapped for ${routePath}`).toBeDefined();
      const source = readFileSync(path.join(ROOT, file as string), 'utf8');

      const call = /requireWorkspace\(\s*locale\s*(?:,\s*'([^']+)'\s*)?\)/.exec(source);
      expect(call, `no requireWorkspace call found in ${file}`).not.toBeNull();

      // A missing second argument means "any member", which the table spells `null`.
      expect(call?.[1] ?? null).toBe(permission);
    },
  );

  it('maps every declared route to a real page', () => {
    for (const route of SETTINGS_NAV_ROUTES) {
      expect(Object.keys(PAGE_FOR)).toContain(route.path);
    }
  });
});
