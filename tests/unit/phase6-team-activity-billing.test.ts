import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import {
  activityActionLabel,
  activityResourceLabel,
} from '../../apps/dashboard/src/server/activity-labels';
import {
  ceilingFor,
  featureDisplayName,
  planDisplayName,
} from '../../apps/dashboard/src/server/plan-usage';

/**
 * PHASE 6 · P6-13 — TEAM, ACTIVITY, SETTINGS AND BILLING, AS PURE RULES.
 *
 * The isolation suite (`phase6-team-brand-access.test.ts`) pins brand access
 * against real PostgreSQL. This file pins what the screens SAY:
 *
 *   - every audit action the code can write has a label in both languages —
 *     at least its family's — so the Activity log never prints a machine key;
 *   - usage is shown against the ceiling the entitlement engine resolves,
 *     including "no ceiling stated", and never against a number made up here;
 *   - a plan is named from the catalogue, or shown as its own key — never a
 *     name invented by the page.
 */

const ROOT = path.resolve(__dirname, '../..');

/**
 * A file that vanished between listing and reading is not a failure: the
 * boundary suites plant and delete `__*_probe.ts` files in these trees while
 * this suite scans them (the same race `design-system.test.ts` documents). A
 * missing file cannot contain what these scans look for, so it reads as empty.
 */
function readIfPresent(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function isDirectory(full: string): boolean {
  try {
    return statSync(full).isDirectory();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (isDirectory(full)) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every literal audit action the application code writes. */
function writtenActions(): string[] {
  const files = [
    ...sourceFiles(path.join(ROOT, 'packages')),
    ...sourceFiles(path.join(ROOT, 'apps')),
  ];
  const found = new Set<string>();
  for (const file of files) {
    const source = readIfPresent(file);
    for (const match of source.matchAll(/action: '([a-z_]+(?:\.[a-z_]+)+)'/g)) {
      found.add(match[1] as string);
    }
  }
  return [...found];
}

describe('P6-13 · the Activity log never prints a machine key', () => {
  const actions = writtenActions();

  it('finds the audit actions the code writes (a guard on the scan itself)', () => {
    expect(actions.length).toBeGreaterThan(100);
    expect(actions).toContain('workspace.member.brand_access_changed');
    expect(actions).toContain('content.review_requested');
  });

  it('every written action resolves to an exact or family label, in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      const generic = dictionary['activity.action.other'];
      for (const action of actions) {
        const label = activityActionLabel(action, dictionary);
        expect(label, `${locale}:${action}`).toBeTruthy();
        expect(label, `${locale}:${action} fell through to the generic label`).not.toBe(generic);
        expect(label).not.toBe(action);
      }
    }
  });

  it('a dynamic key (copilot.tool.<x>) gets its family, never itself', () => {
    const dictionary = messages.en as Record<string, string>;
    expect(activityActionLabel('copilot.tool.campaign.create', dictionary)).toBe(
      dictionary['activity.family.copilot'],
    );
    expect(activityActionLabel('unknownfamily.thing', dictionary)).toBe(
      dictionary['activity.action.other'],
    );
  });

  it('a resource type is translated or omitted — never printed raw', () => {
    const dictionary = messages.ar as Record<string, string>;
    expect(activityResourceLabel('membership', dictionary)).toBe(
      dictionary['activity.resource.membership'],
    );
    expect(activityResourceLabel('SomeInternalTable', dictionary)).toBeNull();
    expect(activityResourceLabel(null, dictionary)).toBeNull();
  });

  it('the page and the Home panel render the label, not entry.action', () => {
    const activity = readFileSync(
      path.join(ROOT, 'apps/dashboard/src/app/[locale]/activity/page.tsx'),
      'utf8',
    );
    const overview = readFileSync(
      path.join(ROOT, 'apps/dashboard/src/app/[locale]/overview/page.tsx'),
      'utf8',
    );
    expect(activity).not.toMatch(/>\{entry\.action\}</);
    expect(activity).not.toMatch(/\{key\}\s*<\/option>/);
    expect(overview).not.toMatch(/\{entry\.action\}\s*<\/span>/);
  });
});

describe('P6-13 · usage is shown against the ceiling the engine resolves', () => {
  const decisions = [
    { featureKey: 'limit.brands', enabled: true, limitValue: 3 },
    { featureKey: 'limit.social_accounts', enabled: true, limitValue: null },
    { featureKey: 'limit.storage_gb', enabled: false, limitValue: null },
  ];

  it('a stated ceiling is the ceiling', () => {
    expect(ceilingFor(decisions, 'limit.brands')).toEqual({ kind: 'limited', limit: 3 });
  });

  it('an enabled quota with no value states NO ceiling — not an invented one (D-259)', () => {
    expect(ceilingFor(decisions, 'limit.social_accounts')).toEqual({ kind: 'unstated' });
  });

  it('a disabled quota is a ceiling of zero, as EntitlementService.limit() enforces', () => {
    expect(ceilingFor(decisions, 'limit.storage_gb')).toEqual({ kind: 'limited', limit: 0 });
  });

  it('a feature the engine did not resolve states nothing', () => {
    expect(ceilingFor(decisions, 'limit.scheduled_posts')).toEqual({ kind: 'unstated' });
  });

  it('seats are NOT shown against limit.seats, which nothing enforces yet (D-233)', () => {
    const plan = readFileSync(
      path.join(ROOT, 'apps/dashboard/src/app/[locale]/plan/page.tsx'),
      'utf8',
    );
    expect(plan).not.toMatch(/againstCeiling\([^)]*QUOTA_FEATURES\.seats/);
  });
});

describe('P6-13 · a plan is named by the catalogue, never by the page', () => {
  const plans = [{ key: 'growth', nameEn: 'Growth', nameAr: 'النمو' }];

  it('uses the catalogue name in the reader’s language', () => {
    expect(planDisplayName('growth', plans, 'en')).toBe('Growth');
    expect(planDisplayName('growth', plans, 'ar')).toBe('النمو');
  });

  it('falls back to the key itself, not to an invented name', () => {
    expect(planDisplayName('legacy_2024', plans, 'en')).toBe('legacy_2024');
    expect(planDisplayName(null, plans, 'en')).toBeNull();
  });
});

describe('the Plan screen names a feature from the registry, never by its key', () => {
  const features = [
    { key: 'approvals.workflow', name: { en: 'Team approvals', ar: 'موافقات الفريق' } },
    { key: 'limit.brands' },
  ];

  it('uses the registered name in the reader’s language', () => {
    expect(featureDisplayName('approvals.workflow', features, 'en')).toBe('Team approvals');
    expect(featureDisplayName('approvals.workflow', features, 'ar')).toBe('موافقات الفريق');
  });

  it('falls back to the key when the registry has no name, not to an invented one', () => {
    expect(featureDisplayName('limit.brands', features, 'en')).toBe('limit.brands');
    expect(featureDisplayName('unknown.feature', features, 'ar')).toBe('unknown.feature');
  });
});

describe('P6-13 · every new Team, Settings and Billing string exists in both languages', () => {
  it('has them', () => {
    for (const key of [
      'members.access.title',
      'members.access.all',
      'members.access.selected',
      'members.access.change',
      'members.access.more',
      'settings.connections',
      'settings.data',
      'data.workspaceExport.title',
      'data.workspaceDeletion.body',
      'plan.usageOf',
      'plan.usageUnstated',
      'plan.usageBrands',
      'plan.usageSocialAccounts',
      'billing.actionFailed',
    ]) {
      for (const locale of ['en', 'ar'] as const) {
        const catalogue = messages[locale] as Record<string, string>;
        expect(catalogue[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});
