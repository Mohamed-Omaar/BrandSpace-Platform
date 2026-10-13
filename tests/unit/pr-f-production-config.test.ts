import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultPayload,
  isConfigDomain,
  parseConfigPayload,
  validateConfiguration,
  type ConfigContext,
  type ConfigDomain,
} from '@brandspace/config';
import {
  industriesAreaState,
  legalAreaState,
  passwordAreaState,
  scannerAreaState,
  senderAreaState,
  trialAreaState,
  type TrialPlanInput,
} from '../../apps/admin/src/server/owner-readiness';

/**
 * PR F — THE PRODUCTION CONFIGURATION DOCUMENTS the owner pastes into the
 * Control Center (`docs/production-config/*.json`).
 *
 * Every file must parse with its real domain schema and pass the real semantic
 * validation, with the other files as the cross-domain context activation
 * would see. The owner-decided values are pinned below, so a later edit that
 * drifts from a decision fails here rather than in production.
 */

const root = path.resolve(__dirname, '../..');
const directory = path.join(root, 'docs/production-config');

/** File name → configuration domain. */
const DOMAIN_BY_FILE: Readonly<Record<string, ConfigDomain>> = {
  'assets.json': 'assets',
  'commerce.json': 'commerce',
  'content.json': 'content',
  'credits.json': 'credits',
  'entitlements.json': 'entitlements',
  'feature-flags.json': 'feature-flags',
  'integrations-email.json': 'integrations.email',
  'onboarding.json': 'onboarding',
  'plans.json': 'plans',
  'publishing.json': 'publishing',
};

const files = readdirSync(directory)
  .filter((name) => name.endsWith('.json'))
  .sort();

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON read for assertions; each document is parsed by its schema below.
type Json = any;

function read(file: string): Json {
  return JSON.parse(readFileSync(path.join(directory, file), 'utf8')) as Json;
}

/**
 * What activation would see: every other production document, plus the
 * `operations` defaults so the plan price table is checked against the
 * supported currencies (SAR and USD, D-08).
 */
const context: ConfigContext = {
  operations: defaultPayload('operations'),
  ...Object.fromEntries(files.map((file) => [DOMAIN_BY_FILE[file], read(file)])),
};

describe('docs/production-config', () => {
  it('maps every file to a configuration domain', () => {
    expect(files.length).toBe(Object.keys(DOMAIN_BY_FILE).length);
    for (const file of files) {
      const domain = DOMAIN_BY_FILE[file];
      expect(domain, file).toBeDefined();
      expect(isConfigDomain(domain as string)).toBe(true);
    }
  });

  for (const file of files) {
    it(`${file} parses and validates with no error`, () => {
      const domain = DOMAIN_BY_FILE[file] as ConfigDomain;
      const payload = read(file);
      expect(() => parseConfigPayload(domain, payload)).not.toThrow();
      const report = validateConfiguration(domain, payload, context);
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(report.valid).toBe(true);
    });
  }
});

describe('the values the owner confirmed on the #79 review', () => {
  it('500 monthly credits and one workspace on the trial plan', () => {
    const starter = parseConfigPayload('plans', read('plans.json')).plans[0]!;
    expect(starter.monthlyCredits).toBe(500);
    expect(starter.quotas.workspaces).toBe(1);
  });

  it('the twelve industries', () => {
    expect(parseConfigPayload('onboarding', read('onboarding.json')).industries).toHaveLength(12);
  });

  it('the hashtag ranges, and 10:00 / 16:00 / 21:00 for EG, SA and AE', () => {
    const content = parseConfigPayload('content', read('content.json'));
    const ranges = Object.fromEntries(
      content.platforms.map((platform) => [platform.key, platform.recommendedHashtags ?? null]),
    );
    expect(ranges).toEqual({
      instagram: { min: 3, max: 5 },
      tiktok: { min: 3, max: 5 },
      linkedin: { min: 1, max: 3 },
      x: { min: 1, max: 2 },
    });
    const times = Object.fromEntries(
      (content.calendar.suggestedTimes ?? []).map((entry) => [entry.country, entry.times]),
    );
    for (const country of ['EG', 'SA', 'AE']) {
      expect(times[country], country).toEqual(['10:00', '16:00', '21:00']);
    }
  });
});

describe('the values the owner decided on the #81 review', () => {
  it('safe zones on Instagram and TikTok: the prototype’s bands, as design guidance', () => {
    // Main.dc.html lines 462 and 489 draw top 13 %, bottom 22 %, inline-end 16 %
    // on both 9:16 previews. Design guidance, not a platform-published value.
    const content = parseConfigPayload('content', read('content.json'));
    const zones = Object.fromEntries(
      content.platforms.map((platform) => [platform.key, platform.safeZones ?? null]),
    );
    expect(zones).toEqual({
      instagram: { top: 13, bottom: 22, end: 16 },
      tiktok: { top: 13, bottom: 22, end: 16 },
      linkedin: null,
      x: null,
    });
  });
});

