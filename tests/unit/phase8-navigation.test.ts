import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_SCOPES, scopeForPath } from '../../apps/dashboard/src/server/route-scope';

/**
 * THE SIDEBAR AND THE ROUTES BEHIND IT — Phase 8 (AC-30.2, D-188).
 *
 * WHY THIS IS A FILE-SYSTEM TEST RATHER THAN A RENDER. What is being checked is
 * not how the rail LOOKS: it is whether every entry on it leads somewhere. That
 * is a question about the repository — does a page exist at this path, is its
 * scope declared — and a rendering test would answer it only for whichever
 * permissions the fixture happened to hold.
 *
 * THE RULE IT ENFORCES (UI-fidelity contract §20): a link that goes nowhere is
 * not navigation. An area appears in the rail only once its screen exists, and
 * the reverse holds too — the eighteen areas D-188 fixed must all be reachable
 * by the time Phase 8 closes.
 */

const SHELL = resolve(
  import.meta.dirname,
  '../../apps/dashboard/src/components/workspace-shell.tsx',
);
const APP_DIR = resolve(import.meta.dirname, '../../apps/dashboard/src/app/[locale]');

/** The `href:` values in the shell's NAV table, in the order they are declared. */
function navHrefs(): readonly string[] {
  const source = readFileSync(SHELL, 'utf8');
  const start = source.indexOf('const NAV:');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n];', start);
  expect(end).toBeGreaterThan(start);
  const table = source.slice(start, end);
  return [...table.matchAll(/href:\s*'([^']+)'/g)].map((match) => match[1] as string);
}

/**
 * THE EIGHTEEN AREAS, and the route each one is reached at.
 *
 * Transcribed from `docs/PRODUCT.md` §5.0 rather than derived from the rail, so
 * the test fails if an area is quietly dropped from the product instead of
 * agreeing with whatever the rail currently says.
 *
 * BRAND PROFILE IS DELIBERATELY ABSENT (D-189): it is reached contextually from
 * the Brand Selector and from Settings, and is not a primary rail module.
 */
const FIXED_INVENTORY: Readonly<Record<string, string>> = {
  'Command Center': '/overview',
  'Brand Brain': '/brand-brain',
  Assets: '/assets',
  'AI Strategy': '/strategy',
  Campaigns: '/campaigns',
  'AI Content Studio': '/content',
  'AI Creative Studio': '/creative',
  Calendar: '/calendar',
  Approvals: '/approvals',
  'Social Accounts': '/integrations',
  Analytics: '/analytics',
  'Marketing Intelligence': '/intelligence',
  Copilot: '/copilot',
  Automations: '/automations',
  Team: '/members',
  Activity: '/activity',
  Settings: '/settings',
  'Billing & Usage': '/plan',
};

describe('every navigation entry leads to a real screen', () => {
  const hrefs = navHrefs();

  it('finds the rail, and it is not empty', () => {
    expect(hrefs.length).toBeGreaterThan(10);
  });

  for (const href of navHrefs()) {
    it(`${href} has a page`, () => {
      const segment = href.replace(/^\//, '');
      expect(existsSync(resolve(APP_DIR, segment, 'page.tsx'))).toBe(true);
    });

    it(`${href} declares its brand scope`, () => {
      // `scopeForPath` falls back to `workspace` for an undeclared route, which
      // is inert rather than wrong — but a RAIL entry is a screen somebody
      // opens, so its answer has to be a decision rather than a default.
      expect(Object.keys(ROUTE_SCOPES)).toContain(href);
      expect(['workspace', 'brand', 'brand-or-all']).toContain(scopeForPath(href));
    });
  }
});

describe('the fixed eighteen-area inventory is reachable', () => {
  const hrefs = new Set(navHrefs());

  for (const [area, href] of Object.entries(FIXED_INVENTORY)) {
    it(`${area} is on the rail at ${href}`, () => {
      expect(hrefs).toContain(href);
    });
  }

  it('is exactly eighteen areas', () => {
    expect(Object.keys(FIXED_INVENTORY)).toHaveLength(18);
  });

  it('does NOT put Brand Profile on the rail (D-189)', () => {
    expect(hrefs).not.toContain('/settings/brand');
  });
});
