import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationService,
  buildImpactPreview,
  validateConfiguration,
  type ConfigDomain,
} from '@brandspace/config';
import { ConfigurationAiSource, findCreditRule } from '@brandspace/ai-gateway';
import { defaultPayload } from '@brandspace/config';
import { parseCopilotPolicy } from '@brandspace/copilot';

/**
 * PR A (smart Copilot, D-605) — THE THREE EDITS IN `docs/pricing/PR-A-ACTIVATION.md`.
 *
 * The snippets are read FROM THE GUIDE and applied to the active documents
 * exactly as the guide tells the owner to (after PR 3: the 2026-11-01 models
 * with the per-quality image cost, PR 3's credit rules, PR 3's routing). Each
 * step validates in order with the documents active before it; Validate &
 * preview shows the impact lines the guide promises; the runtime loader
 * prices every route; the Copilot's models read images and call tools; and
 * the only margin warning is the stated one on gpt-5.4.
 */

const guide = readFileSync('docs/pricing/PR-A-ACTIVATION.md', 'utf8');
const snippet = (marker: string): string => {
  const found = new RegExp(`<!-- ${marker} -->\\s*\`\`\`json\\n([\\s\\S]*?)\`\`\``).exec(
    guide,
  )?.[1];
  if (!found) throw new Error(`snippet ${marker} missing from the guide`);
  return found;
};
/** A snippet that ends with a comma, as one JSON value. */
const value = (marker: string): Record<string, unknown> =>
  JSON.parse(snippet(marker).trim().replace(/,$/, '')) as Record<string, unknown>;

const PASTED_MODELS = {
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
      imageCostByQualityMicroMinor: { low: 600000, medium: 5300000, high: 21100000 },
    },
  ],
};
const ACTIVE_RULES = JSON.parse(readFileSync('docs/pricing/pr-3-ai-credit-rules.json', 'utf8'));
// The ACTIVE routing on staging: v2 as the owner read it on 2026-11-12, with
// parameters on every rule (copilot.chat: temperature 1, 1,500 tokens).
const ACTIVE_ROUTING = JSON.parse(
  readFileSync('docs/pricing/staging-active-ai-routing-v2.json', 'utf8'),
);

// --- The three edits, as the guide describes them. ---------------------------
type Doc = Record<string, unknown>;
const clone = <T>(doc: T): T => JSON.parse(JSON.stringify(doc)) as T;

const MODELS = (() => {
  const doc = clone(PASTED_MODELS) as { models: Doc[] };
  const fields = JSON.parse(`{${snippet('pr-a-mini-fields').trim().replace(/,$/, '')}}`) as Doc;
  doc.models = [
    value('pr-a-model-gpt-5.4'),
    ...doc.models.map((m) =>
      m['key'] === 'gpt-5.4-mini' ? { key: m['key'], ...fields, ...m } : m,
    ),
  ];
  return doc;
})();
const RULES = (() => {
  const doc = clone(ACTIVE_RULES) as { costs: Doc[] };
  doc.costs = [
    value('pr-a-credit-gpt-5.4'),
    ...doc.costs.map((row) =>
      row['taskKey'] === 'copilot.chat'
        ? { ...row, baseMilliCredits: 4000, marginInputTokens: 38400 }
        : row,
    ),
  ];
  return doc;
})();
const ROUTING = (() => {
  const doc = clone(ACTIVE_ROUTING) as { rules: Doc[] };
  doc.rules = doc.rules.map((rule) =>
    rule['taskKey'] === 'copilot.chat' ? value('pr-a-route-copilot') : rule,
  );
  return doc;
})();

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
const d15 = (report: ReturnType<typeof validateConfiguration>) =>
  report.issues.filter((issue) => issue.message.includes('D-15')).map((issue) => issue.message);

