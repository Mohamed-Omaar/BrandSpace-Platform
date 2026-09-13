import { describe, expect, it } from 'vitest';
import {
  CONFIG_DOMAIN_KEYS,
  buildImpactPreview,
  defaultPayload,
  isConfigDomain,
  validateConfiguration,
} from '@brandspace/config';

/**
 * Configuration validation and impact preview.
 *
 * The semantic stage is what stops a plausible-looking document from taking the
 * platform down — routing to a disabled model, granting a feature that does not
 * exist, activating a plan with no price.
 */

describe('domain registry', () => {
  it('every domain has an empty-but-valid default', () => {
    for (const domain of CONFIG_DOMAIN_KEYS) {
      const report = validateConfiguration(domain, defaultPayload(domain));
      expect(report.valid, `${domain} default must validate`).toBe(true);
    }
  });

  it('rejects an unknown domain name', () => {
    expect(isConfigDomain('not-a-domain')).toBe(false);
  });

  it('covers every configuration category the owner must control', () => {
    // CLAUDE.md §2.2 lists what must never be hard-coded.
    for (const required of [
      'ai.providers',
      'ai.models',
      'ai.routing',
      'ai.credit-rules',
      'plans',
      'entitlements',
      'feature-flags',
      'usage-limits',
      'integrations.email',
      'integrations.storage',
      'integrations.payment',
      'integrations.social-apps',
      'templates',
      'website',
      'operations',
    ]) {
      expect(CONFIG_DOMAIN_KEYS).toContain(required);
    }
  });
});

