import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigurationService, validateConfiguration, type ConfigDomain } from '@brandspace/config';
import { ConfigurationAiSource, reasonsWith } from '@brandspace/ai-gateway';

/**
 * NO TEMPERATURE FOR A REQUEST THAT REASONS (owner, 2026-11-12).
 *
 * OpenAI refuses `temperature` when a model reasons (its effort is not
 * `none`); gpt-6.1-sol reasons at `medium` by default and cannot be set to
 * `none`. The gateway sent every route's temperature (0.7 by default), so
 * `strategy.generate` and `plan.monthly` on gpt-6.1-sol got HTTP 400 —
 * INVALID_REQUEST, never retried and never sent to the fallback.
 *
 * Whether a request reasons is DECLARED, never inferred from a model's name:
 * the catalogue's `defaultReasoningEffort`, or the route's `reasoningEffort`.
 */

// The ACTIVE staging routing: v2, read by the owner on 2026-11-12. Every
// rule sets parameters; strategy and the monthly plan set temperature 1.
const routing = JSON.parse(readFileSync('docs/pricing/staging-active-ai-routing-v2.json', 'utf8'));
const change = JSON.parse(readFileSync('docs/pricing/reasoning-ai-models-change.json', 'utf8'));

/** The two staging models these routes use, as `pr-3-pricing` records them. */
const STAGING_MODELS = [
  {
    key: 'gpt-5.4-mini',
    providerKey: 'openai',
    displayName: 'GPT-5.4 mini',
    modality: 'text',
    qualityTier: 'fast',
    status: 'beta',
    inputCostPerUnitMicroMinor: 20000,
    outputCostPerUnitMicroMinor: 125000,
  },
  {
    key: 'gpt-6.1-sol',
    providerKey: 'openai',
    displayName: 'GPT-6.1 sol',
    modality: 'text',
    qualityTier: 'premium',
    status: 'beta',
    inputCostPerUnitMicroMinor: 200000,
    outputCostPerUnitMicroMinor: 1000000,
  },
];

async function runtimeLoad(active: Partial<Record<ConfigDomain, unknown>>) {
  const prisma = {
    configurationVersion: {
      findFirst: async ({ where }: { where: { domain: ConfigDomain } }) =>
        active[where.domain] === undefined ? null : { payload: active[where.domain] },
    },
  };
  return new ConfigurationAiSource(
    new ConfigurationService({ prisma: prisma as never }),
    'STAGING',
  ).load();
}

const errors = (report: ReturnType<typeof validateConfiguration>) =>
  report.issues.filter((issue) => issue.severity === 'error');

describe('reasoning · whether a request reasons', () => {
  it('the route’s effort wins; otherwise the model’s declared default; none does not reason', () => {
    expect(reasonsWith({}, {})).toBe(false);
    expect(reasonsWith({ defaultReasoningEffort: null }, { reasoningEffort: null })).toBe(false);
    expect(reasonsWith({ defaultReasoningEffort: 'none' }, {})).toBe(false);
    expect(reasonsWith({ defaultReasoningEffort: 'medium' }, {})).toBe(true);
    expect(reasonsWith({ defaultReasoningEffort: 'medium' }, { reasoningEffort: 'none' })).toBe(
      false,
    );
    expect(reasonsWith({ defaultReasoningEffort: null }, { reasoningEffort: 'high' })).toBe(true);
    expect(reasonsWith({ defaultReasoningEffort: 'none' }, { reasoningEffort: 'low' })).toBe(true);
  });
});

describe('reasoning · the settings', () => {
  it('a model declares its default effort; unset is null; an unknown effort is refused', () => {
    const ok = validateConfiguration('ai.models', {
      models: [{ ...STAGING_MODELS[1], defaultReasoningEffort: 'medium' }],
    });
    expect(errors(ok)).toEqual([]);
    const bad = validateConfiguration('ai.models', {
      models: [{ ...STAGING_MODELS[1], defaultReasoningEffort: 'turbo' }],
    });
    expect(bad.valid).toBe(false);
  });

  it('a route may name its effort; unset is null', () => {
    const report = validateConfiguration(
      'ai.routing',
      {
        rules: [
          {
            taskKey: 'strategy.generate',
            primaryModelKey: 'gpt-6.1-sol',
            fallbackModelKeys: ['gpt-5.4-mini'],
            parameters: { reasoningEffort: 'high' },
          },
        ],
      },
      { models: STAGING_MODELS.map((m) => ({ key: m.key, modality: m.modality })) } as never,
    );
    expect(errors(report)).toEqual([]);
  });
});

describe('reasoning · staging’s strategy and monthly plan', () => {
  it('TODAY: both route to gpt-6.1-sol with temperature 1 set on the route and no reasoning declared — the request carries a temperature', async () => {
    const config = await runtimeLoad({
      'ai.models': { models: STAGING_MODELS },
      'ai.routing': routing,
    });
    const sol = config.models.find((m) => m.key === 'gpt-6.1-sol')!;
    expect(sol.defaultReasoningEffort ?? null).toBeNull();
    for (const taskKey of ['strategy.generate', 'plan.monthly']) {
      const route = config.routingRules.find((r) => r.taskKey === taskKey)!;
      expect(route.primaryModelKey).toBe('gpt-6.1-sol');
      expect(route.parameters.temperature).toBe(1);
      expect(route.parameters.maxOutputTokens).toBe(6_000);
      expect(reasonsWith(sol, route.parameters)).toBe(false);
    }
  });

  it('WITH THE ACTIVATION SNIPPET: gpt-6.1-sol reasons at medium, so neither route sends its temperature of 1; the mini fallback still does', async () => {
    expect(change).toEqual({ model: 'gpt-6.1-sol', add: { defaultReasoningEffort: 'medium' } });
    const models = {
      models: STAGING_MODELS.map((m) => (m.key === change.model ? { ...m, ...change.add } : m)),
    };
    expect(errors(validateConfiguration('ai.models', models))).toEqual([]);
    const config = await runtimeLoad({ 'ai.models': models, 'ai.routing': routing });
    const sol = config.models.find((m) => m.key === 'gpt-6.1-sol')!;
    const mini = config.models.find((m) => m.key === 'gpt-5.4-mini')!;
    expect(sol.defaultReasoningEffort).toBe('medium');
    for (const taskKey of ['strategy.generate', 'plan.monthly']) {
      const route = config.routingRules.find((r) => r.taskKey === taskKey)!;
      // The route sets temperature 1 explicitly; it is still not sent to sol.
      expect(route.parameters.temperature).toBe(1);
      expect(reasonsWith(sol, route.parameters)).toBe(true);
      expect(reasonsWith(mini, route.parameters)).toBe(false);
    }
  });
});
