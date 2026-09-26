import { createHash } from 'node:crypto';
// The client TYPE comes from @brandspace/database, the only package permitted
// to import @prisma/client directly (docs/ARCHITECTURE.md §4.1).
import type { PrismaClient } from '@brandspace/database';
import {
  AppError,
  type Clock,
  createLogger,
  internalErrorFields,
  isProduction,
  systemClock,
} from '@brandspace/shared';

const log = createLogger({ context: { component: 'auth.rate-limit' } });

/**
 * Abuse ceilings for the authentication surface — F-19, open since Phase 2B.
 *
 * WHAT WAS MISSING, AND WHY THE LOCKOUT DID NOT COVER IT. Both realms lock an
 * ACCOUNT after ten failed attempts. That stops one address being ground down
 * and it stops nothing else: an attacker spreading three attempts each across a
 * thousand accounts never trips it, and an attacker who wants a known person
 * locked out simply fails ten times on purpose. Signup and password reset had
 * no ceiling at all — a probe against unmodified main issued twenty-five
 * password-reset tokens for one address in a loop, which is twenty-five emails
 * into somebody's inbox from one unauthenticated caller.
 *
 * SO THERE ARE TWO DIMENSIONS AND NEITHER SUBSUMES THE OTHER. Per-source stops
 * the spray; per-account stops the grind and the mail bombing. Both are counted
 * in one place, by one function, so a new surface cannot get one and forget the
 * other.
 *
 * IT LIVES IN THE SERVICES, NOT IN THE ROUTES. The customer product signs people
 * in through a Next.js server action, and the API has its own routes for the
 * same operations; before Phase 4 the two already disagreed about whether to
 * pass a source address. A ceiling enforced in one router is a ceiling the other
 * surface does not have, so `CustomerAuthService` and `SignupService` ask for it
 * themselves and every caller inherits it.
 *
 * FAIL CLOSED. If the counter cannot be written, the attempt is REFUSED. The
 * cost of that is nil in practice — every one of these operations needs the same
 * database one statement later, so a database that cannot count cannot
 * authenticate either — and the alternative is the failure mode docs/SECURITY.md
 * §19.1 names in as many words: rate limiting silently switching itself off.
 */

/** The dimensions that are counted. The string is the stored `scope`. */
export type RateLimitScope =
  | 'signin:ip'
  | 'signin:account'
  | 'signup:ip'
  | 'password-reset:ip'
  | 'password-reset:account'
  | 'verification-resend:ip'
  | 'mfa:ip'
  | 'mfa:account'
  /**
   * A password asked again inside a session before an irreversible action
   * (Phase 2B-1, D-328). Its OWN count, with the sign-in ceiling: sharing the
   * sign-in budget let ordinary sign-ins exhaust it, so an owner who had signed
   * in often could not confirm a deletion.
   */
  | 'step-up:account';

/**
 * The ceilings, as the activated `onboarding` document carries them.
 *
 * A STRUCTURAL TYPE, not an import of `OnboardingPolicy`: `@brandspace/auth`
 * must not depend on `@brandspace/onboarding` to know what a number is, and the
 * caller already holds the policy.
 */
export interface AbuseCeilings {
  readonly windowSeconds: number;
  readonly signInPerIp: number;
  readonly signInPerAccount: number;
  readonly signUpPerIp: number;
  readonly passwordResetPerIp: number;
  readonly passwordResetPerAccount: number;
  readonly verificationResendPerIp: number;
  readonly mfaPerIp: number;
  readonly mfaPerAccount: number;
}

/**
 * The ceilings used when no policy was supplied.
 *
 * NOT A SECOND SET OF PRODUCT LIMITS. It exists so a caller that has not yet
 * read configuration — a unit test, a development script — still gets a ceiling
 * rather than none, and the values are the same schema defaults the `onboarding`
 * domain declares. CLAUDE.md §2.2 permits a bootstrap fallback; what it forbids
 * is a number the owner cannot change, and every one of these is overridden the
 * moment a policy is passed.
 */
export const BOOTSTRAP_CEILINGS: AbuseCeilings = {
  windowSeconds: 300,
  signInPerIp: 30,
  signInPerAccount: 15,
  signUpPerIp: 10,
  passwordResetPerIp: 10,
  passwordResetPerAccount: 5,
  verificationResendPerIp: 10,
  mfaPerIp: 20,
  mfaPerAccount: 10,
};

