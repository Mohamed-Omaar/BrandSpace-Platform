import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { ROUTE_SCOPES } from '../../apps/dashboard/src/server/route-scope';
import { setupBrandFrom } from '../../apps/dashboard/src/server/setup-brand-form';
import {
  GOAL_ITEM_KEY,
  GOAL_KEY_PREFIX,
  SETUP_GOALS,
  CAMPAIGN_OBJECTIVE_GOALS,
  campaignObjectiveFor,
  SETUP_STEPS,
  goalFromTitle,
  goalKnowledge,
  goalLabels,
  nextView,
  recommendedFirstAction,
  setupGoalFrom,
  setupSteps,
  setupView,
  type SetupFacts,
} from '../../apps/dashboard/src/server/setup-wizard-state';

/**
 * PHASE 6 FINAL · D-277 §6 — THE FIRST-RUN SETUP WIZARD.
 *
 * Its central promise is that it stores NO progress of its own: every step is
 * a question asked of the domain's rows. These tests pin the truth condition
 * of each step, the rules that choose which screen shows, the goal vocabulary
 * and where the goal lives, and the decoder the brand step shares with Brand
 * Profile.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');

const EMPTY: SetupFacts = {
  brandId: null,
  sources: { total: 0, processing: 0, failed: 0 },
  pendingCandidates: 0,
  decidedCandidates: 0,
  activeKnowledge: 0,
  activeConnections: 0,
  goal: null,
};
const BRAND = '00000000-0000-4000-8000-000000000001';

const done = (facts: SetupFacts) =>
  Object.fromEntries(setupSteps(facts).map((step) => [step.key, step.complete]));

describe('D-277 §6 · every step is derived from real data', () => {
  it('lists the owner’s flow in order', () => {
    expect(SETUP_STEPS).toEqual(['workspace', 'brand', 'learn', 'review', 'connect', 'goal']);
  });

  it('a new workspace has only its workspace step done', () => {
    expect(done(EMPTY)).toEqual({
      workspace: true,
      brand: false,
      learn: false,
      review: false,
      connect: false,
      goal: false,
    });
  });

  it('a brand completes the brand step, and nothing else by itself', () => {
    expect(done({ ...EMPTY, brandId: BRAND })).toMatchObject({
      brand: true,
      learn: false,
      review: false,
      connect: false,
      goal: false,
    });
  });

  it('review is NOT claimed done when there was nothing to review', () => {
    expect(done({ ...EMPTY, brandId: BRAND }).review).toBe(false);
  });

  it('review waits for reading to finish and for every extraction to be decided', () => {
    const base = { ...EMPTY, brandId: BRAND };
    const reading = { ...base, sources: { total: 1, processing: 1, failed: 0 } };
    expect(done(reading)).toMatchObject({ learn: true, review: false });
    const waiting = {
      ...base,
      sources: { total: 1, processing: 0, failed: 0 },
      pendingCandidates: 3,
    };
    expect(done(waiting).review).toBe(false);
    const decided = { ...waiting, pendingCandidates: 0, decidedCandidates: 3 };
    expect(done(decided).review).toBe(true);
  });

  it('connect needs an ACTIVE connection, goal needs a goal item', () => {
    const facts = {
      ...EMPTY,
      brandId: BRAND,
      activeConnections: 1,
      goal: { itemId: BRAND, objective: 'LEADS' as const },
    };
    expect(done(facts)).toMatchObject({ connect: true, goal: true });
  });

  it('nothing is done for a brand that is not there — a stale count cannot leak through', () => {
    expect(
      done({ ...EMPTY, sources: { total: 4, processing: 0, failed: 0 }, activeConnections: 2 }),
    ).toMatchObject({ learn: false, review: false, connect: false });
  });
});

describe('D-277 §6 · which screen shows', () => {
  const withBrand = setupSteps({ ...EMPTY, brandId: BRAND });

  it('without a brand, always the brand step — every later step is about one', () => {
    expect(setupView('goal', setupSteps(EMPTY))).toBe('brand');
    expect(setupView(undefined, setupSteps(EMPTY))).toBe('brand');
  });

  it('an explicit step wins, so Skip is navigation and not a stored flag', () => {
    expect(setupView('connect', withBrand)).toBe('connect');
    expect(setupView('done', withBrand)).toBe('done');
  });

  it('an unknown step is ignored rather than trusted', () => {
    expect(setupView('workspace', withBrand)).toBe('learn');
    expect(setupView('../../admin', withBrand)).toBe('learn');
    expect(setupView(['goal'], withBrand)).toBe('learn');
  });

  it('with nothing asked, the first incomplete step — and the finish when all are done', () => {
    expect(setupView(undefined, withBrand)).toBe('learn');
    const all = setupSteps({
      ...EMPTY,
      brandId: BRAND,
      sources: { total: 1, processing: 0, failed: 0 },
      activeConnections: 1,
      goal: { itemId: BRAND, objective: null },
    });
    expect(setupView(undefined, all)).toBe('done');
  });

  it('the wizard ends — it never loops back to the start', () => {
    expect(nextView('goal')).toBe('done');
    expect(nextView('done')).toBe('done');
  });
});

describe('D-277 §6 · the recommended first action', () => {
  it('plan with Copilot when the Brand Brain has approved knowledge', () => {
    expect(recommendedFirstAction({ ...EMPTY, brandId: BRAND, activeKnowledge: 4 })).toBe('plan');
  });
  it('create a first post when it has none', () => {
    expect(recommendedFirstAction({ ...EMPTY, brandId: BRAND })).toBe('create');
  });
});

describe('D-277 §6 · the first goal lives in the brand’s strategy memory', () => {
  /*
   * D-303 — two goals (consistency, authority) are goals and not campaign
   * objectives. They are offered, stored as goals, and NEVER mapped onto an
   * objective the customer did not choose.
   */
  it('maps a goal onto a campaign objective only when it IS one', () => {
    const schema = read('packages/database/prisma/schema.prisma');
    const objectives = /enum CampaignObjective \{([^}]*)\}/.exec(schema)?.[1] ?? '';
    for (const goal of CAMPAIGN_OBJECTIVE_GOALS) expect(objectives).toContain(goal);
    for (const goal of SETUP_GOALS) {
      const mapped = campaignObjectiveFor(goal);
      if (mapped) expect(objectives).toContain(mapped);
    }
    expect(campaignObjectiveFor('AUTHORITY')).toBeNull();
    expect(campaignObjectiveFor('CONSISTENCY')).toBeNull();
    expect(campaignObjectiveFor('LEADS')).toBe('LEADS');
  });

  it('only a known goal or "unsure" is accepted', () => {
    expect(setupGoalFrom('LEADS')).toBe('LEADS');
    expect(setupGoalFrom('AUTHORITY')).toBe('AUTHORITY');
    expect(setupGoalFrom('unsure')).toBe('unsure');
    expect(setupGoalFrom('GROWTH')).toBeNull();
    expect(setupGoalFrom(null)).toBeNull();
  });

  it('every goal has a label in both languages, and the knowledge is written in both', () => {
    for (const locale of ['en', 'ar'] as const) {
      const labels = goalLabels(locale);
      for (const goal of SETUP_GOALS) expect(labels[goal]).not.toBe(goal);
    }
    const knowledge = goalKnowledge('AWARENESS');
    expect(knowledge.title.en).toBe(messages.en['setup.goal.AWARENESS']);
    expect(knowledge.title.ar).toBe(messages.ar['setup.goal.AWARENESS']);
    expect(knowledge.body.en).toContain(knowledge.title.en);
    expect(knowledge.body.ar).toContain(knowledge.title.ar);
  });

  it('a stored goal reads back to its objective, and a retitled one to none', () => {
    const labels = goalLabels('en');
    expect(goalFromTitle(labels.TRAFFIC, labels)).toBe('TRAFFIC');
    expect(goalFromTitle('Something I wrote', labels)).toBeNull();
    expect(goalFromTitle(undefined, labels)).toBeNull();
  });

  it('the goal key is a valid knowledge key under the goal prefix', () => {
    expect(GOAL_ITEM_KEY.startsWith(GOAL_KEY_PREFIX)).toBe(true);
    expect(GOAL_ITEM_KEY).toMatch(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
  });

  it('the strategy engine does not count a goal as an unpublished content pillar', () => {
    const strategy = read('packages/intelligence/src/strategy.ts');
    expect(strategy).toMatch(/NOT: \{ itemKey: \{ startsWith: 'goal\.' \} \}/);
    expect(GOAL_KEY_PREFIX).toBe('goal.');
  });

  it('the action writes through the knowledge service, never a wizard-only table', () => {
    const actions = read('apps/dashboard/src/app/[locale]/onboarding/actions.ts');
    // D-335: the write moved into `server/setup-goal.ts`, so the isolation
    // suite runs it against PostgreSQL; the action only calls it.
    expect(actions).toMatch(/saveSetupGoal\(db, knowledge, \{/);
    const save = read('apps/dashboard/src/server/setup-goal.ts');
    expect(save).toMatch(/knowledge\.createItem\(/);
    expect(save).toMatch(/knowledge\.updateItem\(/);
    expect(save).toMatch(/area: 'STRATEGY'/);
    for (const source of [actions, save]) {
      expect(source).not.toMatch(/onboarding(Progress|State)\./);
    }
  });
});

describe('D-277 §6 · the brand step decodes with Brand Profile’s rules', () => {
  const form = (entries: Record<string, string | string[]>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) {
      for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
    }
    return data;
  };
  const valid = {
    name: 'Acme',
    websiteUrl: 'https://acme.example',
    industry: 'Retail',
    defaultLocale: 'EN',
    supportedLocales: ['EN'],
    colorPalette: '',
  };

  it('keeps only what the wizard asks for', () => {
    expect(setupBrandFrom(form(valid))).toEqual({
      name: 'Acme',
      industry: 'Retail',
      websiteUrl: 'https://acme.example',
      defaultLocale: 'EN',
      supportedLocales: ['EN'],
      colorPalette: [],
    });
  });

  it('refuses a script URL as a website, and a non-hex colour', () => {
    expect(() => setupBrandFrom(form({ ...valid, websiteUrl: 'javascript:alert(1)' }))).toThrow();
    expect(() => setupBrandFrom(form({ ...valid, colorPalette: 'purple' }))).toThrow();
  });

  it('the default language is always one of the supported ones', () => {
    // D-335: with exactly one publishing language ticked, that language IS the
    // default — the select no longer adds a language the brand does not use.
    const decoded = setupBrandFrom(
      form({ ...valid, defaultLocale: 'AR', supportedLocales: ['EN'] }),
    );
    expect(decoded.defaultLocale).toBe('EN');
    expect(decoded.supportedLocales).toContain(decoded.defaultLocale);
    const both = setupBrandFrom(
      form({ ...valid, defaultLocale: 'AR', supportedLocales: ['EN', 'AR'] }),
    );
    expect(both.defaultLocale).toBe('AR');
    expect(both.supportedLocales).toEqual(expect.arrayContaining(['AR', 'EN']));
  });

  it('a crafted logo id or description is never passed on', () => {
    const decoded = setupBrandFrom(
      form({ ...valid, primaryLogoAssetId: BRAND, description: 'smuggled' }),
    ) as unknown as Record<string, unknown>;
    expect(decoded['primaryLogoAssetId']).toBeUndefined();
    expect(decoded['description']).toBeUndefined();
  });

  it('a missing required field is still a refusal', () => {
    const { defaultLocale: _omitted, ...rest } = valid;
    expect(() => setupBrandFrom(form(rest))).toThrow();
  });
});

describe('D-277 §6 · wiring', () => {
  it('the wizard is brand-scoped: a single brand resolves, several ask', () => {
    expect(ROUTE_SCOPES['/onboarding']).toBe('brand');
  });

  it('the reused actions return to the wizard only through a closed set', () => {
    const brainActions = read('apps/dashboard/src/app/[locale]/brand-brain/actions.ts');
    expect(brainActions).toMatch(/!== '\/onboarding'\) return \{ path: '\/brand-brain' \}/);
    expect(brainActions).toMatch(/WIZARD_STEPS = new Set\(\['learn', 'review'\]\)/);
    const socialActions = read('apps/dashboard/src/app/[locale]/integrations/actions.ts');
    expect(socialActions).toMatch(
      /requested === '\/onboarding'\) return \{ path: '\/onboarding' \}/,
    );
  });

  it('there is ONE brand-creation path, and it is audited', () => {
    const creation = read('apps/dashboard/src/server/brand-creation.ts');
    expect(creation).toMatch(/action: 'brand\.created'/);
    expect(creation).toMatch(/usage\.consume\(/);
    for (const file of [
      'apps/dashboard/src/app/[locale]/brand-brain/actions.ts',
      'apps/dashboard/src/app/[locale]/onboarding/actions.ts',
    ]) {
      const source = read(file);
      expect(source).toMatch(/createBrandFor\(/);
      expect(source).not.toMatch(/db\.brand\.create\(/);
    }
  });

  it('the page reads progress, it never writes it', () => {
    const page = read('apps/dashboard/src/app/[locale]/onboarding/page.tsx');
    expect(page).not.toMatch(/\.(create|update|upsert|delete)\(/);
  });
});
