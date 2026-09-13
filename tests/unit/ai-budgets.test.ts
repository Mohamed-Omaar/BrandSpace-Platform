import { describe, expect, it } from 'vitest';

import {
  assessBudget,
  budgetRefusal,
  resolveBudget,
  withinRequestCostCap,
  type AiBudgets,
  type BudgetLimits,
  type BudgetUsage,
} from '@brandspace/ai-gateway';
import { CONFIG_DOMAINS, validateConfiguration } from '@brandspace/config';

/**
 * Budgets and limits — docs/AI-GATEWAY.md §8.
 *
 * A budget is only a budget if it binds BEFORE the money is spent, so the
 * decision is made from the estimate and not from the eventual charge. The
 * other property worth defending is the boring one: a ceiling nobody set must
 * never refuse a customer's request.
 */

const NONE: BudgetLimits = {
  creditsPerDayMilli: null,
  creditsPerMonthMilli: null,
  maxConcurrentRequests: null,
};

function usage(overrides: Partial<BudgetUsage> = {}): BudgetUsage {
  return {
    creditsTodayMilli: 0n,
    creditsThisMonthMilli: 0n,
    concurrentRequests: 0,
    ...overrides,
  };
}

describe('resolving which ceilings apply', () => {
  const budgets: AiBudgets = {
    defaults: { creditsPerDayMilli: 1000, creditsPerMonthMilli: 20_000, maxConcurrentRequests: 3 },
    perPlan: [
      {
        planKey: 'growth',
        creditsPerDayMilli: 5000,
        creditsPerMonthMilli: null,
        maxConcurrentRequests: null,
      },
    ],
  };

  it('falls back to the defaults for a workspace with no plan', () => {
    expect(resolveBudget(budgets, null)).toEqual(budgets.defaults);
  });

  it('falls back to the defaults for a plan with no entry', () => {
    expect(resolveBudget(budgets, 'starter')).toEqual(budgets.defaults);
  });

  it('overrides field by field, not wholesale', () => {
    // The growth plan raises only the daily ceiling. A whole-object override
    // would have silently made its concurrency and monthly limits unlimited,
    // which is the opposite of what raising one number should mean.
    const resolved = resolveBudget(budgets, 'growth');
    expect(resolved.creditsPerDayMilli).toBe(5000);
    expect(resolved.creditsPerMonthMilli).toBe(20_000);
    expect(resolved.maxConcurrentRequests).toBe(3);
  });
});

describe('assessing a request against its ceilings', () => {
  it('allows everything when nothing is configured', () => {
    // The state a fresh installation is in. A budget nobody set must not
    // refuse anyone.
    const decision = assessBudget(NONE, usage({ concurrentRequests: 900 }), 10_000_000n);
    expect(decision.allowed).toBe(true);
    expect(decision.breached).toBeNull();
  });

  it('refuses on the estimate, before the charge exists', () => {
    // 900 spent, 200 estimated, ceiling 1000. Admitting this because the final
    // charge might come in under 100 would mean the ceiling only binds in
    // hindsight.
    const decision = assessBudget(
      { ...NONE, creditsPerDayMilli: 1000 },
      usage({ creditsTodayMilli: 900n }),
      200n,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.breached).toBe('credits_per_day');
  });

  it('allows a request that lands exactly on the ceiling', () => {
    // The limit is a ceiling, not a wall one short of it.
    const decision = assessBudget(
      { ...NONE, creditsPerDayMilli: 1000 },
      usage({ creditsTodayMilli: 900n }),
      100n,
    );
    expect(decision.allowed).toBe(true);
  });

  it('applies the monthly ceiling independently of the daily one', () => {
    const decision = assessBudget(
      { ...NONE, creditsPerDayMilli: 10_000, creditsPerMonthMilli: 1000 },
      usage({ creditsTodayMilli: 0n, creditsThisMonthMilli: 950n }),
      100n,
    );
    expect(decision.breached).toBe('credits_per_month');
  });

  it('refuses at the concurrency ceiling, not one past it', () => {
    const atLimit = assessBudget(
      { ...NONE, maxConcurrentRequests: 2 },
      usage({ concurrentRequests: 2 }),
      1n,
    );
    const underLimit = assessBudget(
      { ...NONE, maxConcurrentRequests: 2 },
      usage({ concurrentRequests: 1 }),
      1n,
    );

    expect(atLimit.breached).toBe('concurrency');
    expect(underLimit.allowed).toBe(true);
  });

  it('reports concurrency before a spent budget', () => {
    // Both are breached. Concurrency is the one that clears on its own, so it
    // is the answer that lets the caller do something useful.
    const decision = assessBudget(
      { creditsPerDayMilli: 10, creditsPerMonthMilli: 10, maxConcurrentRequests: 1 },
      usage({ creditsTodayMilli: 900n, creditsThisMonthMilli: 900n, concurrentRequests: 5 }),
      100n,
    );
    expect(decision.breached).toBe('concurrency');
  });
});

