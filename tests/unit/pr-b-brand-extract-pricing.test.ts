import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationService,
  validateConfiguration,
  type ConfigContext,
  type ConfigDomain,
} from '@brandspace/config';
import {
  ConfigurationAiSource,
  findAiTask,
  findCreditRule,
  isFixedPrice,
} from '@brandspace/ai-gateway';
import {
  BRAND_EXTRACT_MAX_INPUT_CHARS,
  BRAND_EXTRACT_MAX_OUTPUT_TOKENS,
} from '@brandspace/brand-brain';

/**
 * PR B (D-594) — `brand.extract`, PRICED PER SOURCE, AND THE DOCUMENTS THE
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

  it('one source costs 3 credits, for sources up to 50,000 tokens, as agreed', () => {
    // The extractor never sends more than this: a whole source up to
    // BRAND_EXTRACT_MAX_INPUT_CHARS at the worst case of 2 characters per
    // token (Arabic) — 50,000 tokens — and asks for at most
    // BRAND_EXTRACT_MAX_OUTPUT_TOKENS.
    const inputTokens = BRAND_EXTRACT_MAX_INPUT_CHARS / 2;
    expect(inputTokens).toBe(50_000);
    const outputTokens = BRAND_EXTRACT_MAX_OUTPUT_TOKENS;
    for (const modelKey of ['gpt-5.4-mini', 'gpt-5.4-nano']) {
      const row = rules.costs.find(
        (c: { taskKey: string; modelKey: string }) =>
          c.taskKey === 'brand.extract' && c.modelKey === modelKey,
      );
      expect(row, modelKey).toMatchObject({ baseMilliCredits: 3000, unit: 'request' });
    }
    // The agreed price holds the D-15 target (65%) at the cap at the credit
    // value it was agreed at ($0.058). The documents keep staging's ACTIVE
    // credit value, which the owner sets (see the PR report).
    const AGREED_CREDIT_VALUE = 5_800_000;
    const mini = MODELS.models[0]!;
    const cost =
      (inputTokens / 1000) * mini.inputCostPerUnitMicroMinor +
      (outputTokens / 1000) * mini.outputCostPerUnitMicroMinor;
    expect(1 - cost / (3 * AGREED_CREDIT_VALUE)).toBeGreaterThanOrEqual(0.65);
  });

  it('only brand.extract is added: every active row and the credit value kept', () => {
    const kept = rules.costs.filter((c: { taskKey: string }) => c.taskKey !== 'brand.extract');
    // Staging's active (rolled-back) document, as #111's runtime test records it.
    expect(kept).toHaveLength(15);
    expect(kept.find((c: { taskKey: string }) => c.taskKey === 'image.generate')).toMatchObject({
      modelKey: 'gpt-image-2',
      baseMilliCredits: 60000,
    });
    expect(rules).toMatchObject({ creditValueMicroMinor: 1000000, targetGrossMarginPercent: 65 });
    expect(routing.rules.map((r: { taskKey: string }) => r.taskKey).sort()).toEqual(
      [
        'analytics.explain',
        'brand.extract',
        'caption.generate',
        'content.translate',
        'copilot.chat',
        'ideas.generate',
        'image.generate',
        'plan.monthly',
        'strategy.generate',
      ].sort(),
    );
  });

  it('the price beside Send: a file’s price is shown only when it is fixed per source', async () => {
    const config = await runtimeLoad({
      'ai.models': MODELS,
      'ai.routing': routing,
      'ai.credit-rules': rules,
    });
    // brand.extract is one flat price per source: shown before the file is read.
    for (const modelKey of ['gpt-5.4-mini', 'gpt-5.4-nano']) {
      expect(isFixedPrice(findCreditRule(config.creditRules, 'brand.extract', modelKey))).toBe(
        true,
      );
    }
    // A price per token depends on the input: never shown before it exists.
    expect(isFixedPrice({ unit: '1k_tokens', perUnitMilliCredits: 5 })).toBe(false);
    expect(isFixedPrice({ unit: 'request', perUnitMilliCredits: 5 })).toBe(false);
  });
});
