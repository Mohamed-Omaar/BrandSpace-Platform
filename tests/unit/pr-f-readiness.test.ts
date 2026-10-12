import { describe, expect, it } from 'vitest';
import {
  areaHref,
  industriesAreaState,
  legalAreaState,
  passwordAreaState,
  paymentsOffArea,
  postKindsAreaState,
  readinessVerdict,
  scannerAreaState,
  senderAreaState,
  trialAreaState,
  withCustomerEffect,
  type ReadinessArea,
  type TrialPlanInput,
} from '../../apps/admin/src/server/owner-readiness';
import { fill, simpleCopy, type SimpleKey } from '../../apps/admin/src/i18n/simple';

/** The card's own sentence: the reason's copy, filled from the area's detail. */
function reasonText(
  locale: string,
  area: Pick<ReadinessArea, 'reason' | 'key'> & { detail?: Readonly<Record<string, string>> },
): string {
  return fill(simpleCopy(locale)(`reason.${area.reason}` as SimpleKey), area.detail ?? {});
}

/**
 * PR F (e) — the closed beta's readiness rows: what is real, what is a
 * stand-in, what is off on purpose, and what is fine for the closed beta only.
 */

const SET = {
  seats: 3,
  brands: 1,
  workspaces: 1,
  socialAccounts: 5,
  scheduledPostsPerMonth: 60,
  storageGb: 5,
  analyticsRetentionDays: 90,
};

const trialPlan = (overrides: Partial<TrialPlanInput> = {}): TrialPlanInput => ({
  key: 'starter',
  status: 'active',
  tier: 1,
  trialDays: 90,
  trialCredits: 500,
  prices: [{ currency: 'USD' }],
  quotas: SET,
  ...overrides,
});

describe('AI, social and payments say what they mean for a customer', () => {
  it('unconfigured AI and social read as hidden controls, not as a fault', () => {
    expect(
      withCustomerEffect('ai', { state: 'setup_required', reason: 'none_active', provider: null })
        .reason,
    ).toBe('ai_hidden');
    expect(
      withCustomerEffect('social', { state: 'disabled', reason: 'switched_off', provider: null })
        .reason,
    ).toBe('social_hidden');
    // A configured one keeps its own reason.
    expect(withCustomerEffect('ai', { state: 'ready', reason: 'ok', provider: null }).reason).toBe(
      'ok',
    );
  });

  it('payments off are "off for the beta"', () => {
    expect(paymentsOffArea()).toMatchObject({ state: 'disabled', reason: 'payments_off' });
  });
});

describe('the scanner', () => {
  it('"none" is off (beta): passes the beta, never a public launch', () => {
    expect(scannerAreaState({ provider: 'none', scaniiEndpoint: null, production: true })).toEqual({
      state: 'beta_only',
      reason: 'scanning_off',
      provider: null,
    });
    expect(reasonText('en', { key: 'scanner', reason: 'scanning_off' })).toMatch(
      /Not ready for a public launch/,
    );
  });

  it('the development scanner in production is a fault: uploads would never finish', () => {
    expect(
      scannerAreaState({ provider: 'mock', scaniiEndpoint: null, production: true }).state,
    ).toBe('needs_attention');
    expect(
      scannerAreaState({ provider: 'mock', scaniiEndpoint: null, production: false }).state,
    ).toBe('test_double');
  });

  it('Scanii is ready only with its URL', () => {
    expect(
      scannerAreaState({
        provider: 'scanii',
        scaniiEndpoint: 'https://x/v2.2/files',
        production: true,
      }).state,
    ).toBe('ready');
    expect(
      scannerAreaState({ provider: 'scanii', scaniiEndpoint: null, production: true }).reason,
    ).toBe('incomplete');
  });
});

