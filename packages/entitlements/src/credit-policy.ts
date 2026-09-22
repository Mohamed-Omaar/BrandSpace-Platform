/**
 * Credit POLICY, as pure functions — docs/BILLING-AND-CREDITS.md Part II,
 * decisions D-11 and D-12.
 *
 * Nothing here touches a database, a clock or configuration loading. FIFO
 * allocation, rollover arithmetic, expiry dates and low-balance thresholds are
 * the rules most likely to be wrong in a way that costs a customer money, so
 * they are separated from the transaction machinery and tested directly.
 *
 * Every amount is in MILLI-CREDITS (D-14). Whole credits are a display concern.
 */

/** 1 credit = 1000 milli-credits. Display divides; storage never does. */
export const MILLI_PER_CREDIT = 1000n;

/** The `credits` configuration domain, materialised. */
export interface CreditPolicy {
  readonly hardStopAtZero: boolean;
  readonly purchasedPackExpiryMonths: number;
  readonly promotionalExpiryMonths: number;
  readonly planGrantExpiryMonths: number;
  readonly lowBalanceThresholdPercents: readonly number[];
  readonly reservationTimeoutSeconds: number;
}

/**
 * The policy in force when the owner has configured nothing.
 *
 * Deliberately INERT rather than a guess at D-12's numbers: zero months means
 * "no expiry", an empty threshold list means "no warnings", and the hard stop
 * is on. An unconfigured platform must not silently start expiring a
 * customer's credits on a schedule nobody chose. The approved values are
 * entered from Platform Admin (docs/PRODUCT.md §10A.5).
 */
export const INERT_CREDIT_POLICY: CreditPolicy = {
  hardStopAtZero: true,
  purchasedPackExpiryMonths: 0,
  promotionalExpiryMonths: 0,
  planGrantExpiryMonths: 0,
  lowBalanceThresholdPercents: [],
  reservationTimeoutSeconds: 900,
};

/**
 * Materialise the `credits` configuration document.
 *
 * ONE READER, because two readers are two answers. The Control Center had this
 * function inline and the scheduler needed the same values to expire grants and
 * grant allowances; a copy would have meant an operator could change a policy
 * and have the screens agree while the sweep went on using the old shape of it.
 *
 * ABSENT MEANS INERT, NEVER A GUESS. Every field falls back to
 * `INERT_CREDIT_POLICY`, so an unconfigured platform expires nothing and warns
 * about nothing rather than adopting numbers no owner approved (D-12).
 */
