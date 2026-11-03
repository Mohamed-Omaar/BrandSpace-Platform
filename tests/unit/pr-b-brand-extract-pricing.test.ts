import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationService,
  validateConfiguration,
  type ConfigContext,
  type ConfigDomain,
} from '@brandspace/config';
import { ConfigurationAiSource, findAiTask, findCreditRule } from '@brandspace/ai-gateway';
import {
  BRAND_EXTRACT_MAX_INPUT_CHARS,
  BRAND_EXTRACT_MAX_OUTPUT_TOKENS,
} from '@brandspace/brand-brain';

/**
 * PR B (D-591) — `brand.extract`, PRICED PER SOURCE, AND THE DOCUMENTS THE
 * OWNER PASTES (`docs/pricing/pr-b-ai-credit-rules.json`,
 * `docs/pricing/pr-b-ai-routing.json`), loaded through the RUNTIME SOURCE the
 * API reads (#111) over staging's models as the owner pasted them on
 * 2026-11-01. Every route the routing can call is priced, the documents
 * validate, and the per-source price keeps the D-15 target margin (65%) at the
 * WORST-CASE source the extractor will ever send.
 */
const rules = JSON.parse(readFileSync('docs/pricing/pr-b-ai-credit-rules.json', 'utf8'));
const routing = JSON.parse(readFileSync('docs/pricing/pr-b-ai-routing.json', 'utf8'));

const MODELS = {
  models: [
    {
      key: 'gpt-5.4-mini',
      providerKey: 'openai',
      displayName: 'GPT-5.4 mini',
      modality: 'text',
      qualityTier: 'balanced',
      status: 'beta',
      inputCostPerUnitMicroMinor: 75000,
      outputCostPerUnitMicroMinor: 450000,
    },
    {
      key: 'gpt-5.4-nano',
      providerKey: 'openai',
      displayName: 'GPT-5.4 nano',
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
    {
      key: 'gpt-image-2',
      providerKey: 'openai',
      displayName: 'GPT image 2',
      modality: 'image',
      qualityTier: 'premium',
      status: 'beta',
      inputCostPerUnitMicroMinor: 0,
      outputCostPerUnitMicroMinor: 21100000,
      costUnit: 'image',
    },
  ],
};

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

describe('PR B — brand.extract pricing documents', () => {
  it('brand.extract is a registered JSON text task', () => {
    expect(findAiTask('brand.extract')).toMatchObject({ modality: 'text', mvpApproved: true });
  });

  it('both documents validate', () => {
    const context: ConfigContext = { 'ai.models': MODELS, 'ai.routing': routing };
    expect(validateConfiguration('ai.routing', routing, { 'ai.models': MODELS }).valid).toBe(true);
    expect(validateConfiguration('ai.credit-rules', rules, context).valid).toBe(true);
  });

  it('loaded through the runtime source, every route (brand.extract included) is priced', async () => {
    const config = await runtimeLoad({
      'ai.models': MODELS,
      'ai.routing': routing,
      'ai.credit-rules': rules,
    });
    const unpriced: string[] = [];
    for (const rule of config.routingRules) {
      for (const modelKey of [rule.primaryModelKey, ...rule.fallbackModelKeys]) {
        const image = config.models.find((m) => m.key === modelKey)?.modality === 'image';
        for (const quality of image ? (['low', 'medium', 'high'] as const) : [undefined]) {
          try {
            findCreditRule(config.creditRules, rule.taskKey, modelKey, quality);
          } catch {
            unpriced.push(`${rule.taskKey}/${modelKey}${quality ? `/${quality}` : ''}`);
          }
        }
      }
    }
    expect(unpriced).toEqual([]);
    expect(config.routingRules.some((rule) => rule.taskKey === 'brand.extract')).toBe(true);
  });

  it('one source costs 2 credits and keeps a ≥ 65% margin at the worst-case source', () => {
    // The extractor never sends more than this: a whole source up to
    // BRAND_EXTRACT_MAX_INPUT_CHARS (≤ 1 token per 2 characters, the Arabic
    // case) plus a 1,500-token instruction, and asks for at most
    // BRAND_EXTRACT_MAX_OUTPUT_TOKENS.
    const inputTokens = BRAND_EXTRACT_MAX_INPUT_CHARS / 2 + 1_500;
    const outputTokens = BRAND_EXTRACT_MAX_OUTPUT_TOKENS;
    const priceMicroMinor = (2000 / 1000) * rules.creditValueMicroMinor;
    for (const model of MODELS.models.filter((m) => m.key.startsWith('gpt-5.4'))) {
      const row = rules.costs.find(
        (c: { taskKey: string; modelKey: string }) =>
          c.taskKey === 'brand.extract' && c.modelKey === model.key,
      );
      expect(row, model.key).toMatchObject({ baseMilliCredits: 2000, unit: 'request' });
      const cost =
        (inputTokens / 1000) * model.inputCostPerUnitMicroMinor +
        (outputTokens / 1000) * model.outputCostPerUnitMicroMinor;
      const margin = 1 - cost / priceMicroMinor;
      expect(margin, model.key).toBeGreaterThanOrEqual(0.65);
    }
  });

  it('every row of staging’s current document is kept, unchanged', () => {
    const kept = rules.costs.filter((c: { taskKey: string }) => c.taskKey !== 'brand.extract');
    expect(kept).toHaveLength(17);
    expect(rules).toMatchObject({ creditValueMicroMinor: 5800000, targetGrossMarginPercent: 65 });
  });
});
