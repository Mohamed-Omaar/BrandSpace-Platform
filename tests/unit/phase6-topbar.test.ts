import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NOTE_PERMISSION } from '@brandspace/collaboration';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  TOPBAR_CREATE_FLOWS,
  TOPBAR_PERMISSIONS,
  routeOf,
  topbarModel,
  type TopbarCounts,
} from '../../apps/dashboard/src/server/topbar';
import {
  COPILOT_ENTRY_SURFACES,
  copilotSurfaceForPath,
} from '../../apps/dashboard/src/server/copilot-surface';
import { ROUTE_SCOPES } from '../../apps/dashboard/src/server/route-scope';

/**
 * PHASE 6 · P6-16 — THE CUSTOMER TOP BAR LEADS TO REAL DOMAINS.
 *
 * Review · Notes · Notifications · Copilot · Create. Pinned here as rules:
 *
 *   - each action is offered on exactly the permission its destination route
 *     demands — read from the route's own source, not restated;
 *   - every destination is a route that exists;
 *   - the Copilot entry carries the screen the reader is on (P6-12's `?from=`);
 *   - Create offers only flows the member can actually complete;
 *   - dots come from counts, and nothing draws one without a count;
 *   - no preview placeholder, and no unconnected search, survives in the shell.
 */

const ROOT = path.resolve(__dirname, '../..');
const PAGES = path.join(ROOT, 'apps/dashboard/src/app/[locale]');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');

const ALL = [
  'content.read',
  'assets.read',
  'content.create',
  'content.approve',
  'campaigns.manage',
  'assets.upload',
  'copilot.use',
];
const NONE: TopbarCounts = { review: null, notes: null, notifications: null };

describe('P6-16 · what the top bar offers, and to whom', () => {
  it('a member with every capability gets Review, Notes, Notifications, Copilot — in that order', () => {
    const model = topbarModel({
      locale: 'en',
      permissionKeys: ALL,
      requestPath: '/en/overview',
      counts: NONE,
    });
    expect(model.links.map((link) => link.key)).toEqual([
      'review',
      'notes',
      'notifications',
      'copilot',
    ]);
    expect(model.links.map((link) => link.href)).toEqual([
      '/en/approvals',
      '/en/notes',
      '/en/notifications',
      '/en/copilot?from=overview',
    ]);
    expect(model.create.map((item) => item.href)).toEqual([
      '/en/content/compose',
      '/en/campaigns/new',
      '/en/creative',
      '/en/assets?upload=1',
    ]);
  });

  it('a read-only member gets their own notifications and nothing they cannot open', () => {
    const model = topbarModel({
      locale: 'ar',
      permissionKeys: ['workspace.read'],
      requestPath: '/ar/overview',
      counts: NONE,
    });
    expect(model.links.map((link) => link.key)).toEqual(['notifications']);
    expect(model.create).toEqual([]);
  });

  it('Create offers each flow only on the permission that lets a member complete it', () => {
    const only = (keys: readonly string[]) =>
      topbarModel({
        locale: 'en',
        permissionKeys: keys,
        requestPath: null,
        counts: NONE,
      }).create.map((item) => item.key);
    expect(only(['content.read'])).toEqual([]); // opening the composer is not creating
    expect(only(['content.read', 'content.create'])).toEqual(['content']);
    expect(only(['content.create'])).toEqual([]); // the composer would answer 404
    expect(only(['campaigns.manage'])).toEqual(['campaign']);
    expect(only(['assets.upload'])).toEqual(['creative']);
    expect(only(['assets.read', 'assets.upload'])).toEqual(['creative', 'asset']);
  });

  it('marks the destination the reader is already on', () => {
    const model = topbarModel({
      locale: 'en',
      permissionKeys: ALL,
      requestPath: '/en/approvals?brand=x',
      counts: NONE,
    });
    expect(model.links.find((link) => link.current)?.key).toBe('review');
  });

  it('passes real counts through, and the Copilot never carries one', () => {
    const model = topbarModel({
      locale: 'en',
      permissionKeys: ALL,
      requestPath: '/en/overview',
      counts: { review: 2, notes: 0, notifications: 5 },
    });
    const count = (key: string) => model.links.find((link) => link.key === key)?.count;
    expect(count('review')).toBe(2);
    expect(count('notes')).toBe(0);
    expect(count('notifications')).toBe(5);
    expect(count('copilot')).toBeNull();
  });
});

