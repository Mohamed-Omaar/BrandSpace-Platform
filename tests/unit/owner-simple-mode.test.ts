import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { IntegrationView } from '@brandspace/integrations';
import type { PlanDetail } from '@brandspace/entitlements';
import { CONTROL_CENTER_DEFAULT_LOCALE, DEFAULT_LOCALE } from '@brandspace/ui';
import * as ui from '@brandspace/ui';
import {
  CONSOLE_MODE_COOKIE,
  DEFAULT_CONSOLE_MODE,
  parseConsoleMode,
  safeConsoleReturnPath,
} from '../../apps/admin/src/server/console-mode';
import {
  ADVANCED_ONLY_PATHS,
  ADVANCED_SECTIONS,
  SIMPLE_SECTIONS,
  consoleNavigation,
} from '../../apps/admin/src/components/console-nav';
import {
  integrationAreaState,
  isSellable,
  plansAreaState,
  readinessVerdict,
  type ReadinessArea,
} from '../../apps/admin/src/server/owner-readiness';
import {
  formatMinor,
  majorToMinor,
  minorDigits,
  minorToMajorInput,
} from '../../apps/admin/src/server/money';
import { describePlanChanges } from '../../apps/admin/src/server/plan-diff';
import {
  featureAccess,
  hasAdvancedTargeting,
  simpleEditable,
  withGlobal,
  withPlanGrants,
  type FlagShape,
  type GrantShape,
} from '../../apps/admin/src/server/feature-access';
import { fill, simpleCopy } from '../../apps/admin/src/i18n/simple';

/**
 * SIMPLE AND ADVANCED MODE — the logic and the guarantees (D-307 … D-314).
 *
 * The behaviour is proven end to end in `owner-simple-mode.spec.ts`. This
 * suite pins what a browser test cannot see: that the mode is never an
 * authorization input, that the mode switch cannot be turned into an open
 * redirect, and that every derived answer an owner reads (readiness, prices,
 * plan changes, who gets a feature) is decided correctly.
 */

const ROOT = path.resolve(__dirname, '../..');
const ADMIN = path.join(ROOT, 'apps/admin/src');
const read = (file: string) => readFileSync(file, 'utf8');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('D-307 · the mode is a presentation preference, never an access control', () => {
  it('defaults to Simple, and anything but exactly "advanced" is Simple', () => {
    expect(DEFAULT_CONSOLE_MODE).toBe('simple');
    expect(parseConsoleMode(undefined)).toBe('simple');
    expect(parseConsoleMode('')).toBe('simple');
    expect(parseConsoleMode('ADVANCED')).toBe('simple');
    expect(parseConsoleMode('advanced; admin=true')).toBe('simple');
    expect(parseConsoleMode('advanced')).toBe('advanced');
    expect(CONSOLE_MODE_COOKIE.startsWith('__Host-')).toBe(true);
  });

  it('no authorization code reads the mode', () => {
    for (const file of ['server/platform-context.ts', 'server/config-draft.ts', 'middleware.ts']) {
      expect(read(path.join(ADMIN, file)), file).not.toMatch(/console-mode|getConsoleMode/);
    }
    // Only the mode switch writes the cookie; no other action reads it.
    const actions = sources(path.join(ADMIN, 'app')).filter((file) => file.endsWith('actions.ts'));
    for (const file of actions) {
      if (file.endsWith(path.join('console', 'mode', 'actions.ts'))) continue;
      expect(read(file), file).not.toMatch(/CONSOLE_MODE_COOKIE|getConsoleMode/);
    }
  });

  it('every page that branches on the mode has already passed its permission guard', () => {
    const pages = sources(path.join(ADMIN, 'app')).filter((file) =>
      read(file).includes('getConsoleMode()'),
    );
    expect(pages.length).toBeGreaterThanOrEqual(8);
    for (const file of pages) {
      const source = read(file);
      if (file.endsWith('layout.tsx')) {
        // The layout resolves the actor (and redirects without one) first.
        expect(source.indexOf('getPlatformActor()'), file).toBeLessThan(
          source.indexOf('getConsoleMode()'),
        );
        continue;
      }
      const guard = source.indexOf('requirePageActor(');
      expect(guard, file).toBeGreaterThan(-1);
      expect(guard, file).toBeLessThan(source.indexOf('getConsoleMode()'));
    }
  });
});

