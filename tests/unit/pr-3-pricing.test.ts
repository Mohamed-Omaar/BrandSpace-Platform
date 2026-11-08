import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationService,
  marginWarnings,
  validateConfiguration,
  type ConfigDomain,
} from '@brandspace/config';
import {
  AiGateway,
  ConfigurationAiSource,
  DEFAULT_IMAGE_SIZING,
  assessMargin,
  findCreditRule,
  parseImageSize,
  providerCostMicroMinor,
  resolveImageSize,
  type ImageSizing,
} from '@brandspace/ai-gateway';
import { CREATIVE_FORMATS } from '@brandspace/creative';
import {
  BRAND_EXTRACT_INSTRUCTION,
  BRAND_EXTRACT_MAX_INPUT_CHARS,
  BRAND_EXTRACT_MAX_OUTPUT_TOKENS,
} from '@brandspace/brand-brain';

/**
 * PR 3 (F-113, D-15) — THE COMBINED PRICING SET AND THE MARGIN WARNING.
 *
 * The three documents the owner activates (`docs/pricing/pr-3-*`), over
 * staging's models as the owner pasted them on 2026-11-01 with the one change
 * `pr-3-ai-models-change.json` makes, loaded through the RUNTIME SOURCE the API
 * reads. Every route is priced at every image quality; a credit is $0.058;
 * every row keeps the 65% target at its stated worst case except copilot.chat
 * on mini, which the warning names; and the warning's arithmetic is the
 * gateway's own (`providerCostMicroMinor` + `assessMargin`).
 */
const rules = JSON.parse(readFileSync('docs/pricing/pr-3-ai-credit-rules.json', 'utf8'));
const routing = JSON.parse(readFileSync('docs/pricing/pr-3-ai-routing.json', 'utf8'));
const change = JSON.parse(readFileSync('docs/pricing/pr-3-ai-models-change.json', 'utf8'));

const PASTED = [
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
];
/** Staging's catalogue with the change applied, exactly as step 1 asks. */
const MODELS = {
  models: PASTED.map((m) => (m.key === change.model ? { ...m, ...change.add } : m)),
};