export function creditPolicyFrom(payload: Record<string, unknown>): CreditPolicy {
  const numberOr = (value: unknown, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  return {
    hardStopAtZero: payload['hardStopAtZero'] !== false,
    purchasedPackExpiryMonths: numberOr(
      payload['purchasedPackExpiryMonths'],
      INERT_CREDIT_POLICY.purchasedPackExpiryMonths,
    ),
    promotionalExpiryMonths: numberOr(
      payload['promotionalExpiryMonths'],
      INERT_CREDIT_POLICY.promotionalExpiryMonths,
    ),
    planGrantExpiryMonths: numberOr(
      payload['planGrantExpiryMonths'],
      INERT_CREDIT_POLICY.planGrantExpiryMonths,
    ),
    lowBalanceThresholdPercents: Array.isArray(payload['lowBalanceThresholdPercents'])
      ? (payload['lowBalanceThresholdPercents'] as number[]).filter(
          (percent) => typeof percent === 'number' && Number.isFinite(percent),
        )
      : INERT_CREDIT_POLICY.lowBalanceThresholdPercents,
    reservationTimeoutSeconds: numberOr(
      payload['reservationTimeoutSeconds'],
      INERT_CREDIT_POLICY.reservationTimeoutSeconds,
    ),
  };
}

export type CreditGrantSourceKey =
  | 'PLAN_GRANT'
  | 'TRIAL_GRANT'
  | 'PROMOTIONAL_GRANT'
  | 'PACK_PURCHASE'
  | 'ADMIN_ADJUSTMENT'
  | 'ROLLOVER';

/** One spendable bucket, as the allocator needs to see it. */
export interface AllocatableBucket {
  readonly id: string;
  /** Already net of anything reserved against it. */
  readonly spendableMilliCredits: bigint;
  /** null sorts last: a bucket that never expires is spent only when it must be. */
  readonly expiresAt: Date | null;
  readonly grantedAt: Date;
}

export interface Allocation {
  readonly grantId: string;
  readonly milliCredits: bigint;
}

export interface AllocationResult {
  readonly allocations: readonly Allocation[];
  /** How much of the request could NOT be covered. Zero means fully covered. */
  readonly shortfallMilliCredits: bigint;
}

/**
 * Order buckets the way D-12 requires: soonest expiry first.
 *
 * A bucket with no expiry sorts AFTER every dated one, however old. Spending a
 * never-expiring credit while a dated one is about to lapse would destroy value
 * the customer paid for, which is the whole point of FIFO-by-expiry — it is not
 * FIFO by grant date, and the two disagree exactly when it matters.
 *
 * Ties break on the older grant, then on id, so the order is total and the same
 * on every machine.
 */
export function fifoByExpiry(a: AllocatableBucket, b: AllocatableBucket): number {
  if (a.expiresAt === null && b.expiresAt !== null) return 1;
  if (a.expiresAt !== null && b.expiresAt === null) return -1;
  if (a.expiresAt !== null && b.expiresAt !== null) {
    const diff = a.expiresAt.getTime() - b.expiresAt.getTime();
    if (diff !== 0) return diff;
  }
  const granted = a.grantedAt.getTime() - b.grantedAt.getTime();
  if (granted !== 0) return granted;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Take `amount` from the buckets, soonest expiry first.
 *
 * Returns a shortfall rather than throwing: the caller decides whether an
 * uncovered request is a refusal (a reservation) or a partial sweep (expiry).
 * Buckets with nothing spendable are skipped rather than producing zero-value
 * allocations, which would otherwise litter the ledger.
 */
export function allocateFifo(
  buckets: readonly AllocatableBucket[],
  amountMilliCredits: bigint,
): AllocationResult {
  if (amountMilliCredits <= 0n) {
    return { allocations: [], shortfallMilliCredits: 0n };
  }

  const ordered = [...buckets].sort(fifoByExpiry);
  const allocations: Allocation[] = [];
  let outstanding = amountMilliCredits;

  for (const bucket of ordered) {
    if (outstanding <= 0n) break;
    const available = bucket.spendableMilliCredits;
    if (available <= 0n) continue;
    const take = available < outstanding ? available : outstanding;
    allocations.push({ grantId: bucket.id, milliCredits: take });
    outstanding -= take;
  }

  return { allocations, shortfallMilliCredits: outstanding };
}

/**
 * Reduce a frozen allocation to a smaller total, keeping FIFO order.
 *
 * Settlement almost always costs less than the estimate. The charge must come
 * off the SAME buckets the reservation froze, in the same order — re-running
 * FIFO against the current wallet would charge buckets the customer's other
 * requests have since consumed.
 */
export function narrowAllocation(
  allocations: readonly Allocation[],
  actualMilliCredits: bigint,
): readonly Allocation[] {
  if (actualMilliCredits <= 0n) return [];
  const narrowed: Allocation[] = [];
  let outstanding = actualMilliCredits;
  for (const allocation of allocations) {
    if (outstanding <= 0n) break;
    const take = allocation.milliCredits < outstanding ? allocation.milliCredits : outstanding;
    narrowed.push({ grantId: allocation.grantId, milliCredits: take });
    outstanding -= take;
  }
  return narrowed;
}

/** Total of an allocation list. */
export function allocationTotal(allocations: readonly Allocation[]): bigint {
  return allocations.reduce((sum, a) => sum + a.milliCredits, 0n);
}

export type RolloverPolicy = 'none' | 'capped' | 'full';

/**
 * How much of an unspent balance survives the cycle boundary.
 *
 * D-12 approved `capped` at one monthly allowance. Expressed as a multiplier so
 * the decision stays configuration: `capped × 1` is the approved rule, and
 * changing it later is an edit in Platform Admin, not a release.
 */
export function rolloverAmount(
  policy: RolloverPolicy,
  capMultiplier: number,
  monthlyAllowanceMilliCredits: bigint,
  carriedMilliCredits: bigint,
): bigint {
  if (carriedMilliCredits <= 0n) return 0n;
  if (policy === 'none') return 0n;
  if (policy === 'full') return carriedMilliCredits;

  // `capped`. A non-positive multiplier would silently mean "none", which the
  // configuration validator refuses precisely so it cannot arrive here.
  if (!(capMultiplier > 0)) return 0n;
  // Multiplier is a decimal (1, 1.5, 2). Scale through basis points so the
  // arithmetic stays exact in BigInt rather than routing through a float.
  const capBasisPoints = BigInt(Math.round(capMultiplier * 10_000));
  const cap = (monthlyAllowanceMilliCredits * capBasisPoints) / 10_000n;
  return carriedMilliCredits < cap ? carriedMilliCredits : cap;
}

/**
 * When a bucket from `source` expires, given the policy.
 *
 * Zero months means it never expires — the inert default, and the correct
 * reading of "the owner has not set an expiry" (D-12 sets 12 months for packs
 * and 3 for promotional; those values are entered, not assumed here).
 *
 * Month arithmetic clamps rather than overflowing: a pack bought on 31 January
 * with a one-month expiry lapses on 28 February, not 3 March.
 */
export function expiryFor(
  source: CreditGrantSourceKey,
  grantedAt: Date,
  policy: CreditPolicy,
): Date | null {
  const months =
    source === 'PACK_PURCHASE'
      ? policy.purchasedPackExpiryMonths
      : source === 'PROMOTIONAL_GRANT'
        ? policy.promotionalExpiryMonths
        : source === 'PLAN_GRANT' || source === 'ROLLOVER'
          ? policy.planGrantExpiryMonths
          : 0;

  if (months <= 0) return null;
  return addMonthsClamped(grantedAt, months);
}

/** Add whole months, clamping the day to the target month's length. */
export function addMonthsClamped(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();

  const targetMonthStart = Date.UTC(year, month + months, 1);
  const target = new Date(targetMonthStart);
  const daysInTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      Math.min(day, daysInTargetMonth),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * The threshold a wallet has just fallen through, or null.
 *
 * Returns the LOWEST unnotified threshold at or above the current percentage,
 * so a wallet that drops straight from 100% to 3% reports 5% rather than 20% —
 * the more urgent of the two — and reports it once. `alreadyNotifiedPercent`
 * stops a wallet hovering at a boundary from sending a notice per request,
 * which §12 calls out as nagging.
 */
export function lowBalanceCrossing(
  balanceMilliCredits: bigint,
  monthlyAllowanceMilliCredits: bigint,
  thresholdPercents: readonly number[],
  alreadyNotifiedPercent: number | null,
): number | null {
  if (monthlyAllowanceMilliCredits <= 0n) return null;
  if (thresholdPercents.length === 0) return null;

  const percent = Number((balanceMilliCredits * 100n) / monthlyAllowanceMilliCredits);

  // Ascending, so the first match is the lowest — the most urgent — band the
  // balance now sits inside.
  const candidates = [...thresholdPercents].sort((a, b) => a - b);
  for (const threshold of candidates) {
    if (percent > threshold) continue;
    if (alreadyNotifiedPercent !== null && threshold >= alreadyNotifiedPercent) continue;
    return threshold;
  }
  return null;
}

/** Whole credits, rounded DOWN. Never show more than is spendable. */
export function toWholeCredits(milliCredits: bigint): number {
  return Number(milliCredits / MILLI_PER_CREDIT);
}

/** Whole credits to milli-credits. */
export function toMilliCredits(credits: number): bigint {
  return BigInt(credits) * MILLI_PER_CREDIT;
}
