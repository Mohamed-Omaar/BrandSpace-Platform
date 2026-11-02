import { describe, expect, it } from 'vitest';
import {
  ConfigurationService,
  validateConfiguration,
  type ConfigContext,
  type ConfigDomain,
} from '@brandspace/config';
import { ConfigurationAiSource, findCreditRule } from '@brandspace/ai-gateway';

/**
 * INCIDENT 2026-11-01 — A CREDIT-RULES DOCUMENT THAT VALIDATED BUT PRICED NOTHING.
 *
 * Staging activated an `ai.credit-rules` version that passed validation, and
 * every AI price then failed at runtime ("No credit rule prices task …"), text
 * included. A document whose rows sit under a key the schema does not know
 * parses to `costs: []` (Zod drops the key, `costs` defaults to empty), and
 * nothing checked that the routed tasks were still priced.
 *
 * THE GUARANTEE THIS FILE HOLDS: every document that validates is loaded
 * through the RUNTIME SOURCE — the real `ConfigurationService.get` and
 * `ConfigurationAiSource.load`, exactly as the API reads it — and every
 * task/model pair (and image quality) the routing can call is then priced by
 * the real `findCreditRule`. A document the runtime cannot price must not
 * validate.
 */

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

const CHAT_TASKS = [
  'caption.generate',
  'ideas.generate',
  'analytics.explain',
  'content.translate',
  'copilot.chat',
];

/** Staging's routing as the owner pasted it on 2026-11-01. */
const ROUTING = {
  rules: [
    ...CHAT_TASKS.map((taskKey) => ({
      taskKey,
      primaryModelKey: 'gpt-5.4-mini',
      fallbackModelKeys: ['gpt-5.4-nano'],
    })),
    ...['strategy.generate', 'plan.monthly'].map((taskKey) => ({
      taskKey,
      primaryModelKey: 'gpt-6.1-sol',
      fallbackModelKeys: ['gpt-5.4-mini'],
    })),
    { taskKey: 'image.generate', primaryModelKey: 'gpt-image-2', fallbackModelKeys: [] },
  ],
};

const row = (taskKey: string, modelKey: string, base: number, imageQuality?: string) => ({
  taskKey,
  modelKey,
  baseMilliCredits: base,
  perUnitMilliCredits: 0,
  unit: 'request',
  ...(imageQuality ? { imageQuality } : {}),
});

const TEXT_ROWS = [
  ...['caption.generate', 'ideas.generate', 'analytics.explain'].flatMap((t) => [
    row(t, 'gpt-5.4-mini', 2000),
    row(t, 'gpt-5.4-nano', 2000),
  ]),
  ...['content.translate', 'copilot.chat'].flatMap((t) => [
    row(t, 'gpt-5.4-mini', 1000),
    row(t, 'gpt-5.4-nano', 1000),
  ]),
  ...['strategy.generate', 'plan.monthly'].flatMap((t) => [
    row(t, 'gpt-6.1-sol', 12000),
    row(t, 'gpt-5.4-mini', 12000),
  ]),
];

/** The document activated on staging at 19:52 UTC, as written. */
const PER_QUALITY = {
  unit: 'milli-credits',
  costs: [
    ...TEXT_ROWS,
    row('image.generate', 'gpt-image-2', 1000, 'low'),
    row('image.generate', 'gpt-image-2', 6000, 'medium'),
    row('image.generate', 'gpt-image-2', 24000, 'high'),
  ],
  targetGrossMarginPercent: 65,
  minimumGrossMarginPercent: 0,
  creditValueMicroMinor: 5800000,
  referenceCurrency: 'USD',
};

/** Staging's previous document: one image row priced for every quality. */
const PREVIOUS = {
  ...PER_QUALITY,
  costs: [...TEXT_ROWS, row('image.generate', 'gpt-image-2', 60000)],
  creditValueMicroMinor: 1000000,
};