describe('the trial plan', () => {
  it('ready only with a price in the trial currency and every limit set', () => {
    expect(trialAreaState([trialPlan()], 'USD')).toMatchObject({
      state: 'ready',
      reason: 'trial_ok',
      detail: { days: '90', credits: '500' },
    });
    expect(trialAreaState([trialPlan({ prices: [{ currency: 'SAR' }] })], 'USD').reason).toBe(
      'trial_no_price',
    );
    expect(trialAreaState([], 'USD').reason).toBe('trial_missing');
  });

  it('flags every limit left unset, which customers would see as "Unlimited"', () => {
    const area = trialAreaState(
      [trialPlan({ quotas: { ...SET, storageGb: null, workspaces: null } })],
      'USD',
    );
    expect(area).toMatchObject({ state: 'needs_attention', reason: 'trial_quota_unset' });
    expect(area.detail?.['quotas']).toBe('workspaces, storageGb');
    expect(
      reasonText('en', {
        key: 'trial',
        reason: area.reason,
        ...(area.detail ? { detail: area.detail } : {}),
      }),
    ).toContain('workspaces, storageGb');
  });

  it('takes the lowest-tier active plan with trial days, as onboarding does', () => {
    const area = trialAreaState(
      [
        trialPlan({ key: 'pro', tier: 2, quotas: { ...SET, seats: null } }),
        trialPlan({ key: 'starter', tier: 1 }),
        trialPlan({ key: 'free', tier: 0, trialDays: 0 }),
      ],
      'USD',
    );
    expect(area.detail?.['plan']).toBe('starter');
    expect(area.state).toBe('ready');
  });
});

describe('the legal documents', () => {
  const doc = (version: string, reviewed = false) => ({
    key: 'terms-of-service',
    version,
    required: true,
    reviewed,
  });
  it('a fixture version is never ready', () => {
    expect(legalAreaState([doc('fixture-2026-09-01')]).state).toBe('needs_attention');
  });
  it('a draft reads "draft, legal review pending" and passes the beta only', () => {
    const area = legalAreaState([doc('2026-10 beta draft')]);
    expect(area).toMatchObject({ state: 'beta_only', reason: 'legal_draft' });
    expect(reasonText('en', { key: 'legal', reason: area.reason, detail: area.detail! })).toBe(
      'Draft, legal review pending (2026-10 beta draft). Fine for the closed beta.',
    );
  });
  it('reviewed by the owner is ready; none required is not set up', () => {
    expect(legalAreaState([doc('2026-10 beta draft', true)]).state).toBe('ready');
    expect(legalAreaState([]).state).toBe('setup_required');
  });
});

describe('the settings rows', () => {
  it('the password minimum is 12 for the beta', () => {
    expect(passwordAreaState(12).state).toBe('ready');
    expect(passwordAreaState(8)).toMatchObject({
      state: 'needs_attention',
      reason: 'password_short',
    });
  });
  it('the sender name', () => {
    expect(senderAreaState('Brandspace')).toMatchObject({
      state: 'ready',
      detail: { name: 'Brandspace' },
    });
    expect(senderAreaState('  ').state).toBe('needs_attention');
    expect(senderAreaState(null).state).toBe('needs_attention');
  });
  it('post kinds need an activated publishing document', () => {
    const providers = { instagram: { postKinds: ['image', 'carousel'] } };
    expect(postKindsAreaState(true, providers)).toMatchObject({
      state: 'ready',
      detail: { kinds: 'instagram: image/carousel' },
    });
    expect(postKindsAreaState(false, providers).reason).toBe('post_kinds_default');
  });
  it('industries', () => {
    expect(industriesAreaState(12)).toMatchObject({ state: 'ready', detail: { count: '12' } });
    expect(industriesAreaState(0).state).toBe('needs_attention');
  });
});

describe('the verdict', () => {
  const area = (state: ReadinessArea['state'], required = true): ReadinessArea => ({
    key: 'legal',
    required,
    state,
    reason: 'ok',
    provider: null,
    href: areaHref('legal'),
  });
  it('"beta only" passes; anything else unfinished and required does not', () => {
    expect(readinessVerdict([area('ready'), area('beta_only')]).status).toBe('ready');
    expect(readinessVerdict([area('ready'), area('needs_attention')]).status).toBe('not_ready');
    expect(readinessVerdict([area('needs_attention', false)]).status).toBe('ready');
  });
  it('each new row links to where it is fixed', () => {
    expect(areaHref('scanner')).toBe('/configuration?domain=assets');
    expect(areaHref('legal')).toBe('/configuration?domain=onboarding');
    expect(areaHref('trial')).toBe('/plans');
    expect(areaHref('sender')).toBe('/integrations?category=email');
  });
});
