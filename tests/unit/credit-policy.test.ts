import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  allocateFifo,
  allocationTotal,
  expiryFor,
  fifoByExpiry,
  lowBalanceCrossing,
  narrowAllocation,
  rolloverAmount,
  toWholeCredits,
  creditPolicyFrom,
  INERT_CREDIT_POLICY,
  MILLI_PER_CREDIT,
  type AllocatableBucket,
  type CreditPolicy,
} from '@brandspace/entitlements';

/**
 * The credit rules that decide how much money a customer keeps — D-11, D-12.
 *
 * These are pure functions precisely so they can be tested without a database,
 * a clock or a configuration document. Everything asserted here is a rule the
 * owner approved, not an implementation detail.
 */

function bucket(
  id: string,
  spendable: bigint,
  expiresAt: string | null,
  grantedAt = '2026-01-01T00:00:00.000Z',
): AllocatableBucket {
  return {
    id,
    spendableMilliCredits: spendable,
    expiresAt: expiresAt === null ? null : new Date(expiresAt),
    grantedAt: new Date(grantedAt),
  };
}

const POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 12,
  promotionalExpiryMonths: 3,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [20, 5],
  reservationTimeoutSeconds: 900,
};

describe('FIFO by nearest expiry (D-12)', () => {
  it('spends the soonest-expiring bucket first', () => {
    const result = allocateFifo(
      [
        bucket('later', 1000n, '2026-06-01T00:00:00.000Z'),
        bucket('sooner', 1000n, '2026-03-01T00:00:00.000Z'),
      ],
      500n,
    );
    expect(result.allocations).toEqual([{ grantId: 'sooner', milliCredits: 500n }]);
    expect(result.shortfallMilliCredits).toBe(0n);
  });

  it('spends a never-expiring bucket LAST, however old it is', () => {
    // This is the rule that distinguishes FIFO-by-expiry from FIFO-by-date, and
    // it is the whole point: spending a permanent credit while a dated one is
    // about to lapse destroys value the customer paid for.
    const result = allocateFifo(
      [
        bucket('permanent', 1000n, null, '2020-01-01T00:00:00.000Z'),
        bucket('expiring', 1000n, '2026-03-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ],
      500n,
    );
    expect(result.allocations).toEqual([{ grantId: 'expiring', milliCredits: 500n }]);
  });

  it('spills into the next bucket when the first cannot cover it', () => {
    const result = allocateFifo(
      [
        bucket('first', 300n, '2026-03-01T00:00:00.000Z'),
        bucket('second', 1000n, '2026-06-01T00:00:00.000Z'),
      ],
      800n,
    );
    expect(result.allocations).toEqual([
      { grantId: 'first', milliCredits: 300n },
      { grantId: 'second', milliCredits: 500n },
    ]);
    expect(allocationTotal(result.allocations)).toBe(800n);
  });

  it('reports a shortfall rather than over-allocating', () => {
    const result = allocateFifo([bucket('only', 100n, null)], 500n);
    expect(allocationTotal(result.allocations)).toBe(100n);
    expect(result.shortfallMilliCredits).toBe(400n);
  });

  it('skips empty buckets instead of writing zero-value allocations', () => {
    const result = allocateFifo(
      [bucket('empty', 0n, '2026-02-01T00:00:00.000Z'), bucket('full', 500n, null)],
      200n,
    );
    expect(result.allocations).toEqual([{ grantId: 'full', milliCredits: 200n }]);
  });

  it('breaks ties on the older grant, then the id, so the order is total', () => {
    const same = '2026-05-01T00:00:00.000Z';
    const ordered = [
      bucket('z', 100n, same, '2026-02-01T00:00:00.000Z'),
      bucket('a', 100n, same, '2026-01-01T00:00:00.000Z'),
    ].sort(fifoByExpiry);
    expect(ordered.map((b) => b.id)).toEqual(['a', 'z']);
  });

  it('allocates nothing for a non-positive request', () => {
    expect(allocateFifo([bucket('x', 100n, null)], 0n).allocations).toEqual([]);
  });
});

describe('narrowing a frozen allocation at settlement', () => {
  it('takes the reduction off the same buckets in the same order', () => {
    // Settlement must charge the buckets the RESERVATION chose, not re-run FIFO
    // against a wallet other requests have since moved.
    const frozen = [
      { grantId: 'first', milliCredits: 300n },
      { grantId: 'second', milliCredits: 500n },
    ];
    expect(narrowAllocation(frozen, 400n)).toEqual([
      { grantId: 'first', milliCredits: 300n },
      { grantId: 'second', milliCredits: 100n },
    ]);
  });

  it('charges nothing when the actual cost is zero', () => {
    expect(narrowAllocation([{ grantId: 'a', milliCredits: 100n }], 0n)).toEqual([]);
  });

  it('never expands beyond what was frozen', () => {
    const frozen = [{ grantId: 'a', milliCredits: 100n }];
    expect(allocationTotal(narrowAllocation(frozen, 999n))).toBe(100n);
  });
});

describe('rollover (D-12: up to one monthly allowance)', () => {
  const allowance = 500n * MILLI_PER_CREDIT;

  it('capped at one allowance keeps exactly one allowance', () => {
    expect(rolloverAmount('capped', 1, allowance, 900n * MILLI_PER_CREDIT)).toBe(allowance);
  });

  it('capped keeps everything when the balance is under the cap', () => {
    const carried = 200n * MILLI_PER_CREDIT;
    expect(rolloverAmount('capped', 1, allowance, carried)).toBe(carried);
  });

  it('none forfeits the whole balance', () => {
    expect(rolloverAmount('none', 1, allowance, 900n * MILLI_PER_CREDIT)).toBe(0n);
  });

  it('full keeps the whole balance', () => {
    const carried = 9000n * MILLI_PER_CREDIT;
    expect(rolloverAmount('full', 0, allowance, carried)).toBe(carried);
  });

  it('a capped policy with no cap keeps nothing', () => {
    // The configuration validator refuses this combination precisely so it
    // cannot arrive here; if it does, "capped at zero" is the honest reading.
    expect(rolloverAmount('capped', 0, allowance, 900n * MILLI_PER_CREDIT)).toBe(0n);
  });

  it('handles a fractional multiplier exactly, without floating point', () => {
    expect(rolloverAmount('capped', 1.5, allowance, 9_999_999n)).toBe(750n * MILLI_PER_CREDIT);
  });

  it('a zero balance rolls nothing over under any policy', () => {
    for (const policy of ['none', 'capped', 'full'] as const) {
      expect(rolloverAmount(policy, 1, allowance, 0n)).toBe(0n);
    }
  });
});

describe('expiry (D-12: 12 months for packs, 3 for promotional)', () => {
  const grantedAt = new Date('2026-01-15T10:30:00.000Z');

  it('a purchased pack expires after the configured months', () => {
    expect(expiryFor('PACK_PURCHASE', grantedAt, POLICY)?.toISOString()).toBe(
      '2027-01-15T10:30:00.000Z',
    );
  });

  it('a promotional grant expires sooner', () => {
    expect(expiryFor('PROMOTIONAL_GRANT', grantedAt, POLICY)?.toISOString()).toBe(
      '2026-04-15T10:30:00.000Z',
    );
  });

  it('zero months means never expires', () => {
    expect(expiryFor('PLAN_GRANT', grantedAt, POLICY)).toBeNull();
  });

  it('an admin adjustment never carries a policy expiry', () => {
    expect(expiryFor('ADMIN_ADJUSTMENT', grantedAt, POLICY)).toBeNull();
  });

  it('clamps the day rather than overflowing into the next month', () => {
    // 31 January plus one month is 28 February, not 3 March. Overflowing would
    // silently give the customer three extra days, and in the other direction
    // would take them away.
    expect(addMonthsClamped(new Date('2026-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('handles a leap year correctly', () => {
    expect(addMonthsClamped(new Date('2028-01-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});

describe('low-balance thresholds', () => {
  const allowance = 100n * MILLI_PER_CREDIT;

  it('reports the threshold the balance has fallen through', () => {
    expect(lowBalanceCrossing(15n * MILLI_PER_CREDIT, allowance, [20, 5], null)).toBe(20);
  });

  it('reports the MORE URGENT band when the balance skips one', () => {
    // A wallet that drops from full to 3% should be told it is at 5%, not 20%.
    expect(lowBalanceCrossing(3n * MILLI_PER_CREDIT, allowance, [20, 5], null)).toBe(5);
  });

  it('does not repeat a threshold it has already reported', () => {
    expect(lowBalanceCrossing(15n * MILLI_PER_CREDIT, allowance, [20, 5], 20)).toBeNull();
  });

  it('still reports a lower band after a higher one was reported', () => {
    expect(lowBalanceCrossing(3n * MILLI_PER_CREDIT, allowance, [20, 5], 20)).toBe(5);
  });

  it('says nothing when the balance is healthy', () => {
    expect(lowBalanceCrossing(80n * MILLI_PER_CREDIT, allowance, [20, 5], null)).toBeNull();
  });

  it('says nothing when no thresholds are configured', () => {
    expect(lowBalanceCrossing(0n, allowance, [], null)).toBeNull();
  });

  it('says nothing when the plan has no allowance to measure against', () => {
    // Dividing by zero here would either throw or produce a nonsense percentage
    // that warns every request.
    expect(lowBalanceCrossing(0n, 0n, [20, 5], null)).toBeNull();
  });
});

describe('the display unit (D-14)', () => {
  it('rounds DOWN, so the customer is never shown more than is spendable', () => {
    expect(toWholeCredits(1999n)).toBe(1);
    expect(toWholeCredits(2000n)).toBe(2);
  });
});

/*
 * READING THE `credits` DOCUMENT — current execution Phase 3.
 *
 * There were two readers of it: one inside the Control Center and, once the
 * scheduler needed the same values to expire grants and grant allowances, very
 * nearly a second. Two readers are two answers, and the way that shows up is an
 * operator changing a policy, seeing the screens agree, and the sweep going on
 * using the old shape of it.
 */
describe('reading the credits policy', () => {
  it('an absent document is INERT, never a guess at the approved numbers', () => {
    expect(creditPolicyFrom({})).toEqual(INERT_CREDIT_POLICY);
  });

  it('takes the values an owner set', () => {
    const policy = creditPolicyFrom({
      hardStopAtZero: false,
      purchasedPackExpiryMonths: 12,
      promotionalExpiryMonths: 3,
      planGrantExpiryMonths: 1,
      lowBalanceThresholdPercents: [20, 5],
      reservationTimeoutSeconds: 600,
    });
    expect(policy.hardStopAtZero).toBe(false);
    expect(policy.purchasedPackExpiryMonths).toBe(12);
    expect(policy.lowBalanceThresholdPercents).toEqual([20, 5]);
    expect(policy.reservationTimeoutSeconds).toBe(600);
  });

  it('THE HARD STOP IS ON UNLESS IT IS EXPLICITLY OFF', () => {
    // A missing field must not switch off the one control that stops a
    // customer spending credits they do not have (D-11).
    expect(creditPolicyFrom({ hardStopAtZero: undefined }).hardStopAtZero).toBe(true);
    expect(creditPolicyFrom({ hardStopAtZero: null }).hardStopAtZero).toBe(true);
  });

  it('a nonsense value falls back rather than becoming NaN or a negative month', () => {
    const policy = creditPolicyFrom({
      purchasedPackExpiryMonths: 'soon',
      reservationTimeoutSeconds: -5,
      lowBalanceThresholdPercents: 'twenty',
    });
    expect(policy.purchasedPackExpiryMonths).toBe(INERT_CREDIT_POLICY.purchasedPackExpiryMonths);
    expect(policy.reservationTimeoutSeconds).toBe(INERT_CREDIT_POLICY.reservationTimeoutSeconds);
    expect(policy.lowBalanceThresholdPercents).toEqual([]);
  });
});