/** The error every refusal raises, carrying the wait a caller must honour. */
export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number;
  readonly scope: RateLimitScope;

  constructor(scope: RateLimitScope, retryAfterSeconds: number) {
    /*
     * ONE MESSAGE FOR EVERY SCOPE, and it names no account. "Too many attempts
     * for THIS ADDRESS" would tell an attacker that the address is worth
     * attacking, which is the enumeration oracle the rest of this package is
     * built to avoid. Which dimension tripped is on the error for the audit
     * record and for the `Retry-After` header; it is not in the sentence.
     */
    super('RATE_LIMITED', 'Too many attempts. Please wait and try again.', {
      retryAfterSeconds,
    });
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.scope = scope;
  }
}

/** True for the error above, across package boundaries and re-throws. */
export function isRateLimited(error: unknown): error is RateLimitedError {
  return error instanceof AppError && error.code === 'RATE_LIMITED';
}

/**
 * The subject key.
 *
 * HASHED, ALWAYS. The limiter only ever asks whether two attempts belong
 * together, and equality of hashes answers that exactly as well as equality of
 * addresses. Storing the address itself would put a second copy of every
 * customer email — and of every visitor's IP — in a high-churn table that
 * nothing audits, for no gain.
 */
function subjectHash(scope: RateLimitScope, subject: string): string {
  return createHash('sha256').update(`${scope}\u0000${subject.trim().toLowerCase()}`).digest('hex');
}

/** The slice of the client this needs. Keeps the limiter testable with a stub. */
export interface RateLimitStore {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

export interface AuthRateLimiterOptions {
  readonly prisma: PrismaClient | RateLimitStore;
  readonly clock?: Clock;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly count: number;
  readonly limit: number;
  readonly retryAfterSeconds: number;
}

export class AuthRateLimiter {
  readonly #prisma: RateLimitStore;
  readonly #clock: Clock;