describe('the mode switch cannot be an open redirect', () => {
  it.each([
    ['/en/console/integrations', '/en/console/integrations'],
    ['/en/console', '/en/console'],
    ['/en/console/workspaces/1b2c-3d?ok=1', '/en/console/workspaces/1b2c-3d'],
    ['https://evil.example/en/console', '/en/console'],
    ['//evil.example/en/console', '/en/console'],
    ['/en/console/../../login', '/en/console'],
    ['/en/console/%2e%2e/%2e%2e/x', '/en/console'],
    ['/en/console\\evil', '/en/console'],
    ['/ar/console/plans', '/en/console'],
    ['/en/consolex', '/en/console'],
    ['', '/en/console'],
  ])('%s → %s', (candidate, expected) => {
    expect(safeConsoleReturnPath('en', candidate)).toBe(expected);
  });
});

describe('D-308 · two navigations', () => {
  const hrefs = (sections: typeof SIMPLE_SECTIONS, visibleOnly = true) =>
    sections.flatMap((section) =>
      section.items.filter((item) => !visibleOnly || !item.hidden).map((item) => item.href),
    );

  it('Simple lists the owner destinations, in the contract order', () => {
    expect(hrefs(SIMPLE_SECTIONS)).toEqual([
      '',
      '/workspaces',
      '/plans',
      '/features',
      '/ai',
      '/integrations',
      '/usage',
      '/health',
    ]);
    expect(
      SIMPLE_SECTIONS.flatMap((s) => s.items)
        .filter((i) => !i.hidden)
        .map((i) => i.label('en')),
    ).toEqual([
      'Home',
      'Customers',
      'Plans & Pricing',
      'Features',
      'AI',
      'Integrations',
      'Usage & Billing',
      'System',
    ]);
  });

  it('Advanced keeps every existing technical screen, test hook and permission', () => {
    const items = ADVANCED_SECTIONS.flatMap((s) => s.items);
    expect(items.map((i) => [i.href, i.testId, i.permission])).toEqual([
      ['', 'nav-nav.overview', 'platform.workspace.read'],
      ['/workspaces', 'nav-nav.workspaces', 'platform.workspace.read'],
      ['/support', 'nav-nav.support', 'platform.support_mode.enter'],
      ['/configuration', 'nav-nav.configuration', 'platform.configuration.read'],
      ['/secrets', 'nav-nav.secrets', 'platform.secret.read'],
      ['/flags', 'nav-nav.flags', 'platform.configuration.read'],
      ['/plans', 'nav-nav.plans', 'platform.configuration.read'],
      ['/features', 'nav-nav.features', 'platform.configuration.read'],
      ['/integrations', 'nav-nav.integrations', 'platform.configuration.read'],
      ['/providers', 'nav-nav.providers', 'platform.configuration.read'],
      ['/ai-models', 'nav-nav.aiRegistry', 'platform.configuration.read'],
      ['/routing', 'nav-nav.routing', 'platform.configuration.read'],
      ['/audit', 'nav-nav.audit', 'platform.audit.read'],
      ['/ai-usage', 'nav-nav.aiUsage', 'platform.ai.usage.read'],
      ['/health', 'nav-nav.health', 'platform.workspace.read'],
    ]);
  });

  it('each mode carries the other one’s routes hidden, so every screen keeps its title', () => {
    for (const mode of ['simple', 'advanced'] as const) {
      const all = consoleNavigation(mode).flatMap((s) => s.items);
      for (const href of [...hrefs(SIMPLE_SECTIONS, false), ...hrefs(ADVANCED_SECTIONS, false)]) {
        expect(
          all.some((item) => item.href === href),
          `${mode} ${href}`,
        ).toBe(true);
      }
    }
    expect(ADVANCED_ONLY_PATHS).toEqual([
      '/support',
      '/configuration',
      '/secrets',
      '/flags',
      '/providers',
      '/ai-models',
      '/routing',
      '/audit',
      '/ai-usage',
    ]);
  });

  it('the same screen is gated by the same permission in both modes', () => {
    const simple = SIMPLE_SECTIONS.flatMap((s) => s.items);
    const advanced = ADVANCED_SECTIONS.flatMap((s) => s.items);
    for (const item of simple) {
      const twin = advanced.find((candidate) => candidate.href === item.href);
      if (twin) expect(item.permission, item.href).toBe(twin.permission);
    }
  });
});