const context: ConfigContext = { 'ai.models': MODELS, 'ai.routing': ROUTING };

/** The API's read path, over an in-memory ACTIVE version per domain. */
async function runtimeLoad(active: Partial<Record<ConfigDomain, unknown>>) {
  const prisma = {
    configurationVersion: {
      findFirst: async ({ where }: { where: { domain: ConfigDomain } }) =>
        active[where.domain] === undefined ? null : { payload: active[where.domain] },
    },
  };
  const service = new ConfigurationService({ prisma: prisma as never });
  return new ConfigurationAiSource(service, 'STAGING').load();
}

/** Every price the routing can ask for, found the way the gateway finds it. */
async function runtimeUnpriced(creditRules: unknown, routing: unknown = ROUTING) {
  const config = await runtimeLoad({
    'ai.models': MODELS,
    'ai.routing': routing,
    'ai.credit-rules': creditRules,
  });
  const unpriced: string[] = [];
  for (const rule of config.routingRules) {
    for (const modelKey of [rule.primaryModelKey, ...rule.fallbackModelKeys]) {
      const model = config.models.find((m) => m.key === modelKey);
      const qualities =
        model?.modality === 'image' ? (['low', 'medium', 'high'] as const) : [undefined];
      for (const quality of qualities) {
        try {
          findCreditRule(config.creditRules, rule.taskKey, modelKey, quality);
        } catch {
          unpriced.push(`${rule.taskKey}/${modelKey}${quality ? `/${quality}` : ''}`);
        }
      }
    }
  }
  return unpriced;
}

const withoutRow = (index: number) => ({
  ...PER_QUALITY,
  costs: PER_QUALITY.costs.filter((_, i) => i !== index),
});

const CORPUS: Record<string, unknown> = {
  'the 19:52 per-quality document': PER_QUALITY,
  'the previous document (one image row, no quality)': PREVIOUS,
  'the document wrapped under its domain name': { 'ai.credit-rules': PER_QUALITY },
  'the rows under "rules" instead of "costs"': {
    ...PREVIOUS,
    costs: undefined,
    rules: PER_QUALITY.costs,
  },
  'no rows at all': { ...PER_QUALITY, costs: [] },
  'a misspelt imageQuality key': {
    ...PER_QUALITY,
    costs: PER_QUALITY.costs.map((c) =>
      'imageQuality' in c ? { ...c, imageQuality: undefined, imagequality: c.imageQuality } : c,
    ),
  },
  'image priced for low and high only': {
    ...PER_QUALITY,
    costs: PER_QUALITY.costs.filter((c) => c.imageQuality !== 'medium'),
  },
  'image priced for low and high, plus one row for every other quality': {
    ...PER_QUALITY,
    costs: [
      ...PER_QUALITY.costs.filter((c) => c.imageQuality !== 'medium'),
      row('image.generate', 'gpt-image-2', 6000),
    ],
  },
  'a text task priced only at an image quality': {
    ...PER_QUALITY,
    costs: PER_QUALITY.costs.map((c) =>
      c.taskKey === 'caption.generate' && c.modelKey === 'gpt-5.4-nano'
        ? { ...c, imageQuality: 'medium' }
        : c,
    ),
  },
  'a model key with a trailing space': {
    ...PER_QUALITY,
    costs: PER_QUALITY.costs.map((c, i) => (i === 0 ? { ...c, modelKey: 'gpt-5.4-mini ' } : c)),
  },
  ...Object.fromEntries(
    PER_QUALITY.costs.map((c, i) => [
      `without row ${i} (${c.taskKey}/${c.modelKey}${c.imageQuality ? `/${c.imageQuality}` : ''})`,
      withoutRow(i),
    ]),
  ),
};

const MUST_LOAD = new Set([
  'the 19:52 per-quality document',
  'the previous document (one image row, no quality)',
  'image priced for low and high, plus one row for every other quality',
]);

