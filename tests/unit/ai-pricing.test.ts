import { describe, expect, it } from 'vitest';

import {
  assessMargin,
  requiredPriceMicroMinor,
  billableMilliUnits,
  creditsChargedMilli,
  estimateReservationMilli,
  findCreditRule,
  PricingError,
  providerCostMicroMinor,
  type CreditRule,
  type ModelCostBasis,
} from '@brandspace/ai-gateway';
import { CONFIG_DOMAINS, validateConfiguration } from '@brandspace/config';

/**
 * Cost and credit arithmetic — docs/AI-GATEWAY.md §7.2.
 *
 * Two failure modes are worth more than all the others here, and both are
 * silent:
 *
 *   - LOSING THE FRACTION. Providers price in fractions of a cent. Arithmetic
 *     that rounds before it multiplies records a cost of zero and reports
 *     infinite margin, which is exactly the number the margin floor exists to
 *     catch.
 *   - ROUNDING THE CUSTOMER'S WAY BY ACCIDENT. Credits that round down per
 *     component instead of once at the end give away a fraction of a credit on
 *     every request, forever, with nothing in the ledger to show for it.
 *
 * So the assertions below are about exact integers, not about approximate
 * agreement.
 */

function basis(overrides: Partial<ModelCostBasis> = {}): ModelCostBasis {
  return {
    modelKey: 'text-a',
    // A realistic shape, invented for the test and priced nowhere in source:
    // 15,000 micro-minor per 1k tokens is $0.15 per million tokens.
    inputCostPerUnitMicroMinor: 15_000,
    outputCostPerUnitMicroMinor: 60_000,
    costUnit: '1k_tokens',
    costCurrency: 'USD',
    ...overrides,
  };
}

function rule(overrides: Partial<CreditRule> = {}): CreditRule {
  return {
    taskKey: 'caption.generate',
    modelKey: 'text-a',
    baseMilliCredits: 100,
    perUnitMilliCredits: 50,
    unit: '1k_tokens',
    ...overrides,
  };
}

describe('billable units', () => {
  it('counts tokens in thousandths of a thousand-token unit', () => {
    // 1,500 tokens is 1.5 units. Rounding that to 1 or to 2 before multiplying
    // by a rate changes the bill, so the fraction is carried as an integer.
    expect(billableMilliUnits({ promptTokens: 1000, completionTokens: 500 }, '1k_tokens')).toBe(
      1500,
    );
  });

  it('counts whole units for images, seconds and characters', () => {
    expect(billableMilliUnits({ imageCount: 3 }, 'image')).toBe(3000);
    expect(billableMilliUnits({ durationSeconds: 12 }, 'second')).toBe(12_000);
    expect(billableMilliUnits({ characters: 240 }, 'character')).toBe(240_000);
  });

  it('counts a per-request unit once, whatever the usage', () => {
    expect(billableMilliUnits({ promptTokens: 99_999 }, 'request')).toBe(1000);
  });

  it('treats absent usage as zero rather than as undefined', () => {
    expect(billableMilliUnits({}, '1k_tokens')).toBe(0);
    expect(billableMilliUnits({}, 'image')).toBe(0);
  });
});

describe('provider cost', () => {
  it('keeps a sub-cent cost instead of rounding it to nothing', () => {
    // 500 prompt + 200 completion tokens at the rates above:
    //   500 × 15000 / 1000 =  7,500 micro-minor
    //   200 × 60000 / 1000 = 12,000 micro-minor
    // Together 0.0195 of a cent. In whole cents that is 0 — the rounding that
    // would make every margin report meaningless.
    const cost = providerCostMicroMinor({ promptTokens: 500, completionTokens: 200 }, basis());
    expect(cost).toBe(19_500n);
  });

  it('prices input and output at their own rates', () => {
    const promptOnly = providerCostMicroMinor({ promptTokens: 1000 }, basis());
    const completionOnly = providerCostMicroMinor({ completionTokens: 1000 }, basis());

    expect(promptOnly).toBe(15_000n);
    expect(completionOnly).toBe(60_000n);
    // Charging output at the input rate would understate cost fourfold here.
    expect(completionOnly).not.toBe(promptOnly);
  });

  it('rounds our own cost up, never down', () => {
    // 1 token at 15,000 per 1k is 15 micro-minor exactly; 1 token at a rate of
    // 1 per 1k is 0.001, and recording that as 0 understates cost — the
    // direction that makes a loss-making model look profitable.
    expect(
      providerCostMicroMinor(
        { promptTokens: 1 },
        basis({ inputCostPerUnitMicroMinor: 1, outputCostPerUnitMicroMinor: 1 }),
      ),
    ).toBe(1n);
  });

  it('prices non-token units at the output rate', () => {
    const cost = providerCostMicroMinor(
      { imageCount: 4 },
      basis({ costUnit: 'image', outputCostPerUnitMicroMinor: 4_000_000 }),
    );
    expect(cost).toBe(16_000_000n);
  });

  it('refuses to price a model with no cost basis', () => {
    // Returning zero would be worse than failing: it reports a free model.
    const error = (() => {
      try {
        providerCostMicroMinor({ promptTokens: 10 }, basis({ inputCostPerUnitMicroMinor: null }));
        return null;
      } catch (e: unknown) {
        return e as PricingError;
      }
    })();

    expect(error).toBeInstanceOf(PricingError);
    expect(error?.reason).toBe('no_cost_basis');
  });

  it('costs nothing for a request that produced no usage', () => {
    expect(providerCostMicroMinor({}, basis())).toBe(0n);
  });
});