describe('D-309 · no placeholder top-bar controls', () => {
  it('the preview action set is gone from the product', () => {
    expect('TopbarActions' in ui).toBe(false);
    const shell = read(path.join(ADMIN, 'components/admin-shell.tsx'));
    expect(shell).not.toMatch(/TopbarActions|topbar\.search|previewBody/);
    expect(shell).toMatch(/<ModeSwitch\b/);
  });
});

describe('D-310 · the Control Center opens in English', () => {
  it('has its own default, and the website keeps Arabic', () => {
    expect(CONTROL_CENTER_DEFAULT_LOCALE).toBe('en');
    expect(DEFAULT_LOCALE).toBe('ar');
    expect(read(path.join(ADMIN, 'middleware.ts'))).toMatch(
      /\/\$\{CONTROL_CENTER_DEFAULT_LOCALE\}/,
    );
  });
});

function view(overrides: Partial<IntegrationView>): IntegrationView {
  return {
    category: 'email',
    providerKey: 'resend',
    displayNameEn: 'Resend',
    displayNameAr: 'Resend',
    environment: 'DEVELOPMENT',
    supportedEnvironments: ['DEVELOPMENT', 'STAGING', 'PRODUCTION'],
    capabilities: {},
    adapterAvailable: true,
    testable: true,
    developmentOnly: false,
    noteEn: '',
    noteAr: '',
    enabled: true,
    settings: {},
    credentials: [],
    configurationComplete: true,
    selectionRefusal: null,
    connection: 'ok',
    lastSuccessAt: null,
    lastFailureAt: null,
    lastCheckedAt: null,
    lastMessage: null,
    lastLatencyMs: null,
    ...overrides,
  } as IntegrationView;
}

describe('D-311 · readiness is derived, and never claims more than it knows', () => {
  it('"Connected" only after a real check passed', () => {
    expect(integrationAreaState([view({})]).state).toBe('ready');
    expect(integrationAreaState([view({ connection: 'never_tested' })])).toMatchObject({
      state: 'needs_attention',
      reason: 'untested',
    });
    expect(integrationAreaState([view({ connection: 'failed' })]).reason).toBe('failed');
  });

  it('refusal and missing settings come before the connection', () => {
    expect(integrationAreaState([view({ selectionRefusal: 'dev double' })]).reason).toBe('refused');
    expect(integrationAreaState([view({ configurationComplete: false })]).reason).toBe(
      'incomplete',
    );
  });

  it('a development stand-in is never ready for customers, however well it works', () => {
    expect(integrationAreaState([view({ developmentOnly: true })]).state).toBe('test_double');
  });

  it('nothing on is setup required; something set up and off is disabled', () => {
    expect(integrationAreaState([view({ enabled: false })]).state).toBe('setup_required');
    expect(
      integrationAreaState([view({ enabled: false, settings: { fromEmail: 'a@b.test' } })]).state,
    ).toBe('disabled');
  });

  it('a real provider speaks for the category ahead of a stand-in', () => {
    const state = integrationAreaState([
      view({ providerKey: 'outbox', developmentOnly: true }),
      view({ providerKey: 'resend' }),
    ]);
    expect(state.provider?.en).toBe('Resend');
    expect(state.state).toBe('ready');
  });

  it('a plan is sellable only when active, public and priced', () => {
    expect(isSellable({ status: 'active', visibility: 'public', prices: [{}] })).toBe(true);
    expect(isSellable({ status: 'active', visibility: 'private', prices: [{}] })).toBe(false);
    expect(isSellable({ status: 'draft', visibility: 'public', prices: [{}] })).toBe(false);
    expect(isSellable({ status: 'active', visibility: 'public', prices: [] })).toBe(false);
    expect(plansAreaState([]).state).toBe('setup_required');
  });

  it('the verdict needs every required area ready, and never guesses a withheld one', () => {
    const area = (
      key: ReadinessArea['key'],
      state: ReadinessArea['state'],
      required = true,
    ): ReadinessArea => ({
      key,
      state,
      required,
      reason: 'ok',
      provider: null,
      href: '/',
    });
    expect(
      readinessVerdict([area('email', 'ready'), area('social', 'setup_required', false)]),
    ).toEqual({
      status: 'ready',
      remaining: 0,
    });
    expect(readinessVerdict([area('email', 'test_double'), area('ai', 'ready')]).status).toBe(
      'not_ready',
    );
    expect(readinessVerdict([area('email', 'ready'), area('ai', 'withheld')]).status).toBe(
      'unknown',
    );
  });
});