describe('what the caller is told', () => {
  it('says try again for concurrency and does not for a spent budget', () => {
    const rateLimited = budgetRefusal(
      assessBudget({ ...NONE, maxConcurrentRequests: 1 }, usage({ concurrentRequests: 1 }), 1n),
    );
    const quotaSpent = budgetRefusal(
      assessBudget({ ...NONE, creditsPerDayMilli: 1 }, usage({ creditsTodayMilli: 5n }), 1n),
    );

    // 429: waiting genuinely helps. 402: waiting does not help until the
    // window rolls or the plan changes, and saying "retry" would be a lie.
    expect(rateLimited.httpStatus).toBe(429);
    expect(rateLimited.message).toMatch(/try again/i);
    expect(quotaSpent.httpStatus).toBe(402);
    expect(quotaSpent.message).not.toMatch(/try again/i);
  });

  it('carries the limit and the observation for the operator', () => {
    const error = budgetRefusal(
      assessBudget({ ...NONE, maxConcurrentRequests: 4 }, usage({ concurrentRequests: 7 }), 1n),
    );
    expect(error.limit).toBe(4);
    expect(error.observed).toBe(7);
  });
});

describe('the per-request cost ceiling', () => {
  it('converts minor units to micro-minor exactly once', () => {
    // A cap of 3 minor units is 3,000,000 micro-minor. Getting the factor of a
    // million wrong in either direction makes the ceiling meaningless.
    expect(withinRequestCostCap(3_000_000n, 3)).toBe(true);
    expect(withinRequestCostCap(3_000_001n, 3)).toBe(false);
    expect(withinRequestCostCap(2_999_999n, 3)).toBe(true);
  });

  it('allows anything when no cap is configured', () => {
    expect(withinRequestCostCap(999_999_999n, null)).toBe(true);
  });

  it('refuses everything with a cap of zero', () => {
    // A deliberate operator choice: a task switched off by cost.
    expect(withinRequestCostCap(1n, 0)).toBe(false);
    expect(withinRequestCostCap(0n, 0)).toBe(true);
  });
});

describe('ai.budgets configuration', () => {
  it('invents no ceiling', () => {
    const parsed = CONFIG_DOMAINS['ai.budgets'].schema.parse({});
    expect(parsed.defaults.creditsPerDayMilli).toBeNull();
    expect(parsed.defaults.creditsPerMonthMilli).toBeNull();
    expect(parsed.defaults.maxConcurrentRequests).toBeNull();
    expect(parsed.perPlan).toEqual([]);
  });

  it('rejects two entries for the same plan', () => {
    // Otherwise which ceiling a customer hits depends on iteration order.
    const report = validateConfiguration('ai.budgets', {
      perPlan: [
        { planKey: 'growth', creditsPerDayMilli: 100 },
        { planKey: 'growth', creditsPerDayMilli: 200 },
      ],
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((issue) => issue.message.includes('Duplicate budget entry'))).toBe(
      true,
    );
  });

  it('rejects a daily ceiling above the monthly one', () => {
    // The monthly limit would be unreachable and the daily one would never
    // bind: almost certainly a transposition.
    const report = validateConfiguration('ai.budgets', {
      defaults: { creditsPerDayMilli: 5000, creditsPerMonthMilli: 1000 },
    });
    expect(report.valid).toBe(false);
  });

  it('accepts a plan whose own ceilings are consistent', () => {
    const report = validateConfiguration('ai.budgets', {
      defaults: { creditsPerDayMilli: 1000, creditsPerMonthMilli: 20_000 },
      perPlan: [{ planKey: 'growth', creditsPerDayMilli: 5000, creditsPerMonthMilli: 90_000 }],
    });
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('refuses a negative ceiling', () => {
    expect(
      CONFIG_DOMAINS['ai.budgets'].schema.safeParse({ defaults: { creditsPerDayMilli: -1 } })
        .success,
    ).toBe(false);
  });
});