describe('credits charged', () => {
  it('charges the base plus the per-unit component', () => {
    // base 100 milli-credits + 1.5 units × 50 = 100 + 75 = 175
    const charged = creditsChargedMilli({ promptTokens: 1000, completionTokens: 500 }, rule());
    expect(charged).toBe(175n);
  });

  it('rounds once at the end, not per component', () => {
    // base 1 + (0.5 units × 1) = 1.5 milli-credits -> 2.
    // Rounding each component first would give 1 + 1 = 2 here but 1 + 0 = 1
    // for the half-unit alone, so the two are distinguished explicitly below.
    const combined = creditsChargedMilli(
      { promptTokens: 500 },
      rule({
        baseMilliCredits: 1,
        perUnitMilliCredits: 1,
      }),
    );
    const perUnitAlone = creditsChargedMilli(
      { promptTokens: 500 },
      rule({
        baseMilliCredits: 0,
        perUnitMilliCredits: 1,
      }),
    );

    expect(combined).toBe(2n);
    // Half a milli-credit still costs one: never charge a customer nothing for
    // work that cost us something.
    expect(perUnitAlone).toBe(1n);
  });

  it('applies a workspace multiplier exactly, in basis points', () => {
    // ×1.1 on 175 is 192.5, which rounds up to 193. A float multiplier of 1.1
    // is not 1.1, and the drift accumulates across a month of requests.
    const charged = creditsChargedMilli(
      { promptTokens: 1000, completionTokens: 500 },
      rule(),
      11_000,
    );
    expect(charged).toBe(193n);
  });

  it('charges nothing when a multiplier is zero', () => {
    // A zero multiplier is a deliberate operator choice (an internal workspace,
    // a goodwill window). It must be free, not rounded up to one milli-credit.
    expect(creditsChargedMilli({ promptTokens: 1000 }, rule(), 0)).toBe(0n);
  });

  it('refuses a negative multiplier', () => {
    expect(() => creditsChargedMilli({ promptTokens: 10 }, rule(), -1)).toThrow(PricingError);
  });

  it('charges the base even when a request reported no usage', () => {
    // A provider that returns no usage must not make the request free.
    expect(creditsChargedMilli({}, rule())).toBe(100n);
  });

  it('refuses to serve a task nobody priced', () => {
    const error = (() => {
      try {
        findCreditRule([rule()], 'caption.generate', 'text-b');
        return null;
      } catch (e: unknown) {
        return e as PricingError;
      }
    })();

    // Serving it anyway would serve it for free, permanently and silently.
    expect(error?.reason).toBe('no_credit_rule');
  });

  it('matches a rule on the task AND the model, not either alone', () => {
    const rules = [
      rule({ modelKey: 'text-a', baseMilliCredits: 100 }),
      rule({ modelKey: 'text-b', baseMilliCredits: 900 }),
    ];
    expect(findCreditRule(rules, 'caption.generate', 'text-b').baseMilliCredits).toBe(900);
  });
});