describe('structural validation', () => {
  it('rejects a malformed document', () => {
    const report = validateConfiguration('ai.providers', {
      providers: [{ key: '', name: 'X', baseUrl: 'not-a-url', status: 'active' }],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.length).toBeGreaterThan(0);
  });

  it('reports the failing path so the operator can find it', () => {
    const report = validateConfiguration('usage-limits', {
      limits: [{ key: 'k', scope: 'user', windowSeconds: -1, maxRequests: 10 }],
    });
    expect(report.issues.some((i) => i.path.includes('windowSeconds'))).toBe(true);
  });
});

describe('semantic validation', () => {
  const models = {
    models: [
      {
        key: 'good',
        providerKey: 'p',
        displayName: 'Good',
        modality: 'text',
        qualityTier: 'fast',
        status: 'available',
        disableSwitch: false,
      },
      {
        key: 'off',
        providerKey: 'p',
        displayName: 'Off',
        modality: 'text',
        qualityTier: 'fast',
        status: 'disabled',
        disableSwitch: true,
      },
    ],
  };

  it('refuses routing to a model that does not exist', () => {
    const report = validateConfiguration(
      'ai.routing',
      { rules: [{ taskKey: 'caption.generate', primaryModelKey: 'ghost', fallbackModelKeys: [] }] },
      { 'ai.models': models },
    );
    expect(report.valid).toBe(false);
    expect(report.issues[0]?.message).toMatch(/not defined in ai\.models/);
  });

  it('refuses routing to a DISABLED model', () => {
    // The exact case docs/ARCHITECTURE.md §7.2 names.
    const report = validateConfiguration(
      'ai.routing',
      { rules: [{ taskKey: 'caption.generate', primaryModelKey: 'off', fallbackModelKeys: [] }] },
      { 'ai.models': models },
    );
    expect(report.valid).toBe(false);
    expect(report.issues[0]?.message).toMatch(/disabled/);
  });

  it('accepts routing to an available model', () => {
    const report = validateConfiguration(
      'ai.routing',
      { rules: [{ taskKey: 'caption.generate', primaryModelKey: 'good', fallbackModelKeys: [] }] },
      { 'ai.models': models },
    );
    expect(report.valid).toBe(true);
  });

  it('warns when a fallback duplicates the primary', () => {
    const report = validateConfiguration(
      'ai.routing',
      { rules: [{ taskKey: 't', primaryModelKey: 'good', fallbackModelKeys: ['good'] }] },
      { 'ai.models': models },
    );
    // A warning, not an error: pointless but not dangerous.
    expect(report.valid).toBe(true);
    expect(report.issues.some((i) => i.severity === 'warning')).toBe(true);
  });

  it('requires an active AI provider to reference a stored key', () => {
    const report = validateConfiguration('ai.providers', {
      providers: [
        {
          key: 'p',
          name: 'P',
          baseUrl: 'https://api.example.com',
          apiKeySecretRef: null,
          status: 'active',
          timeoutMs: 1000,
          maxConcurrency: 5,
          noTrainingGuarantee: true,
        },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues[0]?.message).toMatch(/stored API key secret/);
  });

  it('REFUSES an active provider with no no-training guarantee (D-13)', () => {
    /*
     * This was a warning, and is now an error.
     *
     * D-13 was approved on 2026-09-13 with confirmation that customer data is
     * not used for provider training as a hard condition of vendor selection.
     * A warning was the right severity while the decision was open; once it is
     * approved, an advisory gate is one somebody eventually clicks past.
     */
    const report = validateConfiguration('ai.providers', {
      providers: [
        {
          key: 'p',
          name: 'P',
          baseUrl: 'https://api.example.com',
          apiKeySecretRef: 'ai/p/prod/key',
          status: 'active',
          timeoutMs: 1000,
          maxConcurrency: 5,
          noTrainingGuarantee: false,
          dataRetentionPolicy: 'zero_retention',
          privacyReviewRef: 'DPA-2026-09-001',
        },
      ],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.severity === 'error' && i.message.includes('D-13'))).toBe(
      true,
    );
  });

  it('refuses an active plan with no price (owner decision D-07)', () => {
    const report = validateConfiguration('plans', {
      plans: [
        {
          key: 'growth',
          name: { ar: 'نمو', en: 'Growth' },
          description: { ar: '', en: '' },
          status: 'active',
          visibility: 'public',
          prices: [],
          trialDays: 14,
          monthlyCredits: 100,
          sortOrder: 1,
        },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues[0]?.message).toMatch(/at least one currency price/);
  });

  it('refuses an entitlement granting an undefined feature', () => {
    const report = validateConfiguration('entitlements', {
      features: [],
      planEntitlements: [{ planKey: 'growth', featureKey: 'ghost.feature', enabled: true }],
    });
    expect(report.valid).toBe(false);
  });

  it('refuses a feature depending on one that does not exist', () => {
    const report = validateConfiguration('entitlements', {
      features: [
        { key: 'a', name: { ar: 'أ', en: 'A' }, valueType: 'boolean', dependsOn: ['missing'] },
      ],
      planEntitlements: [],
    });
    expect(report.valid).toBe(false);
  });

  it('refuses a workspace in both the enabled and disabled flag lists', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const report = validateConfiguration('feature-flags', {
      flags: [{ featureKey: 'f', enabledForWorkspaces: [id], disabledForWorkspaces: [id] }],
    });
    expect(report.valid).toBe(false);
  });

  it('skips semantic checks when the structure is already broken', () => {
    // Otherwise every problem would be reported twice.
    const report = validateConfiguration('ai.routing', { rules: 'not-an-array' });
    expect(report.valid).toBe(false);
    expect(report.issues.every((i) => i.severity === 'error')).toBe(true);
  });
});

describe('impact preview', () => {
  it('reports additions, changes and removals by natural key', () => {
    const before = {
      models: [
        { key: 'a', status: 'available' },
        { key: 'b', status: 'available' },
      ],
    };
    const after = {
      models: [
        { key: 'a', status: 'disabled' },
        { key: 'c', status: 'available' },
      ],
    };
    const preview = buildImpactPreview('ai.models', before, after);

    const kinds = preview.changes.map((c) => `${c.kind}:${c.path}`);
    expect(kinds).toContain('changed:models.a');
    expect(kinds).toContain('added:models.c');
    expect(kinds).toContain('removed:models.b');
  });

  it('marks a removal as high impact', () => {
    const preview = buildImpactPreview('ai.models', { models: [{ key: 'a' }] }, { models: [] });
    expect(preview.highImpactCount).toBe(1);
  });

  it('marks a price change as high impact', () => {
    const preview = buildImpactPreview(
      'plans',
      {
        plans: [
          { key: 'g', prices: [{ currency: 'SAR', monthlyMinor: 10000, annualMinor: 100000 }] },
        ],
      },
      {
        plans: [
          { key: 'g', prices: [{ currency: 'SAR', monthlyMinor: 20000, annualMinor: 200000 }] },
        ],
      },
    );
    expect(preview.highImpactCount).toBe(1);
  });

  it('marks disabling a model as high impact', () => {
    const preview = buildImpactPreview(
      'ai.models',
      { models: [{ key: 'a', status: 'available', disableSwitch: false }] },
      { models: [{ key: 'a', status: 'available', disableSwitch: true }] },
    );
    expect(preview.highImpactCount).toBe(1);
  });

  it('reports no changes when nothing differs', () => {
    const doc = { models: [{ key: 'a', status: 'available' }] };
    expect(buildImpactPreview('ai.models', doc, doc).changes).toHaveLength(0);
  });

  it('describes which fields changed, not an array index', () => {
    const preview = buildImpactPreview(
      'ai.models',
      { models: [{ key: 'a', status: 'available' }] },
      { models: [{ key: 'a', status: 'disabled' }] },
    );
    expect(preview.changes[0]?.summary).toContain('model "a"');
    expect(preview.changes[0]?.summary).toContain('status');
  });
});