describe('P6-16 · the Copilot entry keeps the reader’s screen as context', () => {
  it.each([
    ['/en/overview', 'overview'],
    ['/ar/analytics?range=90', 'analytics'],
    ['/en/content/compose?item=abc', 'content'],
    ['/en/campaigns/123', 'campaigns'],
    ['/en/brand-brain?brand=b', 'brand_brain'],
    ['/en/members', 'general'],
    ['/en/content-calendar-lookalike', 'general'],
    [null, 'general'],
  ] as const)('%s → %s', (requestPath, surface) => {
    expect(copilotSurfaceForPath(requestPath)).toBe(surface);
    expect(COPILOT_ENTRY_SURFACES).toContain(surface);
  });

  it('routeOf strips the locale and the query', () => {
    expect(routeOf('/en/approvals?x=1')).toBe('/approvals');
    expect(routeOf('/ar')).toBe('/');
  });
});

describe('P6-16 · every destination is a real route, gated as the top bar says', () => {
  /** The permission a page passes to `requireWorkspace`, read from its source. */
  function pageGate(route: string): string | null {
    const file = path.join(PAGES, route, 'page.tsx');
    expect(existsSync(file), `${route} has no page`).toBe(true);
    const source = readFileSync(file, 'utf8');
    const match = source.match(/requireWorkspace\(\s*locale,\s*('([^']+)'|NOTE_PERMISSION)\s*\)/);
    if (!match) return null;
    return match[2] ?? NOTE_PERMISSION;
  }

  it('Review is gated exactly as /approvals is', () => {
    expect(pageGate('approvals')).toBe(TOPBAR_PERMISSIONS.review);
  });

  it('Notes is gated exactly as /notes and the Notes domain are', () => {
    expect(pageGate('notes')).toBe(TOPBAR_PERMISSIONS.notes);
    expect(TOPBAR_PERMISSIONS.notes).toBe(NOTE_PERMISSION);
  });

  it('Copilot is gated exactly as /copilot is', () => {
    expect(pageGate('copilot')).toBe(TOPBAR_PERMISSIONS.copilot);
  });

  it('Notifications asks no permission, like its page', () => {
    expect(pageGate('notifications')).toBeNull();
  });

  it('every Create flow requires its page’s own gate, so it can never open a 404', () => {
    for (const flow of TOPBAR_CREATE_FLOWS) {
      const route = flow.path.split('?')[0]!.slice(1);
      const gate = pageGate(route);
      if (gate !== null) expect(flow.requires, route).toContain(gate);
    }
  });

  it('the asset upload flow opens the library’s own dialog, not a second upload path', () => {
    const page = read('apps/dashboard/src/app/[locale]/assets/page.tsx');
    expect(page).toMatch(/openUpload=\{query\['upload'\] === '1'\}/);
    const view = read('apps/dashboard/src/app/[locale]/assets/asset-library-view.tsx');
    expect(view).toMatch(/useState\(\s*props\.openUpload === true && props\.can\.upload/);
  });

  it('/notes declares its brand scope, like every route', () => {
    expect(ROUTE_SCOPES['/notes']).toBe('brand-or-all');
  });
});

describe('P6-16 · no placeholder survives', () => {
  const shell = read('apps/dashboard/src/components/workspace-shell.tsx');

  it('the customer shell no longer renders the preview action set or a search control', () => {
    expect(shell).not.toMatch(/<TopbarActions\b/);
    expect(shell).not.toMatch(/previewTitle|previewBody|topbar\.search/);
    expect(shell).toMatch(/<TopbarLink\b/);
    expect(shell).toMatch(/<TopbarCreateMenu\b/);
  });

  it('the dictionary has no "not connected yet" copy left for the customer app', () => {
    for (const locale of ['en', 'ar'] as const) {
      const catalogue = messages[locale] as Record<string, string>;
      for (const key of ['topbar.search', 'topbar.previewTitle', 'topbar.previewBody']) {
        expect(catalogue[key], `${locale}:${key}`).toBeUndefined();
      }
    }
  });

  it('the dot is drawn from a count, never unconditionally', () => {
    const ui = read('packages/ui/src/topbar-actions.tsx');
    const link = ui.slice(
      ui.indexOf('export function TopbarLink'),
      ui.indexOf('export interface TopbarCreateItem'),
    );
    expect(link).toMatch(
      /const active = indicator !== null && indicator !== undefined && indicator\.count > 0/,
    );
    expect(link).toMatch(/\{active \? \(/);
  });

  it('every top bar string exists in both languages, counts keeping their {count}', () => {
    const model = topbarModel({
      locale: 'en',
      permissionKeys: ALL,
      requestPath: '/en/overview',
      counts: NONE,
    });
    const keys = [
      'topbar.create',
      ...model.links.map((link) => link.labelKey),
      ...model.links.flatMap((link) => (link.countKey ? [link.countKey] : [])),
      ...model.create.map((item) => item.labelKey),
    ];
    for (const locale of ['en', 'ar'] as const) {
      const catalogue = messages[locale] as Record<string, string>;
      for (const key of keys) {
        expect(catalogue[key], `${locale}:${key}`).toBeTruthy();
        if (key.endsWith('Count')) expect(catalogue[key]).toContain('{count}');
      }
    }
  });
});