const GPT_IMAGE_2_CUSTOM: ImageSizing = {
  mode: 'custom',
  multipleOf: 16,
  minPixels: 655_360,
  maxPixels: 8_294_400,
  maxEdge: 3_840,
  maxAspectRatio: 3,
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

type Row = {
  taskKey: string;
  modelKey: string;
  baseMilliCredits: number;
  imageQuality?: 'low' | 'medium' | 'high';
  marginInputTokens?: number;
  marginImagePixels?: number;
};
const rows = rules.costs as Row[];
const errors = (report: ReturnType<typeof validateConfiguration>) =>
  report.issues.filter((i) => i.severity === 'error');

describe('PR 3 — the combined pricing set', () => {
  it('the models change adds only the per-quality image cost, to gpt-image-2', () => {
    expect(change).toEqual({
      model: 'gpt-image-2',
      add: { imageCostByQualityMicroMinor: { low: 600000, medium: 5300000, high: 21100000 } },
    });
  });

  it('validates in the activation order: ai.models, then ai.credit-rules, then ai.routing', () => {
    expect(errors(validateConfiguration('ai.models', MODELS))).toEqual([]);
    expect(
      errors(validateConfiguration('ai.credit-rules', rules, { 'ai.models': MODELS })),
    ).toEqual([]);
    expect(
      errors(
        validateConfiguration('ai.routing', routing, {
          'ai.models': MODELS,
          'ai.credit-rules': rules,
        }),
      ),
    ).toEqual([]);
  });

  it('a credit is $0.058, the target is 65%, and images cost 1 / 6 / 24 credits by quality', () => {
    expect(rules).toMatchObject({
      unit: 'milli-credits',
      creditValueMicroMinor: 5_800_000,
      targetGrossMarginPercent: 65,
      referenceCurrency: 'USD',
    });
    const image = rows.filter((r) => r.taskKey === 'image.generate');
    expect(image.map((r) => [r.imageQuality, r.baseMilliCredits])).toEqual([
      ['low', 1000],
      ['medium', 6000],
      ['high', 24000],
    ]);
    // No row without a quality: all three are priced, so it would never apply.
    expect(image.every((r) => r.imageQuality !== undefined)).toBe(true);
    for (const modelKey of ['gpt-5.4-mini', 'gpt-5.4-nano']) {
      expect(
        rows.find((r) => r.taskKey === 'brand.extract' && r.modelKey === modelKey),
      ).toMatchObject({ baseMilliCredits: 3000 });
    }
  });

  it('the text rows keep their credits: caption, ideas, analytics 2; translate, copilot 1; strategy, plan 12', () => {
    const credits = Object.fromEntries(
      rows
        .filter((r) => r.taskKey !== 'image.generate')
        .map((r) => [`${r.taskKey}|${r.modelKey}`, r.baseMilliCredits / 1000]),
    );
    expect(credits).toEqual({
      'caption.generate|gpt-5.4-mini': 2,
      'caption.generate|gpt-5.4-nano': 2,
      'ideas.generate|gpt-5.4-mini': 2,
      'ideas.generate|gpt-5.4-nano': 2,
      'analytics.explain|gpt-5.4-mini': 2,
      'analytics.explain|gpt-5.4-nano': 2,
      'content.translate|gpt-5.4-mini': 1,
      'content.translate|gpt-5.4-nano': 1,
      'copilot.chat|gpt-5.4-mini': 1,
      'copilot.chat|gpt-5.4-nano': 1,
      'brand.extract|gpt-5.4-mini': 3,
      'brand.extract|gpt-5.4-nano': 3,
      'strategy.generate|gpt-6.1-sol': 12,
      'strategy.generate|gpt-5.4-mini': 12,
      'plan.monthly|gpt-6.1-sol': 12,
      'plan.monthly|gpt-5.4-mini': 12,
    });
  });

  it('loaded through the runtime source: every route is priced at every quality, brand.extract included', async () => {
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
    const extract = config.routingRules.find((r) => r.taskKey === 'brand.extract');
    expect(extract).toMatchObject({
      primaryModelKey: 'gpt-5.4-mini',
      fallbackModelKeys: ['gpt-5.4-nano'],
    });
    expect(extract?.parameters.maxOutputTokens).toBe(BRAND_EXTRACT_MAX_OUTPUT_TOKENS);
    const gptImage = config.costBases.find((m) => m.modelKey === 'gpt-image-2');
    expect(gptImage?.imageCostByQualityMicroMinor).toEqual(change.add.imageCostByQualityMicroMinor);
  });

  it('the stated image worst case is the largest image any Studio format is sent at', () => {
    const largest = Math.max(
      ...[DEFAULT_IMAGE_SIZING, GPT_IMAGE_2_CUSTOM].flatMap((sizing) =>
        CREATIVE_FORMATS.map((f) => {
          const d = parseImageSize(resolveImageSize(f.size, sizing))!;
          return d.width * d.height;
        }),
      ),
    );
    expect(largest).toBe(1152 * 2048);
    for (const row of rows.filter((r) => r.taskKey === 'image.generate')) {
      expect(row.marginImagePixels).toBe(largest);
    }
  });

  it('the stated brand.extract worst case covers the whole source the extractor may send, plus its instruction', () => {
    // 2 characters per token, the Arabic worst case; 2,000 characters of room
    // for the gateway's shared language line and the fences.
    const bound = Math.ceil(
      (BRAND_EXTRACT_MAX_INPUT_CHARS + BRAND_EXTRACT_INSTRUCTION.length + 2_000) / 2,
    );
    for (const row of rows.filter((r) => r.taskKey === 'brand.extract')) {
      expect(row.marginInputTokens).toBeGreaterThanOrEqual(bound);
    }
  });
});

describe('PR 3 — the D-15 margin warning (F-113)', () => {
  /** Each row's margin, by the GATEWAY's own arithmetic. */
  async function gatewayMargins() {
    const config = await runtimeLoad({
      'ai.models': MODELS,
      'ai.routing': routing,
      'ai.credit-rules': rules,
    });
    return rows.map((row) => {
      const basis = config.costBases.find((m) => m.modelKey === row.modelKey)!;
      const route = config.routingRules.find((r) => r.taskKey === row.taskKey)!;
      const cost =
        row.imageQuality !== undefined
          ? providerCostMicroMinor({ imageCount: 1 }, basis, {
              quality: row.imageQuality,
              pixels: row.marginImagePixels!,
            })
          : providerCostMicroMinor(
              {
                promptTokens: row.marginInputTokens!,
                completionTokens: route.parameters.maxOutputTokens,
              },
              basis,
            );
      const margin = assessMargin(cost, BigInt(row.baseMilliCredits), 5_800_000, 0);
      return {
        row: `${row.taskKey}|${row.modelKey}|${row.imageQuality ?? ''}`,
        margin: margin.grossMarginPercent!,
      };
    });
  }

  it('every row sells above cost; only copilot.chat on mini is under the 65% target', async () => {
    const margins = await gatewayMargins();
    expect(margins.every((m) => m.margin > 0)).toBe(true);
    expect(margins.filter((m) => m.margin < 65).map((m) => m.row)).toEqual([
      'copilot.chat|gpt-5.4-mini|',
    ]);
    // The figures in the PR's pricing table.
    const of = (key: string) => margins.find((m) => m.row === key)!.margin;
    expect(of('image.generate|gpt-image-2|low')).toBeCloseTo(76.72, 1);
    expect(of('image.generate|gpt-image-2|medium')).toBeCloseTo(65.73, 1);
    expect(of('image.generate|gpt-image-2|high')).toBeCloseTo(65.89, 1);
    expect(of('brand.extract|gpt-5.4-mini|')).toBeCloseTo(67.24, 1);
    expect(of('copilot.chat|gpt-5.4-mini|')).toBeCloseTo(61.47, 1);
  });

  it('activating the credit rules warns exactly there, and stays valid (a warning, never an error)', () => {
    const report = validateConfiguration('ai.credit-rules', rules, {
      'ai.models': MODELS,
      'ai.routing': routing,
    });
    expect(report.valid).toBe(true);
    const d15 = report.issues.filter((i) => i.message.includes('D-15'));
    const copilotMini = rows.findIndex(
      (r) => r.taskKey === 'copilot.chat' && r.modelKey === 'gpt-5.4-mini',
    );
    expect(d15).toEqual([
      {
        severity: 'warning',
        path: `costs.${copilotMini}`,
        message:
          'copilot.chat on gpt-5.4-mini earns 61.5% gross margin at its worst case, below the 65% target (D-15): cost 0.0223 USD against a price of 0.0580 USD, at 25,000 input and 800 output tokens.',
      },
    ]);
  });

  it('the warning agrees with the gateway on every row', async () => {
    for (const { row, margin } of await gatewayMargins()) {
      const [taskKey, modelKey, quality] = row.split('|');
      const index = rows.findIndex(
        (r) =>
          r.taskKey === taskKey && r.modelKey === modelKey && (r.imageQuality ?? '') === quality,
      );
      const flagged = marginWarnings(rules, MODELS, routing, (i) => `costs.${i}`).some(
        (w) => w.path === `costs.${index}`,
      );
      expect(flagged, row).toBe(margin < 65);
    }
  });

  it('a price below cost says so', () => {
    const cheap = {
      ...rules,
      costs: rules.costs.map((r: Row) =>
        r.taskKey === 'image.generate' && r.imageQuality === 'high'
          ? { ...r, baseMilliCredits: 1000 }
          : r,
      ),
    };
    const warnings = marginWarnings(cheap, MODELS, routing, (i) => `costs.${i}`);
    expect(warnings.map((w) => w.message)).toContainEqual(
      'image.generate on gpt-image-2 (high) SELLS BELOW COST at its worst case: cost 0.4748 USD against a price of 0.0580 USD, at one high-quality image at 2,359,296 pixels. Raise the price or lower the stated worst case.',
    );
  });

  it('a row with no stated worst case is reported as unchecked, never passed', () => {
    const unstated = {
      ...rules,
      costs: rules.costs.map((r: Row) =>
        r.taskKey === 'caption.generate' && r.modelKey === 'gpt-5.4-mini'
          ? { ...r, marginInputTokens: undefined }
          : r.taskKey === 'image.generate' && r.imageQuality === 'low'
            ? { ...r, marginImagePixels: undefined }
            : r,
      ),
    };
    const messages = marginWarnings(unstated, MODELS, routing, (i) => `costs.${i}`).map(
      (w) => w.message,
    );
    expect(messages).toContain(
      'The margin of caption.generate on gpt-5.4-mini is not checked: state "marginInputTokens", the largest input one request sends (D-15).',
    );
    expect(messages).toContain(
      'The margin of image.generate on gpt-image-2 (low) is not checked: state "marginImagePixels", the largest image this row is sent at (D-15).',
    );
  });

  it('no credit value: one warning that margins are not checked', () => {
    const report = validateConfiguration(
      'ai.credit-rules',
      { ...rules, creditValueMicroMinor: null },
      { 'ai.models': MODELS, 'ai.routing': routing },
    );
    expect(report.valid).toBe(true);
    expect(report.issues.filter((i) => i.message.includes('D-15'))).toEqual([
      expect.objectContaining({ severity: 'warning', path: 'creditValueMicroMinor' }),
    ]);
  });

  it('a model rate rise warns when the models are activated, pointing at the credit row', () => {
    const dearer = {
      models: MODELS.models.map((m) =>
        m.key === 'gpt-5.4-nano' ? { ...m, inputCostPerUnitMicroMinor: 200000 } : m,
      ),
    };
    const report = validateConfiguration('ai.models', dearer, {
      'ai.credit-rules': rules,
      'ai.routing': routing,
    });
    expect(report.valid).toBe(true);
    const nanoCopilot = rows.findIndex(
      (r) => r.taskKey === 'copilot.chat' && r.modelKey === 'gpt-5.4-nano',
    );
    expect(report.issues.map((i) => i.path)).toContain(`ai.credit-rules.costs.${nanoCopilot}`);
  });

  it('a longer output ceiling warns when the routing is activated', () => {
    const longer = {
      rules: routing.rules.map((r: { taskKey: string }) =>
        r.taskKey === 'content.translate' ? { ...r, parameters: { maxOutputTokens: 20000 } } : r,
      ),
    };
    const report = validateConfiguration('ai.routing', longer, {
      'ai.credit-rules': rules,
      'ai.models': MODELS,
    });
    expect(report.valid).toBe(true);
    const translateMini = rows.findIndex(
      (r) => r.taskKey === 'content.translate' && r.modelKey === 'gpt-5.4-mini',
    );
    expect(report.issues.map((i) => i.path)).toContain(`ai.credit-rules.costs.${translateMini}`);
  });
});

describe('PR 3 — an image request with no quality is priced as medium, never refused as unpriced', () => {
  /*
   * The documents carry no image row without a quality. That is safe only
   * because EVERY image request is priced at a quality: the gateway's
   * `imageQualityOf` (packages/ai-gateway/src/gateway.ts) gives the caller's
   * quality, else the route's `parameters.imageQuality` (schema default
   * medium), else medium — on the reservation, the quote and the charge. The
   * Studio, the post drawer, the Copilot, generation jobs and any API caller
   * all reach the provider through `AiGateway`, so none can skip it.
   */
  async function gatewayOver(routingDoc: unknown) {
    const config = await runtimeLoad({
      'ai.models': MODELS,
      'ai.routing': routingDoc,
      'ai.credit-rules': rules,
    });
    return new AiGateway({
      // The quote reads configuration only; nothing below is reached.
      prisma: {} as never,
      ledger: {} as never,
      adapters: new Map(),
      configuration: { load: async () => config },
      credentials: { resolve: async () => null } as never,
      environment: 'STAGING',
    });
  }

  it.each(CREATIVE_FORMATS.map((f) => [f.key, f.size] as const))(
    '%s (%s) with no quality: 6 credits (medium), fixed',
    async (_key, size) => {
      const gateway = await gatewayOver(routing);
      const quote = await gateway.quote({
        workspaceId: '00000000-0000-4000-8000-000000000000',
        taskKey: 'image.generate',
        planKey: null,
        input: { kind: 'image', prompt: '', count: 1, size },
      });
      expect(quote.estimateMilli).toBe(6_000n);
      expect(quote.fixed).toBe(true);
    },
  );

  it('the route names no quality either (the documents do not): still medium', async () => {
    const imageRoute = routing.rules.find(
      (r: { taskKey: string }) => r.taskKey === 'image.generate',
    );
    expect(imageRoute.parameters?.imageQuality).toBeUndefined();
    const config = await runtimeLoad({
      'ai.models': MODELS,
      'ai.routing': routing,
      'ai.credit-rules': rules,
    });
    expect(
      config.routingRules.find((r) => r.taskKey === 'image.generate')?.parameters.imageQuality,
    ).toBe('medium');
  });

  it('a named quality keeps its own price', async () => {
    const gateway = await gatewayOver(routing);
    for (const [quality, milli] of [
      ['low', 1_000n],
      ['medium', 6_000n],
      ['high', 24_000n],
    ] as const) {
      const quote = await gateway.quote({
        workspaceId: '00000000-0000-4000-8000-000000000000',
        taskKey: 'image.generate',
        planKey: null,
        input: { kind: 'image', prompt: '', count: 1, size: '1080x1080', quality },
      });
      expect(quote.estimateMilli).toBe(milli);
    }
  });
});