describe('incident 2026-11-01: credit rules validate only when the runtime can price them', () => {
  for (const [name, doc] of Object.entries(CORPUS)) {
    it(`validation agrees with the runtime loader: ${name}`, async () => {
      const report = validateConfiguration('ai.credit-rules', doc, context);
      const unpriced = await runtimeUnpriced(doc);
      // THE GUARANTEE: a document that validates is fully priced at runtime.
      if (report.valid) expect(unpriced).toEqual([]);
      // The cases that must load, load; every other case in the corpus is
      // refused (most of them priced something wrongly or not at all).
      expect(report.valid).toBe(MUST_LOAD.has(name));
    });
  }

  it('the documents that must load do validate and price every routed request', async () => {
    for (const doc of [PER_QUALITY, PREVIOUS]) {
      expect(validateConfiguration('ai.credit-rules', doc, context).valid).toBe(true);
      expect(await runtimeUnpriced(doc)).toEqual([]);
    }
    const config = await runtimeLoad({
      'ai.models': MODELS,
      'ai.routing': ROUTING,
      'ai.credit-rules': PER_QUALITY,
    });
    expect(
      findCreditRule(config.creditRules, 'caption.generate', 'gpt-5.4-mini').baseMilliCredits,
    ).toBe(2000);
    expect(
      findCreditRule(config.creditRules, 'image.generate', 'gpt-image-2', 'high').baseMilliCredits,
    ).toBe(24000);
  });

  it('a wrapped document — staging-shaped, priced nothing at runtime — is now refused by name', async () => {
    const wrapped = CORPUS['the document wrapped under its domain name'];
    expect(await runtimeUnpriced(wrapped)).toContain('caption.generate/gpt-5.4-mini');
    const report = validateConfiguration('ai.credit-rules', wrapped, context);
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.message).join(' ')).toContain(
      'Unknown field "ai.credit-rules"',
    );
  });

  it('an unrouted pair without a price is not an error; a duplicate row is (F-114)', () => {
    const extra = {
      ...PER_QUALITY,
      costs: [...PER_QUALITY.costs, row('ideas.generate', 'gpt-6.1-sol', 3000)],
    };
    expect(validateConfiguration('ai.credit-rules', extra, context).valid).toBe(true);
    const dup = {
      ...PER_QUALITY,
      costs: [...PER_QUALITY.costs, row('caption.generate', 'gpt-5.4-mini', 5000)],
    };
    const report = validateConfiguration('ai.credit-rules', dup, context);
    expect(report.valid).toBe(false);
    expect(report.issues.find((i) => i.severity === 'error')?.message).toMatch(
      /^Duplicates costs\.0/,
    );
  });

  it('with no routing active yet, prices may be entered first (fresh installation)', () => {
    expect(
      validateConfiguration('ai.credit-rules', { costs: [] }, { 'ai.models': MODELS }).valid,
    ).toBe(true);
  });

  it('a routing change may not send a task to a model the active credit rules do not price', async () => {
    const routing = {
      rules: [
        ...ROUTING.rules,
        { taskKey: 'hashtags.generate', primaryModelKey: 'gpt-5.4-nano', fallbackModelKeys: [] },
      ],
    };
    const withRules: ConfigContext = { ...context, 'ai.credit-rules': PER_QUALITY };
    const report = validateConfiguration('ai.routing', routing, withRules);
    expect(await runtimeUnpriced(PER_QUALITY, routing)).toEqual(['hashtags.generate/gpt-5.4-nano']);
    expect(report.valid).toBe(false);
    expect(report.issues.find((i) => i.severity === 'error')?.path).toBe('rules.8.primaryModelKey');
    // The routing staging runs today validates against both credit documents.
    expect(validateConfiguration('ai.routing', ROUTING, withRules).valid).toBe(true);
    expect(
      validateConfiguration('ai.routing', ROUTING, { ...context, 'ai.credit-rules': PREVIOUS })
        .valid,
    ).toBe(true);
  });
});