  constructor(options: AuthRateLimiterOptions) {
    this.#prisma = options.prisma as RateLimitStore;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Count one attempt and say whether it may proceed.
   *
   * ONE STATEMENT. The insert and the increment are the same statement, so two
   * concurrent attempts collide on the unique key and the loser becomes an
   * increment of the winner instead of a second row counting one. A read
   * followed by a write is the defect this shape exists to avoid, and it is the
   * same defect R-01 was.
   *
   * THE WINDOW IS FIXED, NOT SLIDING, and that is a deliberate trade. A sliding
   * window needs either a row per attempt or a second statement, and its only
   * advantage is smoothing the boundary — an attacker who times a burst across
   * one can send at most twice the ceiling in one window's width, which for
   * these numbers is still nothing like a usable brute force.
   */
  async record(
    scope: RateLimitScope,
    subject: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitDecision> {
    const now = this.#clock.now();
    const windowMs = Math.max(1, windowSeconds) * 1_000;
    // Aligned to the epoch, so every process agrees on where a window starts
    // without a shared clock beyond the one they already share.
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
    const windowEnd = new Date(windowStart.getTime() + windowMs);
    const hash = subjectHash(scope, subject);

    let count: number;
    try {
      const rows = await this.#prisma.$queryRaw<{ count: number }[]>`
        INSERT INTO "auth_rate_limit" ("id", "scope", "subjectHash", "windowStart", "windowEnd", "count")
        VALUES (gen_random_uuid(), ${scope}, ${hash}, ${windowStart}, ${windowEnd}, 1)
        ON CONFLICT ("scope", "subjectHash", "windowStart")
        DO UPDATE SET "count" = "auth_rate_limit"."count" + 1
        RETURNING "count"`;
      count = rows[0]?.count ?? 0;
    } catch (error: unknown) {
      /*
       * FAIL CLOSED — docs/SECURITY.md §19.1: what must never happen is rate
       * limiting silently switching itself off. Refusing costs nothing real
       * here: every caller needs this same database one statement later, so a
       * database that cannot count attempts cannot authenticate one either.
       *
       * The cause is logged, never returned: the caller gets the same refusal
       * an over-the-ceiling attempt gets, so an attacker cannot tell a broken
       * counter from a working one and go looking for ways to break it.
       */
      log.error('the authentication rate limiter could not record an attempt', {
        scope,
        ...internalErrorFields(error),
      });
      throw new RateLimitedError(scope, Math.ceil(windowMs / 1_000));
    }

    const retryAfterSeconds = Math.max(1, Math.ceil((windowEnd.getTime() - now.getTime()) / 1_000));
    return { allowed: count <= limit, count, limit, retryAfterSeconds };
  }

  /**
   * Count one attempt and THROW if it is over the ceiling.
   *
   * The form every caller wants: a limiter that has to be asked twice — once to
   * count and once to check — is a limiter somebody eventually only asks once.
   */
  async enforce(
    scope: RateLimitScope,
    subject: string | undefined,
    limit: number,
    windowSeconds: number,
  ): Promise<void> {
    /*
     * NO SUBJECT MEANS NO COUNT — but never in silence.
     *
     * The per-source dimension is skipped when the deployment cannot establish a
     * source address, which `requestContext` reports honestly rather than
     * inventing; the per-ACCOUNT dimension, which has a subject on every call,
     * still applies. Fabricating a constant subject instead would put every
     * caller in the world into one bucket and lock the product out, so the skip
     * is the right behaviour — and it is still a deployment DEFECT every time it
     * happens on a source dimension, because it means `TRUSTED_PROXY_HOPS` does
     * not describe the proxies actually in front of this process.
     *
     * IT IS LOGGED FOR EXACTLY THAT REASON. A rate limiter that quietly stops
     * counting looks identical to one that is working, which is how the
     * dashboard ran with no per-source ceiling at all and nothing said so.
     */
    if (subject === undefined || subject.trim() === '') {
      if (!scope.endsWith(':ip')) return;

      /*
       * IN PRODUCTION THIS IS A REFUSAL, NOT A SKIP.
       *
       * The invariant: an unauthenticated customer request in production either
       * has a trustworthy source identity that the limiter counts, or it is
       * refused. It must never proceed with no source budget at all — which is
       * precisely what a missing `CLIENT_ORIGIN_STRATEGY` produced, silently,
       * on every sign-in, signup, reset and MFA attempt.
       *
       * `assertClientOriginContract` should already have stopped the process
       * from starting, so reaching here in production means the contract was
       * satisfied at boot and the request still arrived with no usable origin —
       * a request that did not come through the declared edge. Refusing it is
       * the same fail-closed reasoning as an unwritable counter: the refusal is
       * generic, names nothing, and costs a caller who is where they should be
       * nothing at all.
       */
      if (isProduction()) {
        log.error('no source address could be established, so the request is refused', {
          scope,
          hint:
            'CLIENT_ORIGIN_STRATEGY must describe how this deployment establishes the client ' +
            'address; on Railway it is railway-edge.',
        });
        throw new RateLimitedError(scope, 60);
      }

      /*
       * OUTSIDE PRODUCTION IT IS A WARNING AND A SKIP. A developer on a laptop
       * has no proxy and no forwarded header, and refusing every local sign-in
       * would make the guard something people switch off. It is still logged,
       * because a limiter that quietly stops counting looks exactly like one
       * that is working.
       */
      log.warn('no source address could be established, so this dimension is not counted', {
        scope,
        hint: 'Set CLIENT_ORIGIN_STRATEGY (and TRUSTED_PROXY_HOPS under xff-hops).',
      });
      return;
    }
    const decision = await this.record(scope, subject, limit, windowSeconds);
    if (!decision.allowed) {
      throw new RateLimitedError(scope, decision.retryAfterSeconds);
    }
  }

  /** Discard windows that have closed. Bounded; safe to run repeatedly. */
  async purgeExpired(limit = 5_000): Promise<number> {
    const now = this.#clock.now();
    const rows = await this.#prisma.$queryRaw<{ deleted: bigint }[]>`
      WITH doomed AS (
        SELECT "id" FROM "auth_rate_limit" WHERE "windowEnd" <= ${now} LIMIT ${limit}
      )
      DELETE FROM "auth_rate_limit" USING doomed WHERE "auth_rate_limit"."id" = doomed."id"
      RETURNING 1 AS deleted`;
    return rows.length;
  }
}