describe('the owner-decided values', () => {
  it('onboarding: password floor, legal drafts, twelve industries, no Teach step', () => {
    const onboarding = parseConfigPayload('onboarding', read('onboarding.json'));
    expect(onboarding.signup.open).toBe(true);
    expect(onboarding.signup.minPasswordLength).toBe(12);

    expect(onboarding.legalDocuments.map((d) => d.key)).toEqual([
      'terms-of-service',
      'privacy-policy',
    ]);
    for (const document of onboarding.legalDocuments) {
      expect(document.version).toBe('2026-10 beta draft');
      expect(document.required).toBe(true);
      expect(document.reviewed).toBe(false);
    }

    expect(onboarding.industries).toHaveLength(12);
    expect(new Set(onboarding.industries.map((i) => i.key)).size).toBe(12);
    for (const industry of onboarding.industries) {
      expect(industry.name.en.trim()).not.toBe('');
      expect(industry.name.ar.trim()).not.toBe('');
    }
    // Only the Offers question sets Brand Brain actually ships.
    const sets = Object.keys(defaultPayload('brand-brain').questions.offersSets);
    for (const industry of onboarding.industries) {
      expect(sets).toContain(industry.offersQuestionSet);
    }

    expect(onboarding.steps.map((s) => s.key)).not.toContain('brand_brain');
  });

  it('integrations.email: Resend, sending as Brandspace from noreply@brandspace.cc', () => {
    const email = parseConfigPayload('integrations.email', read('integrations-email.json'));
    expect(email.activeProviderKey).toBe('resend');
    const resend = email.providers.find((p) => p.key === 'resend');
    expect(resend?.status).toBe('active');
    expect(resend?.settings['fromEmail']).toBe('noreply@brandspace.cc');
    expect(resend?.settings['fromName']).toBe('Brandspace');
    // A reference, never a value: the one the Integrations Hub writes.
    expect(resend?.secretRefs['apiKey']).toBe('integration/email/resend/production/apiKey');
  });

  it('publishing: every channel switched off', () => {
    const publishing = parseConfigPayload('publishing', read('publishing.json'));
    for (const provider of Object.values(publishing.providers)) {
      expect(provider.enabled).toBe(false);
    }
  });

  it('plans: one active public trial plan, one brand, no unlimited quota', () => {
    const plans = parseConfigPayload('plans', read('plans.json')).plans;
    expect(plans).toHaveLength(1);
    const starter = plans[0]!;
    expect(starter.key).toBe('starter');
    expect(starter.status).toBe('active');
    expect(starter.visibility).toBe('public');
    expect(starter.trialDays).toBe(90);
    expect(starter.trialRequiresCard).toBe(false);
    expect(starter.trialCredits).toBe(200);
    expect(starter.quotas.brands).toBe(1);
    const counted = [
      'seats',
      'brands',
      'socialAccounts',
      'scheduledPostsPerMonth',
      'storageGb',
      'analyticsRetentionDays',
      'workspaces',
    ] as const;
    for (const quota of counted) expect(starter.quotas[quota], quota).not.toBeNull();
    // AI is off: neither automation cap is set.
    expect(starter.quotas.automationAiActionsPerMonth).toBeUndefined();
    expect(starter.quotas.trialAutomationAiActionsPerMonth).toBeUndefined();
  });

  it('commerce: payments off, USD and SAR', () => {
    const commerce = parseConfigPayload('commerce', read('commerce.json'));
    expect(commerce.payments.enabled).toBe(false);
    expect(commerce.currencies.map((c) => c.code).sort()).toEqual(['SAR', 'USD']);
    expect(commerce.creditPacks).toEqual([]);
  });

  it('credits: the D-11 hard stop and the D-12 expiry windows', () => {
    const credits = parseConfigPayload('credits', read('credits.json'));
    expect(credits.hardStopAtZero).toBe(true);
    expect(credits.purchasedPackExpiryMonths).toBe(12);
    expect(credits.promotionalExpiryMonths).toBe(3);
    expect(credits.lowBalanceThresholdPercents).toEqual([20, 5]);
  });

  it('assets: scanning off, said twice (Q13)', () => {
    const assets = parseConfigPayload('assets', read('assets.json'));
    expect(assets.scanning.provider).toBe('none');
    expect(assets.scanning.required).toBe(false);
  });

  it('entitlements and feature flags do not grant multi-brand to the trial plan', () => {
    const entitlements = parseConfigPayload('entitlements', read('entitlements.json'));
    const flags = parseConfigPayload('feature-flags', read('feature-flags.json'));
    expect(
      entitlements.planEntitlements.some(
        (e) => e.featureKey === 'feature.multi_brand' && e.enabled,
      ),
    ).toBe(false);
    expect(flags.flags.some((f) => f.featureKey === 'feature.multi_brand')).toBe(false);
  });

  it('the Control Center readiness rows read these documents as the beta expects', () => {
    const onboarding = parseConfigPayload('onboarding', read('onboarding.json'));
    const plans = parseConfigPayload('plans', read('plans.json')).plans;
    const assets = parseConfigPayload('assets', read('assets.json'));
    const email = parseConfigPayload('integrations.email', read('integrations-email.json'));

    expect(trialAreaState(plans as unknown as TrialPlanInput[], 'USD').state).toBe('ready');
    expect(legalAreaState(onboarding.legalDocuments).state).toBe('beta_only');
    expect(passwordAreaState(onboarding.signup.minPasswordLength).state).toBe('ready');
    expect(industriesAreaState(onboarding.industries.length).state).toBe('ready');
    expect(
      scannerAreaState({
        provider: assets.scanning.provider,
        scaniiEndpoint: assets.scanning.scanii.endpoint,
        production: true,
      }).state,
    ).toBe('beta_only');
    const fromName = email.providers.find((p) => p.key === 'resend')?.settings['fromName'];
    expect(senderAreaState(typeof fromName === 'string' ? fromName : null).state).toBe('ready');
  });
});