describe('reservation estimates', () => {
  it('reserves for the worst case the route permits', () => {
    // §7.3: reserve generously, settle on the actual. The reservation must
    // cover the full maxOutputTokens, because settling ABOVE a reservation is
    // refused outright by the ai_request_charge_within_reservation constraint.
    const reserved = estimateReservationMilli(rule(), {
      promptTokens: 500,
      completionTokens: 800,
    });
    const actual = creditsChargedMilli({ promptTokens: 500, completionTokens: 120 }, rule());

    expect(reserved).toBeGreaterThan(actual);
  });

  it('never reserves less than the eventual charge for the same usage', () => {
    const usage = { promptTokens: 1234, completionTokens: 567 };
    expect(estimateReservationMilli(rule(), usage)).toBeGreaterThanOrEqual(
      creditsChargedMilli(usage, rule()),
    );
  });
});

describe('margin', () => {
  it('reports margin as UNKNOWN until a credit is priced', () => {
    // Revenue is in credits and cost is in money; nothing converts between
    // them until the owner prices a credit (D-15/D-16). Reporting 100% here
    // would make an unpriced platform look profitable.
    const assessment = assessMargin(19_500n, 175n, null, 60);

    expect(assessment.grossMarginPercent).toBeNull();
    expect(assessment.revenueMicroMinor).toBeNull();
    expect(assessment.costMicroMinor).toBe(19_500n);
    // Unknown is not a breach — it is a reason the guard cannot run at all.
    expect(assessment.belowFloor).toBe(false);
  });

  it('computes margin from configured credit value', () => {
    // One credit worth 1,000,000 micro-minor (one cent). 175 milli-credits is
    // 0.175 credits = 175,000 micro-minor of revenue against 19,500 of cost.
    const assessment = assessMargin(19_500n, 175n, 1_000_000, 0);

    expect(assessment.revenueMicroMinor).toBe(175_000n);
    expect(assessment.grossMarginPercent).toBeCloseTo(88.85, 1);
    expect(assessment.belowFloor).toBe(false);
  });

  it('flags a charge that breaches a configured floor', () => {
    // Cost 90,000 against revenue 100,000 is 10% margin, under a 60% floor.
    const assessment = assessMargin(90_000n, 100n, 1_000_000, 60);

    expect(assessment.grossMarginPercent).toBeCloseTo(10, 5);
    expect(assessment.belowFloor).toBe(true);
  });

  it('does not flag anything when no floor is configured', () => {
    // A floor of 0 is the documented "guard disabled" state (D-15 pending).
    const assessment = assessMargin(90_000n, 100n, 1_000_000, 0);
    expect(assessment.belowFloor).toBe(false);
  });

  it('treats a charge with cost but no revenue as a loss, not as perfect margin', () => {
    const assessment = assessMargin(19_500n, 0n, 1_000_000, 60);
    expect(assessment.grossMarginPercent).toBe(-100);
    expect(assessment.belowFloor).toBe(true);
  });
});

describe('deriving a price from a target gross margin (D-15)', () => {
  it('divides by (1 - margin) rather than marking the cost up', () => {
    // THE MISTAKE THIS TEST EXISTS TO CATCH. A 65% target is not "cost plus
    // 65%": marking 1,000,000 up by 65% gives 1,650,000, whose margin is
    // 650,000/1,650,000 ≈ 39.4%, not 65%. The correct derivation gives
    // ~2,857,143, and it is off by nearly a factor of two.
    const cost = 1_000_000n;
    const priced = requiredPriceMicroMinor(cost, 6_500);

    expect(priced).toBe(2_857_143n);
    expect(priced).not.toBe(1_650_000n);
  });

  it('round-trips: pricing at the target then measuring it gives the target back', () => {
    // The two directions have to agree, or the margin screen would contradict
    // the price it just recommended.
    const cost = 19_500n;
    const priced = requiredPriceMicroMinor(cost, 6_500);
    const margin = Number(((priced - cost) * 10_000n) / priced) / 100;

    expect(margin).toBeCloseTo(65, 1);
  });

  it('prices at cost for a zero target', () => {
    expect(requiredPriceMicroMinor(1_000_000n, 0)).toBe(1_000_000n);
  });

  it('rounds up, so a price never lands under its target', () => {
    // 1 / (1 - 0.65) = 2.857…, and 2 would miss the target.
    expect(requiredPriceMicroMinor(1n, 6_500)).toBe(3n);
  });

  it('refuses a target of 100% or more', () => {
    // No finite price divided by zero-or-less reaches it. Better to fail than
    // to return a number somebody prices from.
    expect(() => requiredPriceMicroMinor(1_000_000n, 10_000)).toThrow(PricingError);
    expect(() => requiredPriceMicroMinor(1_000_000n, 12_000)).toThrow(PricingError);
    expect(() => requiredPriceMicroMinor(1_000_000n, -1)).toThrow(PricingError);
  });

  it('costs nothing to price nothing', () => {
    expect(requiredPriceMicroMinor(0n, 6_500)).toBe(0n);
  });

  it('invents no target margin', () => {
    // D-15 approved 65% as an internal commercial TARGET, explicitly not a
    // hard-coded markup. It is entered in configuration and versioned there.
    const parsed = CONFIG_DOMAINS['ai.credit-rules'].schema.parse({});
    expect(parsed.targetGrossMarginPercent).toBeNull();
    expect(parsed.minimumGrossMarginPercent).toBe(0);
  });

  it('keeps the target and the floor as separate numbers', () => {
    // The target is where pricing aims; the floor is where a change is
    // flagged. Collapsing them would make every price sit exactly on the
    // warning line.
    const parsed = CONFIG_DOMAINS['ai.credit-rules'].schema.parse({
      targetGrossMarginPercent: 65,
      minimumGrossMarginPercent: 55,
    });
    expect(parsed.targetGrossMarginPercent).toBe(65);
    expect(parsed.minimumGrossMarginPercent).toBe(55);
  });

  it('refuses a target of 100% in configuration too', () => {
    expect(
      CONFIG_DOMAINS['ai.credit-rules'].schema.safeParse({ targetGrossMarginPercent: 100 }).success,
    ).toBe(false);
  });
});