describe('D-313 · prices in major units, per currency, refused rather than rounded', () => {
  it('uses each currency’s own minor digits', () => {
    expect(minorDigits('USD')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(minorDigits('KWD')).toBe(3);
    expect(majorToMinor('29', 'USD')).toBe(2900);
    expect(majorToMinor('29.5', 'USD')).toBe(2950);
    expect(majorToMinor('7.9', 'KWD')).toBe(7900);
    expect(majorToMinor('500', 'JPY')).toBe(500);
    expect(majorToMinor('', 'USD')).toBe(0);
  });

  it.each(['29.999', '-1', '1,000', '29.5.1', 'abc', '1e3'])('refuses %s', (raw) => {
    expect(() => majorToMinor(raw, 'USD')).toThrow();
  });

  it('round-trips for display', () => {
    expect(minorToMajorInput(2950, 'USD')).toBe('29.50');
    expect(minorToMajorInput(7900, 'KWD')).toBe('7.900');
    expect(minorToMajorInput(500, 'JPY')).toBe('500');
    expect(formatMinor(2950, 'USD', 'en')).toBe('$29.50');
    expect(formatMinor(2950, 'USD', 'ar')).toMatch(/29\.50/);
  });

  it('the Advanced form keeps minor units: conversion is opt-in', () => {
    const actions = read(path.join(ADMIN, 'app/[locale]/console/plans/actions.ts'));
    expect(actions).toMatch(/formData\.get\('priceUnit'\) === 'major'/);
  });
});

const plan = (overrides: Partial<PlanDetail>): PlanDetail =>
  ({
    key: 'growth',
    nameEn: 'Growth',
    nameAr: 'النمو',
    status: 'active',
    visibility: 'public',
    prices: [{ currency: 'USD', monthlyMinor: 2600, annualMinor: 26000 }],
    trialDays: 14,
    trialCredits: 0,
    monthlyCredits: 500,
    quotas: {
      seats: 3,
      brands: 1,
      socialAccounts: null,
      scheduledPostsPerMonth: null,
      storageGb: null,
      analyticsRetentionDays: null,
    },
    ...overrides,
  }) as PlanDetail;

describe('D-313 · a plans change in words', () => {
  it('names each changed field with before and after', () => {
    const changes = describePlanChanges(
      [plan({})],
      [
        plan({
          monthlyCredits: 300,
          prices: [{ currency: 'USD', monthlyMinor: 2900, annualMinor: 26000 }],
          quotas: { ...plan({}).quotas, brands: null },
        }),
      ],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changes).toEqual([
      { field: 'price', detail: { currency: 'USD', period: 'monthly' }, before: 2600, after: 2900 },
      { field: 'monthlyCredits', before: 500, after: 300 },
      { field: 'brands', before: 1, after: null },
    ]);
  });

  it('reports added and removed plans, and nothing for an unchanged one', () => {
    expect(describePlanChanges([plan({})], [plan({})])).toEqual([]);
    expect(describePlanChanges([], [plan({})])[0]?.kind).toBe('added');
    expect(describePlanChanges([plan({})], [])[0]?.kind).toBe('removed');
  });
});

const flag = (overrides: Partial<FlagShape>): FlagShape => ({
  featureKey: 'social.scheduling',
  killSwitch: false,
  globalEnabled: null,
  enabledForPlans: [],
  enabledForWorkspaces: [],
  disabledForWorkspaces: [],
  betaGroups: [],
  countries: [],
  activeFrom: null,
  activeUntil: null,
  percentageRollout: null,
  ...overrides,
});
const grant = (planKey: string, enabled: boolean): GrantShape => ({
  planKey,
  featureKey: 'social.scheduling',
  enabled,
  limitValue: null,
  limitPeriod: null,
  enumValue: null,
});

describe('D-314 · who gets a feature, as the engine decides it', () => {
  const plans = ['starter', 'growth'];
  const base = {
    valueType: 'boolean',
    defaultValue: false,
    grants: [] as GrantShape[],
    planKeys: plans,
  };

  it('reads the global setting, then the plan grants and the default', () => {
    expect(featureAccess({ ...base, flag: flag({ globalEnabled: true }) }).kind).toBe('everyone');
    expect(featureAccess({ ...base, flag: flag({ globalEnabled: false }) }).kind).toBe('nobody');
    expect(featureAccess({ ...base, flag: null, grants: [grant('growth', true)] })).toEqual({
      kind: 'plans',
      plans: ['growth'],
    });
    // A plan with no grant row falls through to the default.
    expect(
      featureAccess({ ...base, defaultValue: true, flag: null, grants: [grant('growth', false)] }),
    ).toEqual({
      kind: 'plans',
      plans: ['starter'],
    });
  });

  it('leaves kill switches, custom targeting and quota features to Advanced', () => {
    expect(featureAccess({ ...base, flag: flag({ killSwitch: true }) }).kind).toBe('kill_switch');
    for (const custom of [
      { countries: ['AE'] },
      { percentageRollout: 10 },
      { betaGroups: ['beta'] },
      { enabledForPlans: ['growth'] },
      { enabledForWorkspaces: ['00000000-0000-0000-0000-000000000001'] },
      { activeFrom: '2026-01-01T00:00:00.000Z' },
    ]) {
      expect(hasAdvancedTargeting(flag(custom))).toBe(true);
      expect(simpleEditable(featureAccess({ ...base, flag: flag(custom) }))).toBe(false);
    }
    expect(featureAccess({ ...base, valueType: 'quota', flag: null }).kind).toBe('not_boolean');
  });

  it('changes only the global setting, adding a full rule when there is none', () => {
    const doc = { flags: [flag({ countries: [] })] };
    expect(withGlobal(doc, 'social.scheduling', true).flags[0]?.globalEnabled).toBe(true);
    const added = withGlobal({ flags: [] as FlagShape[] }, 'new.feature', false).flags[0];
    expect(added).toEqual(flag({ featureKey: 'new.feature', globalEnabled: false }));
    expect(withGlobal({ flags: [] as FlagShape[] }, 'new.feature', null).flags).toEqual([]);
  });

  it('grants exactly the selected plans, keeping limits and adding rows only where they differ from the default', () => {
    const doc = { planEntitlements: [{ ...grant('starter', true), limitValue: 5 }] };
    const next = withPlanGrants(
      doc,
      'social.scheduling',
      plans,
      ['growth'],
      false,
    ).planEntitlements;
    expect(next).toEqual([{ ...grant('starter', false), limitValue: 5 }, grant('growth', true)]);
    const off = withPlanGrants(
      { planEntitlements: [] as GrantShape[] },
      'social.scheduling',
      plans,
      [],
      true,
    );
    expect(off.planEntitlements).toEqual([grant('starter', false), grant('growth', false)]);
    const same = withPlanGrants(
      { planEntitlements: [] as GrantShape[] },
      'social.scheduling',
      plans,
      [],
      false,
    );
    expect(same.planEntitlements).toEqual([]);
  });
});

describe('Simple copy', () => {
  it('has every string in both languages, none empty, placeholders kept', () => {
    const en = simpleCopy('en');
    const ar = simpleCopy('ar');
    const source = read(path.join(ADMIN, 'i18n/simple.ts'));
    const keys = [...source.matchAll(/^ {2}'([a-zA-Z0-9_.-]+)':/gm)].map((m) => m[1] as string);
    const unique = [...new Set(keys)];
    expect(unique.length).toBeGreaterThan(300);
    for (const key of unique) {
      const e = en(key as never);
      const a = ar(key as never);
      expect(e, key).toBeTruthy();
      expect(a, key).toBeTruthy();
      const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(names(a), key).toEqual(names(e));
    }
    expect(fill('{a} of {b}', { a: 1, b: 2 })).toBe('1 of 2');
  });

  it('does not lead with internal vocabulary', () => {
    // The English VALUES — the header comment names these terms on purpose.
    const source = read(path.join(ADMIN, 'i18n/simple.ts'));
    const en = source.slice(source.indexOf('const en = {'), source.indexOf('const ar'));
    for (const term of [
      'workspaceId',
      'featureKey',
      'config domain',
      'entitlement trace',
      'secret key',
      'provider registry',
    ]) {
      expect(en, term).not.toContain(term);
    }
  });
});