describe('PR A — the Copilot’s model and price, as the guide activates them', () => {
  it('step 1 (ai.models): valid, and the impact is gpt-5.4 added and mini given three fields', () => {
    expect(
      errors(
        validateConfiguration('ai.models', MODELS, {
          'ai.credit-rules': ACTIVE_RULES,
          'ai.routing': ACTIVE_ROUTING,
        }),
      ),
    ).toEqual([]);
    expect(
      buildImpactPreview('ai.models', PASTED_MODELS, MODELS).changes.map((c) => c.summary),
    ).toEqual([
      'model "gpt-5.4" will be added',
      'model "gpt-5.4-mini" changes: supportsVision, supportsToolUse, supportsStreaming',
    ]);
  });

  it('step 2 (ai.credit-rules): valid with the new models and the old routing; one stated warning', () => {
    const report = validateConfiguration('ai.credit-rules', RULES, {
      'ai.models': MODELS,
      'ai.routing': ACTIVE_ROUTING,
    });
    expect(errors(report)).toEqual([]);
    expect(d15(report)).toEqual([
      // The active route still allows 1,500 output tokens; step 3 lowers it.
      expect.stringMatching(
        /^copilot\.chat on gpt-5\.4 earns 48\.9% gross margin at its worst case, below the 65% target/,
      ),
    ]);
    for (const summary of buildImpactPreview('ai.credit-rules', ACTIVE_RULES, RULES).changes.map(
      (c) => c.summary,
    )) {
      expect(summary).toMatch(/^credit cost "copilot\.chat"/);
    }
  });

  it('step 3 (ai.routing): valid; the impact is the one copilot.chat rule changing', () => {
    const report = validateConfiguration('ai.routing', ROUTING, {
      'ai.models': MODELS,
      'ai.credit-rules': RULES,
    });
    expect(errors(report)).toEqual([]);
    expect(d15(report)).toEqual([
      expect.stringMatching(
        /^copilot\.chat on gpt-5\.4 earns 50\.9% gross margin at its worst case/,
      ),
    ]);
    expect(
      buildImpactPreview('ai.routing', ACTIVE_ROUTING, ROUTING).changes.map((c) => c.summary),
    ).toEqual([
      'routing rule "copilot.chat" changes: primaryModelKey, fallbackModelKeys, timeoutMs, parameters',
    ]);
  });

  it('loaded through the runtime source: the Copilot runs on gpt-5.4 then mini, both read images, 4 credits per message', async () => {
    const config = await runtimeLoad({
      'ai.models': MODELS,
      'ai.credit-rules': RULES,
      'ai.routing': ROUTING,
    });
    const route = config.routingRules.find((rule) => rule.taskKey === 'copilot.chat');
    expect(route).toMatchObject({
      primaryModelKey: 'gpt-5.4',
      fallbackModelKeys: ['gpt-5.4-mini'],
      timeoutMs: 120_000,
    });
    // The active rule's temperature is kept; the tokens per call are lowered.
    expect(route?.parameters).toMatchObject({
      temperature: 1,
      maxOutputTokens: 1_200,
      attemptTimeoutMs: 90_000,
    });
    for (const key of ['gpt-5.4', 'gpt-5.4-mini']) {
      const model = config.models.find((m) => m.key === key);
      expect(model?.features).toMatchObject({ vision: true, toolUse: true });
      expect(findCreditRule(config.creditRules, 'copilot.chat', key).baseMilliCredits).toBe(4000);
    }
    // Every other route is still priced, and every other deadline kept.
    for (const rule of config.routingRules) {
      for (const modelKey of [rule.primaryModelKey, ...rule.fallbackModelKeys]) {
        const image = config.models.find((m) => m.key === modelKey)?.modality === 'image';
        for (const quality of image ? (['low', 'medium', 'high'] as const) : [undefined]) {
          expect(() =>
            findCreditRule(config.creditRules, rule.taskKey, modelKey, quality),
          ).not.toThrow();
        }
      }
      if (rule.taskKey !== 'copilot.chat') {
        const before = (ACTIVE_ROUTING.rules as Doc[]).find((r) => r['taskKey'] === rule.taskKey);
        expect(rule.timeoutMs, rule.taskKey).toBe(before?.['timeoutMs']);
      }
    }
  });

  it('owner condition: the ENFORCED worst case of one message keeps at least 50% at 4 credits', () => {
    // The caps the code applies by default, and the prices the guide activates.
    const agent = parseCopilotPolicy(defaultPayload('copilot')).agent;
    expect(agent).toMatchObject({ maxRounds: 3, maxInputTokensPerMessage: 24_000 });
    const model = value('pr-a-model-gpt-5.4');
    const route = value('pr-a-route-copilot') as { parameters: { maxOutputTokens: number } };
    const price = value('pr-a-credit-gpt-5.4');
    const inputRate = Number(model['inputCostPerUnitMicroMinor']); // per 1k tokens
    const outputRate = Number(model['outputCostPerUnitMicroMinor']);
    // Every round re-sends the conversation, so the INPUT cap is per message;
    // the output is per round. No prompt cache is assumed: a ceiling.
    const worst =
      (agent.maxInputTokensPerMessage * inputRate) / 1000 +
      (agent.maxRounds * route.parameters.maxOutputTokens * outputRate) / 1000;
    const revenue = (Number(price['baseMilliCredits']) * 5_800_000) / 1000;
    expect(worst).toBe(11_400_000); // $0.114
    expect(revenue).toBe(23_200_000); // $0.232
    const margin = (revenue - worst) / revenue;
    expect(margin).toBeGreaterThanOrEqual(0.5);
    // The credit row states the same ceiling for the one-call margin check:
    // 24,000 input + the other rounds' output at the input-rate equivalent.
    const equivalent =
      agent.maxInputTokensPerMessage +
      ((agent.maxRounds - 1) * route.parameters.maxOutputTokens * outputRate) / inputRate;
    expect(price['marginInputTokens']).toBe(equivalent);
  });
});
