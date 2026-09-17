import type { SocialProvider } from '@brandspace/database';
import type { Clock } from '@brandspace/shared';

/**
 * THE SHARED PROVIDER REQUEST BUDGET.
 *
 * WHY THIS LIVES IN `social-connectors` RATHER THAN IN `analytics`. A platform's
 * rate limit is a property of OUR RELATIONSHIP WITH THAT PLATFORM, not of any
 * one feature that talks to it. Publishing and analytics ingestion draw on the
 * SAME budget: a backfill that spends the hour's allowance is a backfill that
 * makes a scheduled post fail with `RATE_LIMITED`, and a customer whose post did
 * not go out because a chart was being refreshed has been failed by an
 * architectural decision, not by a platform.
 *
 * So the budget is owned by the package that owns the provider relationship, and
 * analytics imports it. Two counters would be two budgets, and the provider only
 * ever had one.
 *
 * THE RESERVATION IS COARSE AND DELIBERATELY CONSERVATIVE. This is an in-process
 * token bucket per (workspace, provider, account): it is a POLITENESS mechanism
 * that keeps our own two subsystems from fighting, not a guarantee about what a
 * platform will accept — only the platform can make that guarantee, and when it
 * refuses, `RATE_LIMITED` with its `retryAfterSeconds` is the authority.
 *
 * PUBLISHING WINS TIES. `priority` exists for one reason: when the budget is
 * nearly spent, a post that a person scheduled for 09:00 matters more than a
 * chart that will be equally true in an hour. Analytics yields; publishing does
 * not.
 */

export type RateLimitPriority = 'publishing' | 'analytics';

export interface ProviderBudget {
  readonly requestsPerWindow: number;
  readonly windowSeconds: number;
  /**
   * The share of the window's budget analytics may spend, in parts per mille.
   * Below this remaining fraction, analytics is refused and publishing is not.
   */
  readonly analyticsReserveMilli: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** When to come back, when refused. Never negative. */
  readonly retryAfterSeconds: number;
  /** Requests still available in the current window. */
  readonly remaining: number;
}

interface BucketState {
  windowStartedAtMs: number;
  spent: number;
}

/**
 * A per-process budget keeper.
 *
 * IN-PROCESS ON PURPOSE, AND SAID SO PLAINLY. A distributed limiter would need
 * Redis and would still not be authoritative — the platform is. What this
 * prevents is the failure mode we can actually prevent: our own backfill
 * starving our own publisher inside one worker. Across processes, each keeps its
 * own share, which is conservative in the right direction.
 */
export class ProviderRateLimiter {
  readonly #buckets = new Map<string, BucketState>();
  readonly #clock: Clock;

  constructor(options: { clock: Clock }) {
    this.#clock = options.clock;
  }

  /** The key a budget is kept per. One account's limit is its own. */
  static keyFor(workspaceId: string, provider: SocialProvider, externalAccountId: string): string {
    return `${workspaceId}:${provider}:${externalAccountId}`;
  }

  /**
   * Take `cost` requests from the budget, or refuse.
   *
   * THE CHECK AND THE TAKE ARE ONE CALL. A separate `canSpend()` followed by a
   * `spend()` is a check-then-act, and two callers between them is exactly the
   * race the whole mechanism exists to prevent.
   */
  reserve(input: {
    readonly key: string;
    readonly budget: ProviderBudget;
    readonly priority: RateLimitPriority;
    readonly cost?: number;
  }): RateLimitDecision {
    const cost = input.cost ?? 1;
    const nowMs = this.#clock.now().getTime();
    const windowMs = input.budget.windowSeconds * 1_000;

    let bucket = this.#buckets.get(input.key);
    if (!bucket || nowMs - bucket.windowStartedAtMs >= windowMs) {
      bucket = { windowStartedAtMs: nowMs, spent: 0 };
      this.#buckets.set(input.key, bucket);
    }

    const total = input.budget.requestsPerWindow;
    const remainingBefore = Math.max(0, total - bucket.spent);

    /*
     * THE RESERVE. Analytics may not spend the last slice of the window; a
     * scheduled post may. The floor is expressed in parts per mille for the same
     * reason every other ratio in this platform is: integers all the way down.
     */
    const floor =
      input.priority === 'analytics'
        ? Math.ceil((total * input.budget.analyticsReserveMilli) / 1_000)
        : 0;

    if (remainingBefore - cost < floor) {
      const elapsedMs = nowMs - bucket.windowStartedAtMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsedMs) / 1_000)),
        remaining: remainingBefore,
      };
    }

    bucket.spent += cost;
    return { allowed: true, retryAfterSeconds: 0, remaining: Math.max(0, total - bucket.spent) };
  }

  /**
   * Record that the PROVIDER refused us, whatever our own arithmetic said.
   *
   * The platform is the authority. When it says `RATE_LIMITED`, the window is
   * treated as spent so our own optimism cannot immediately try again.
   */
  markRefusedByProvider(key: string, budget: ProviderBudget): void {
    this.#buckets.set(key, {
      windowStartedAtMs: this.#clock.now().getTime(),
      spent: budget.requestsPerWindow,
    });
  }

  /** Testing and shutdown. Never called on a request path. */
  reset(): void {
    this.#buckets.clear();
  }
}