describe('cost basis configuration', () => {
  it('invents no provider rate and no credit price', () => {
    // CLAUDE.md §2.2: AI credit costs are configuration. A plausible default
    // would be indistinguishable from a real number on the margin screen.
    const models = CONFIG_DOMAINS['ai.models'].schema.parse({
      models: [
        {
          key: 'm',
          providerKey: 'p',
          displayName: 'M',
          modality: 'text',
          qualityTier: 'fast',
          status: 'disabled',
        },
      ],
    });
    expect(models.models[0]?.inputCostPerUnitMicroMinor).toBeNull();
    expect(models.models[0]?.outputCostPerUnitMicroMinor).toBeNull();

    const rules = CONFIG_DOMAINS['ai.credit-rules'].schema.parse({});
    expect(rules.creditValueMicroMinor).toBeNull();
    expect(rules.minimumGrossMarginPercent).toBe(0);
  });

  it('refuses to activate a servable model with no cost basis', () => {
    // docs/AI-GATEWAY.md §4: cost fields must be present before activation.
    const report = validateConfiguration('ai.models', {
      models: [
        {
          key: 'm',
          providerKey: 'p',
          displayName: 'M',
          modality: 'text',
          qualityTier: 'fast',
          status: 'available',
        },
      ],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes('no cost basis'))).toBe(true);
  });

  it('accepts a servable model once its rates and benchmark are recorded', () => {
    const report = validateConfiguration('ai.models', {
      models: [
        {
          key: 'm',
          providerKey: 'p',
          displayName: 'M',
          modality: 'text',
          qualityTier: 'fast',
          status: 'available',
          inputCostPerUnitMicroMinor: 15_000,
          outputCostPerUnitMicroMinor: 60_000,
          // D-17: general availability also needs the Arabic benchmark.
          qualityBenchmarkRef: 'BENCH-2026-09-ar-001',
        },
      ],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('does not require a cost basis for a model nobody can be served by', () => {
    const report = validateConfiguration('ai.models', {
      models: [
        {
          key: 'm',
          providerKey: 'p',
          displayName: 'M',
          modality: 'text',
          qualityTier: 'fast',
          status: 'disabled',
        },
      ],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('rejects a duplicate model key', () => {
    const report = validateConfiguration('ai.models', {
      models: [
        {
          key: 'm',
          providerKey: 'p',
          displayName: 'M',
          modality: 'text',
          qualityTier: 'fast',
          status: 'disabled',
        },
        {
          key: 'm',
          providerKey: 'p',
          displayName: 'M again',
          modality: 'text',
          qualityTier: 'fast',
          status: 'disabled',
        },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes('Duplicate model key'))).toBe(true);
  });
});

describe('the Arabic quality gate (D-17)', () => {
  function model(overrides: Record<string, unknown> = {}) {
    return {
      key: 'm',
      providerKey: 'p',
      displayName: 'M',
      modality: 'text',
      qualityTier: 'fast',
      inputCostPerUnitMicroMinor: 15_000,
      outputCostPerUnitMicroMinor: 60_000,
      ...overrides,
    };
  }

  it('refuses general availability without a recorded benchmark', () => {
    // "No provider/model may be enabled for production customer routing until
    // it passes a documented side-by-side Arabic marketing-content benchmark."
    const report = validateConfiguration('ai.models', {
      models: [model({ status: 'available' })],
    });

    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes('D-17'))).toBe(true);
  });

  it('lets a model sit in beta while it is being evaluated', () => {
    // The gate is between beta and general availability. Blocking beta would
    // make the evaluation itself impossible to run.
    const report = validateConfiguration('ai.models', {
      models: [model({ status: 'beta' })],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('admits a model once the benchmark is recorded', () => {
    const report = validateConfiguration('ai.models', {
      models: [model({ status: 'available', qualityBenchmarkRef: 'BENCH-2026-09-ar-001' })],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('invents no benchmark reference', () => {
    const parsed = CONFIG_DOMAINS['ai.models'].schema.parse({
      models: [model({ status: 'disabled' })],
    });
    expect(parsed.models[0]?.qualityBenchmarkRef).toBeNull();
  });
});

describe('provider eligibility gates (D-13)', () => {
  function provider(overrides: Record<string, unknown> = {}) {
    return {
      key: 'p',
      name: 'Provider',
      baseUrl: 'https://api.example.test',
      apiKeySecretRef: 'ai_provider/p/production/key',
      timeoutMs: 30_000,
      maxConcurrency: 10,
      noTrainingGuarantee: true,
      dataRetentionPolicy: 'zero_retention',
      privacyReviewRef: 'DPA-2026-09-001',
      ...overrides,
    };
  }

  it('refuses to activate a provider that may train on customer data', () => {
    // D-13 made this a gate rather than advice. An advisory gate is one
    // somebody eventually clicks past.
    const report = validateConfiguration('ai.providers', {
      providers: [provider({ status: 'active', noTrainingGuarantee: false })],
    });
    expect(report.valid).toBe(false);
  });

  it('refuses to activate a provider whose retention terms are unreviewed', () => {
    const report = validateConfiguration('ai.providers', {
      providers: [provider({ status: 'active', dataRetentionPolicy: 'unverified' })],
    });
    expect(report.valid).toBe(false);
  });

  it('refuses to activate a provider that was reviewed and retains our data', () => {
    // Recorded rather than silently dropped: the finding is the point.
    const report = validateConfiguration('ai.providers', {
      providers: [provider({ status: 'active', dataRetentionPolicy: 'retains_data' })],
    });
    expect(report.valid).toBe(false);
  });

  it('refuses to activate a provider with no privacy review on record', () => {
    const report = validateConfiguration('ai.providers', {
      providers: [provider({ status: 'active', privacyReviewRef: null })],
    });
    expect(report.valid).toBe(false);
  });

  it('accepts a provider that has cleared every gate', () => {
    const report = validateConfiguration('ai.providers', {
      providers: [provider({ status: 'active' })],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('accepts limited retention as the documented equivalent', () => {
    // D-13 accepts "zero-retention or an acceptable equivalent".
    const report = validateConfiguration('ai.providers', {
      providers: [provider({ status: 'active', dataRetentionPolicy: 'limited_retention' })],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('leaves a draft provider alone while it is being evaluated', () => {
    // The gates bind at activation. A provider being assessed has by
    // definition not finished being assessed.
    const report = validateConfiguration('ai.providers', {
      providers: [
        provider({
          status: 'draft',
          noTrainingGuarantee: false,
          dataRetentionPolicy: 'unverified',
          privacyReviewRef: null,
        }),
      ],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('defaults a new provider to unverified rather than to trusted', () => {
    const parsed = CONFIG_DOMAINS['ai.providers'].schema.parse({
      providers: [
        {
          key: 'p',
          name: 'P',
          baseUrl: 'https://api.example.test',
          apiKeySecretRef: null,
          status: 'draft',
          timeoutMs: 1000,
          maxConcurrency: 1,
          noTrainingGuarantee: false,
        },
      ],
    });
    expect(parsed.providers[0]?.dataRetentionPolicy).toBe('unverified');
    expect(parsed.providers[0]?.privacyReviewRef).toBeNull();
  });
});
