import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  recordAutomationEvent,
  writeAuditEvent,
  type AnalyticsIngestionCursor,
  type MetricGranularity,
  type MetricSubjectType,
  type PublishFailureClass,
  type SocialProvider,
  type TenantScopedClient,
} from '@brandspace/database';
import { ProviderRateLimiter } from '@brandspace/social-connectors';
import { systemClock, type Clock } from '@brandspace/shared';
import type { AdapterCredentials, AnalyticsConnectorAdapter, MetricReading } from './adapter';
import { findMetric, isIngestedMetric } from './metrics';
import { freshnessFor, nextAttemptAfterFailure, type AnalyticsPolicy } from './policy';
import { observationKeyFor, upsertObservations, type ObservationInput } from './observations';
import type { AnalyticsRegistry } from './registry';

/**
 * ANALYTICS INGESTION — the durable, idempotent, crash-tolerant half of Phase 7.
 *
 * THE SHAPE, AND WHY IT IS THIS SHAPE:
 *
 *   cursor (durable state)  ->  claim (conditional UPDATE)  ->  run (evidence)
 *                           ->  fetch  ->  upsert (ON CONFLICT)  ->  release
 *
 * EVERY STEP IS A DATABASE PRIMITIVE, not a code convention, because every
 * hazard this has to survive is a second writer:
 *
 *   - TWO SCHEDULERS AT ONCE. The claim is `UPDATE … WHERE nextAttemptAt <= now
 *     AND (claimedAt IS NULL OR claimedAt < lease)`, and the second scheduler's
 *     statement affects zero rows. There is no read-then-write anywhere on this
 *     path.
 *   - DUPLICATE QUEUE DELIVERY. The run's `idempotencyKey` is derived from
 *     (cursor, kind, window) and is UNIQUE per workspace, so the second delivery
 *     finds the run and stops. BullMQ's own job-id de-duplication is a second
 *     line, not the only one.
 *   - PROCESS DEATH AFTER THE PROVIDER ANSWERED. The claim has a LEASE. Past it
 *     the cursor is claimable again, the same window is re-fetched, and the
 *     upsert makes the re-fetch free. Nothing is lost and nothing is doubled.
 *   - PROVIDER TIMEOUT OR PARTIAL RESPONSE. A partial answer is KEPT — discarding
 *     the accounts that worked would make a partial outage look like a total one
 *     — and recorded as `PARTIAL` so the next pass knows to come back.
 *   - DELAYED AND OUT-OF-ORDER METRICS. The upsert refuses a reading older than
 *     the one it would replace, so a late redelivery cannot roll a figure back.
 *   - BACKFILL OVERLAPPING A SCHEDULED PULL. They are two runs over two windows
 *     writing through one conflict target. Overlap costs a few no-op updates and
 *     nothing else.
 *
 * INGESTION IS NOT AN AI OPERATION AND SPENDS NO CREDITS. Nothing in this file
 * touches the gateway, the wallet or the ledger — a customer is never billed AI
 * credits for a chart being refreshed.
 *
 * THE PROVIDER BUDGET IS SHARED WITH PUBLISHING. `ProviderRateLimiter` lives in
 * `social-connectors` precisely so a backfill cannot spend the allowance a
 * scheduled post needs; analytics reserves at the `analytics` priority and yields
 * when the window is nearly gone.
 */

export interface CredentialResolver {
  /**
   * Open the CUSTOMER's token for a connection.
   *
   * Injected rather than imported, and deliberately: only the worker and
   * `apps/api` hold the social key domain (D-136), so a surface that cannot
   * decrypt simply cannot be handed one of these.
   */
  resolve(socialConnectionId: string): Promise<AdapterCredentials | null>;
}

export interface IngestionOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: AnalyticsPolicy;
  readonly registry: AnalyticsRegistry;
  readonly credentials: CredentialResolver;
  readonly rateLimiter: ProviderRateLimiter;
  readonly clock?: Clock;
  /** Retry jitter. Injected so a test asserts a schedule, not a range. */
  readonly random?: () => number;
}

export interface PullResult {
  readonly cursorId: string;
  readonly runId: string | null;
  readonly status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'SKIPPED_RATE_LIMITED' | 'NOT_CLAIMED';
  readonly observationsWritten: number;
  readonly observationsUnchanged: number;
  readonly failureClass: PublishFailureClass | null;
}

/** A cursor shape narrow enough for a test to build without the whole row. */
type CursorRow = Pick<
  AnalyticsIngestionCursor,
  | 'id'
  | 'workspaceId'
  | 'brandId'
  | 'socialConnectionId'
  | 'provider'
  | 'subjectType'
  | 'granularity'
  | 'lastCoveredPeriodEnd'
  | 'lastSucceededAt'
  | 'backfillCursor'
  | 'backfillCompletedAt'
  | 'consecutiveFailureCount'
>;

const DAY_MS = 24 * 60 * 60 * 1_000;

/** The deterministic identity of one pull. Same window, same key, for ever. */
export function runIdempotencyKeyFor(input: {
  cursorId: string;
  kind: 'SCHEDULED' | 'BACKFILL' | 'MANUAL';
  windowStart: Date;
  windowEnd: Date;
}): string {
  return createHash('sha256')
    .update(
      [
        input.cursorId,
        input.kind,
        input.windowStart.toISOString(),
        input.windowEnd.toISOString(),
      ].join('|'),
    )
    .digest('hex');
}

export class AnalyticsIngestionService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: AnalyticsPolicy;
  readonly #registry: AnalyticsRegistry;
  readonly #credentials: CredentialResolver;
  readonly #rateLimiter: ProviderRateLimiter;
  readonly #clock: Clock;
  readonly #random: () => number;

  constructor(options: IngestionOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#registry = options.registry;
    this.#credentials = options.credentials;
    this.#rateLimiter = options.rateLimiter;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? Math.random;
  }

  /**
   * Make sure every ACTIVE connection has the cursors it needs.
   *
   * IDEMPOTENT BY `ON CONFLICT DO NOTHING`, the D-144 discipline: two callers
   * racing the same new connection each insert what they can and neither aborts
   * the other. A cursor that already exists is left exactly as it is — its
   * progress is the thing that must not be reset by a housekeeping pass.
   */
  async ensureCursors(): Promise<{ created: number }> {
    const connections = await this.#db.socialConnection.findMany({
      where: { workspaceId: this.#workspaceId, status: 'ACTIVE' },
      select: { id: true, brandId: true, provider: true },
    });

    const rows: Prisma.Sql[] = [];
    for (const connection of connections) {
      if (!this.#registry.has(connection.provider)) continue;
      const adapter = this.#registry.get(connection.provider);
      for (const subjectType of ['ACCOUNT', 'POST'] as const) {
        if (subjectType === 'POST' && !adapter.capabilities.supportsPostMetrics) continue;
        for (const granularity of adapter.capabilities.supportedGranularities) {
          // LIFETIME is a running total rather than a window, and a cursor that
          // walked it would walk nothing. It is fetched alongside the DAY pull.
          if (granularity === 'LIFETIME') continue;
          rows.push(Prisma.sql`(
            gen_random_uuid(), ${this.#workspaceId}::uuid, ${connection.brandId}::uuid,
            ${connection.id}::uuid, ${connection.provider}::"SocialProvider",
            ${subjectType}::"MetricSubjectType", ${granularity}::"MetricGranularity",
            'UNAVAILABLE'::"AnalyticsFreshness", now(), now(), now()
          )`);
        }
      }
    }
    if (rows.length === 0) return { created: 0 };

    const created = await this.#db.$executeRaw`
      INSERT INTO "analytics_ingestion_cursor" (
        "id", "workspaceId", "brandId", "socialConnectionId", "provider",
        "subjectType", "granularity", "freshness", "nextAttemptAt", "createdAt", "updatedAt"
      )
      VALUES ${Prisma.join(rows, ',')}
      ON CONFLICT ("workspaceId", "socialConnectionId", "subjectType", "granularity")
      DO NOTHING
    `;
    return { created };
  }

  /**
   * Claim up to `limit` cursors that are due.
   *
   * THE CONDITIONAL UPDATE IS THE WHOLE MECHANISM. Two schedulers issuing this
   * statement at the same instant cannot both claim a row: PostgreSQL serialises
   * the update and the loser's `WHERE` no longer matches. `RETURNING` gives the
   * winner exactly what it claimed, so there is no second read to race.
   *
   * PAST ITS LEASE A CLAIM IS TREATED AS ABANDONED — the D-143 idea, applied to
   * a read rather than to a send, which makes it far less dangerous: the worst a
   * wrongly recovered analytics claim can do is fetch a window twice, and the
   * upsert makes that free.
   */
  async claimDueCursors(limit: number): Promise<readonly CursorRow[]> {
    const now = this.#clock.now();
    const leaseCutoff = new Date(now.getTime() - this.#policy.ingestion.claimLeaseSeconds * 1_000);

    return this.#db.$queryRaw<CursorRow[]>`
      UPDATE "analytics_ingestion_cursor" SET
        "claimedAt"       = ${now}::timestamptz,
        "lastAttemptedAt" = ${now}::timestamptz,
        "updatedAt"       = now()
      WHERE "id" IN (
        SELECT "id" FROM "analytics_ingestion_cursor"
         WHERE "workspaceId" = ${this.#workspaceId}::uuid
           AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now}::timestamptz)
           AND ("claimedAt" IS NULL OR "claimedAt" < ${leaseCutoff}::timestamptz)
         ORDER BY "nextAttemptAt" ASC NULLS FIRST
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "workspaceId", "brandId", "socialConnectionId", "provider",
                "subjectType", "granularity", "lastCoveredPeriodEnd", "lastSucceededAt",
                "backfillCursor", "backfillCompletedAt", "consecutiveFailureCount"
    `;
  }

  /**
   * Pull one cursor's window. THE UNIT OF INGESTION.
   *
   * Safe to call twice with the same cursor: the run key de-duplicates, and the
   * observation upsert makes a genuine re-fetch a no-op.
   */
  async pull(cursor: CursorRow, kind: 'SCHEDULED' | 'BACKFILL' = 'SCHEDULED'): Promise<PullResult> {
    const window = this.#windowFor(cursor, kind);
    if (!window) {
      // Nothing left to do: backfill has reached its horizon. Release the claim
      // so the cursor is not held, and schedule the next ordinary pull.
      await this.#release(cursor, { succeeded: true, failure: null });
      return {
        cursorId: cursor.id,
        runId: null,
        status: 'SUCCEEDED',
        observationsWritten: 0,
        observationsUnchanged: 0,
        failureClass: null,
      };
    }

    const adapter = this.#registry.get(cursor.provider);

    const connection = await this.#db.socialConnection.findFirst({
      where: { id: cursor.socialConnectionId, workspaceId: this.#workspaceId },
      select: { id: true, externalAccountId: true, status: true, brandId: true },
    });
    if (!connection || connection.status !== 'ACTIVE') {
      await this.#release(cursor, { succeeded: false, failure: 'NOT_CONNECTED' });
      return {
        cursorId: cursor.id,
        runId: null,
        status: 'FAILED',
        observationsWritten: 0,
        observationsUnchanged: 0,
        failureClass: 'NOT_CONNECTED',
      };
    }

    /*
     * THE SHARED BUDGET, BEFORE ANYTHING ELSE. Reserved at the `analytics`
     * priority, so when the window is nearly spent this yields and the
     * publishing path does not. A refusal here is not a failure — it is a
     * deliberate wait — so it does not count toward the consecutive-failure
     * backoff and does not degrade the connection's health.
     */
    const budget = {
      requestsPerWindow: adapter.capabilities.requestsPerWindow,
      windowSeconds: adapter.capabilities.rateLimitWindowSeconds,
      analyticsReserveMilli: this.#policy.ingestion.publishingReserveMilli,
    };
    const rateKey = ProviderRateLimiter.keyFor(
      this.#workspaceId,
      cursor.provider,
      connection.externalAccountId,
    );
    const reservation = this.#rateLimiter.reserve({
      key: rateKey,
      budget,
      priority: 'analytics',
    });
    if (!reservation.allowed) {
      await this.#releaseRateLimited(cursor, reservation.retryAfterSeconds);
      return {
        cursorId: cursor.id,
        runId: null,
        status: 'SKIPPED_RATE_LIMITED',
        observationsWritten: 0,
        observationsUnchanged: 0,
        failureClass: null,
      };
    }

    /*
     * THE RUN ROW IS CREATED BEFORE THE PROVIDER IS CALLED, and its key is
     * derived from the window. A duplicate delivery of the same logical pull
     * collides here and stops, rather than reaching the provider twice.
     */
    const idempotencyKey = runIdempotencyKeyFor({
      cursorId: cursor.id,
      kind,
      windowStart: window.start,
      windowEnd: window.end,
    });
    const existingRun = await this.#db.analyticsIngestionRun.findFirst({
      where: { workspaceId: this.#workspaceId, idempotencyKey },
      select: { id: true, status: true, observationsWritten: true, observationsUnchanged: true },
    });
    if (existingRun && existingRun.status !== 'RUNNING') {
      await this.#release(cursor, {
        succeeded: true,
        failure: null,
        coveredTo: window.end,
        kind,
        backfillTo: window.start,
      });
      return {
        cursorId: cursor.id,
        runId: existingRun.id,
        status: existingRun.status === 'PARTIAL' ? 'PARTIAL' : 'SUCCEEDED',
        observationsWritten: existingRun.observationsWritten,
        observationsUnchanged: existingRun.observationsUnchanged,
        failureClass: null,
      };
    }

    const run =
      existingRun ??
      (await this.#db.analyticsIngestionRun.create({
        data: {
          workspaceId: this.#workspaceId,
          brandId: cursor.brandId,
          cursorId: cursor.id,
          socialConnectionId: cursor.socialConnectionId,
          provider: cursor.provider,
          kind,
          status: 'RUNNING',
          idempotencyKey,
          windowStart: window.start,
          windowEnd: window.end,
          startedAt: this.#clock.now(),
        },
        select: { id: true },
      }));

    const startedAtMs = this.#clock.now().getTime();

    const credentials = await this.#credentials.resolve(cursor.socialConnectionId);
    if (!credentials) {
      await this.#finishRun(run.id, {
        status: 'FAILED',
        failureClass: 'NOT_CONNECTED',
        failureCode: 'credential_unavailable',
        safeSummary: 'The stored authorization for this account could not be opened.',
        startedAtMs,
      });
      await this.#release(cursor, { succeeded: false, failure: 'NOT_CONNECTED' });
      return {
        cursorId: cursor.id,
        runId: run.id,
        status: 'FAILED',
        observationsWritten: 0,
        observationsUnchanged: 0,
        failureClass: 'NOT_CONNECTED',
      };
    }

    const subjects = await this.#subjectsFor(cursor, connection.externalAccountId, window);

    let outcome;
    try {
      outcome = await adapter.fetch({
        request: {
          externalAccountId: connection.externalAccountId,
          subjectType: cursor.subjectType,
          subjectExternalIds: subjects.map((s) => s.externalPostId),
          granularity: cursor.granularity,
          windowStart: window.start,
          windowEnd: window.end,
        },
        credentials,
      });
    } catch (error: unknown) {
      /*
       * AN ADAPTER THAT THREW IS A FAILED RUN, NOT A CRASHED PASS. The run is
       * closed with a class, the cursor is released with a backoff, and the next
       * pass reconciles. A `throw` escaping here would leave the claim held
       * until its lease expired and the run RUNNING for ever.
       */
      const failureClass = adapter.classifyError(error);
      await this.#finishRun(run.id, {
        status: 'FAILED',
        failureClass,
        failureCode: 'adapter_threw',
        safeSummary: 'The analytics request did not complete.',
        startedAtMs,
      });
      await this.#release(cursor, { succeeded: false, failure: failureClass });
      return {
        cursorId: cursor.id,
        runId: run.id,
        status: 'FAILED',
        observationsWritten: 0,
        observationsUnchanged: 0,
        failureClass,
      };
    }

    if (!outcome.ok) {
      if (outcome.failureClass === 'RATE_LIMITED') {
        // THE PLATFORM IS THE AUTHORITY. Whatever our own arithmetic believed,
        // the window is spent.
        this.#rateLimiter.markRefusedByProvider(rateKey, budget);
      }
      await this.#finishRun(run.id, {
        status: outcome.failureClass === 'RATE_LIMITED' ? 'SKIPPED_RATE_LIMITED' : 'FAILED',
        failureClass: outcome.failureClass,
        failureCode: outcome.failureCode,
        safeSummary: outcome.safeSummary,
        startedAtMs,
        ...(outcome.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: outcome.retryAfterSeconds }),
      });
      if (outcome.failureClass === 'RATE_LIMITED') {
        await this.#releaseRateLimited(cursor, outcome.retryAfterSeconds ?? 120);
        return {
          cursorId: cursor.id,
          runId: run.id,
          status: 'SKIPPED_RATE_LIMITED',
          observationsWritten: 0,
          observationsUnchanged: 0,
          failureClass: 'RATE_LIMITED',
        };
      }
      await this.#release(cursor, { succeeded: false, failure: outcome.failureClass });
      await this.#recordConnectionFailure(cursor.socialConnectionId, outcome.failureClass);
      return {
        cursorId: cursor.id,
        runId: run.id,
        status: 'FAILED',
        observationsWritten: 0,
        observationsUnchanged: 0,
        failureClass: outcome.failureClass,
      };
    }

    const byExternalId = new Map(subjects.map((s) => [s.externalPostId, s]));
    const observations = normalizeReadings({
      readings: outcome.readings,
      adapter,
      workspaceId: this.#workspaceId,
      brandId: cursor.brandId,
      socialConnectionId: cursor.socialConnectionId,
      provider: cursor.provider,
      runId: run.id,
      resolveSubject: (externalId) => byExternalId.get(externalId) ?? null,
    });

    const upsert = await upsertObservations(this.#db, this.#workspaceId, observations);

    await this.#finishRun(run.id, {
      status: outcome.partial ? 'PARTIAL' : 'SUCCEEDED',
      failureClass: null,
      failureCode: null,
      safeSummary: null,
      startedAtMs,
      subjectsRequested: outcome.subjectsRequested,
      subjectsAnswered: outcome.subjectsAnswered,
      observationsWritten: upsert.written,
      observationsUnchanged: upsert.unchanged,
    });

    await this.#release(cursor, {
      succeeded: true,
      failure: null,
      coveredTo: window.end,
      kind,
      backfillTo: window.start,
    });

    return {
      cursorId: cursor.id,
      runId: run.id,
      status: outcome.partial ? 'PARTIAL' : 'SUCCEEDED',
      observationsWritten: upsert.written,
      observationsUnchanged: upsert.unchanged,
      failureClass: null,
    };
  }

  /**
   * Which window this pull asks for.
   *
   * A SCHEDULED PULL RE-ASKS A TRAILING WINDOW rather than only asking for what
   * is new. Platforms revise recent figures for days; a cursor that only moved
   * forward would freeze the first, lowest reading of every day for ever, and a
   * customer would see performance that never improved after the first hour.
   * Re-asking is what lets a revision land, and the idempotent upsert is what
   * makes re-asking cost nothing.
   *
   * A BACKFILL WALKS BACKWARDS, bounded twice: by the activated policy and by
   * the adapter's own `maxBackfillDays`, whichever is tighter. `null` means the
   * horizon has been reached and there is nothing left to fetch.
   */
  #windowFor(cursor: CursorRow, kind: 'SCHEDULED' | 'BACKFILL'): { start: Date; end: Date } | null {
    const now = this.#clock.now();

    if (kind === 'SCHEDULED') {
      const start = new Date(now.getTime() - this.#policy.ingestion.refreshWindowDays * DAY_MS);
      return { start: startOfDay(start), end: now };
    }

    if (!this.#policy.backfill.enabled || cursor.backfillCompletedAt) return null;

    const adapter = this.#registry.get(cursor.provider);
    const horizonDays = Math.min(
      this.#policy.backfill.maxDays,
      adapter.capabilities.maxBackfillDays,
    );
    const horizon = startOfDay(new Date(now.getTime() - horizonDays * DAY_MS));

    const end =
      cursor.backfillCursor ??
      startOfDay(new Date(now.getTime() - this.#policy.ingestion.refreshWindowDays * DAY_MS));
    if (end.getTime() <= horizon.getTime()) return null;

    const start = new Date(
      Math.max(horizon.getTime(), end.getTime() - this.#policy.backfill.daysPerPass * DAY_MS),
    );
    return { start, end };
  }

  /**
   * Which posts to ask about.
   *
   * ONLY POSTS THIS WORKSPACE ACTUALLY PUBLISHED, read through RLS, so the set of
   * subjects is a tenant-scoped query result rather than anything a caller
   * supplies. There is no path by which a foreign external id reaches a provider
   * request on this workspace's token.
   */
  async #subjectsFor(
    cursor: CursorRow,
    externalAccountId: string,
    window: { start: Date; end: Date },
  ): Promise<readonly { externalPostId: string; publishJobId: string; contentItemId: string }[]> {
    if (cursor.subjectType === 'ACCOUNT') {
      return [{ externalPostId: externalAccountId, publishJobId: '', contentItemId: '' }];
    }
    const jobs = await this.#db.publishJob.findMany({
      where: {
        workspaceId: this.#workspaceId,
        socialConnectionId: cursor.socialConnectionId,
        status: 'PUBLISHED',
        externalPostId: { not: null },
        publishedAt: { gte: new Date(window.start.getTime() - 30 * DAY_MS) },
      },
      orderBy: { publishedAt: 'desc' },
      take: this.#policy.ingestion.subjectsPerRequest,
      select: { id: true, externalPostId: true, contentItemId: true },
    });
    return jobs.flatMap((job) =>
      job.externalPostId
        ? [
            {
              externalPostId: job.externalPostId,
              publishJobId: job.id,
              contentItemId: job.contentItemId,
            },
          ]
        : [],
    );
  }

  /** Close a run and stamp its counters. The trigger allows this exactly once. */
  async #finishRun(
    runId: string,
    input: {
      status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'SKIPPED_RATE_LIMITED';
      failureClass: PublishFailureClass | null;
      failureCode: string | null;
      safeSummary: string | null;
      startedAtMs: number;
      retryAfterSeconds?: number;
      subjectsRequested?: number;
      subjectsAnswered?: number;
      observationsWritten?: number;
      observationsUnchanged?: number;
    },
  ): Promise<void> {
    const finishedAt = this.#clock.now();
    const finished = await this.#db.analyticsIngestionRun.update({
      where: { id: runId },
      data: {
        status: input.status,
        finishedAt,
        durationMs: Math.max(0, finishedAt.getTime() - input.startedAtMs),
        failureClass: input.failureClass,
        failureCode: input.failureCode,
        // Bounded here as well as by the CHECK, so an over-long summary is
        // truncated rather than raising an exception that hides the real failure.
        safeSummary: input.safeSummary ? input.safeSummary.slice(0, 500) : null,
        ...(input.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: input.retryAfterSeconds }),
        subjectsRequested: input.subjectsRequested ?? 0,
        subjectsAnswered: input.subjectsAnswered ?? 0,
        observationsWritten: input.observationsWritten ?? 0,
        observationsUnchanged: input.observationsUnchanged ?? 0,
      },
    });

    /*
     * THE AUTOMATION EVENT (A1). `ANALYTICS_REFRESHED` had no producer.
     *
     * "REFRESHED" MEANS NEW DATA LANDED, and that is a deliberate reading rather
     * than a loose one. A cursor is polled on a cadence, and most polls answer
     * "nothing has changed since last time" — firing every listening rule on
     * each of those would make the trigger a metronome, and a customer whose
     * rule notified them hourly about no new numbers would turn it off within a
     * day and never trust another one.
     *
     * A FAILED or RATE-LIMITED run is not a refresh either: nothing was read, so
     * there is nothing to react to. `PARTIAL` counts, because the observations it
     * did write are real.
     */
    const refreshed =
      (input.status === 'SUCCEEDED' || input.status === 'PARTIAL') &&
      (input.observationsWritten ?? 0) > 0;
    if (refreshed) {
      await recordAutomationEvent(
        this.#db,
        this.#workspaceId,
        { triggerType: 'ANALYTICS_REFRESHED', refType: 'AnalyticsIngestionRun' },
        { brandId: finished.brandId, refId: finished.id },
      );
    }
  }

  /**
   * Release the claim and schedule the next attempt.
   *
   * THE CLAIM IS ALWAYS RELEASED, on every path out of `pull` — success,
   * provider failure, adapter exception, missing credential. A claim left held is
   * a cursor that stops being fetched until its lease expires, which is a silent
   * stall of exactly the kind D-143 was written about.
   */
  async #release(
    cursor: CursorRow,
    input: {
      succeeded: boolean;
      failure: PublishFailureClass | null;
      coveredTo?: Date;
      kind?: 'SCHEDULED' | 'BACKFILL';
      backfillTo?: Date;
    },
  ): Promise<void> {
    const now = this.#clock.now();

    if (!input.succeeded) {
      const failures = cursor.consecutiveFailureCount + 1;
      await this.#db.analyticsIngestionCursor.update({
        where: { id: cursor.id },
        data: {
          claimedAt: null,
          consecutiveFailureCount: failures,
          lastFailureClass: input.failure,
          nextAttemptAt: nextAttemptAfterFailure(this.#policy, failures, this.#clock, this.#random),
          // A FAILED PULL DOES NOT CHANGE FRESHNESS DOWNWARD BY ITSELF. Freshness
          // is about when we last SUCCEEDED, so it is recomputed from that — a
          // connection that failed once is not suddenly stale if it succeeded
          // ten minutes ago.
          freshness: freshnessFor(this.#policy, cursor.lastSucceededAt, this.#clock),
        },
      });
      return;
    }

    const intervalMinutes =
      cursor.granularity === 'HOUR'
        ? this.#policy.ingestion.hourlyIntervalMinutes
        : this.#policy.ingestion.dailyIntervalMinutes;

    const backfillFields =
      input.kind === 'BACKFILL' && input.backfillTo
        ? {
            backfillCursor: input.backfillTo,
            ...(this.#backfillIsComplete(cursor, input.backfillTo)
              ? { backfillCompletedAt: now }
              : {}),
          }
        : {};

    await this.#db.analyticsIngestionCursor.update({
      where: { id: cursor.id },
      data: {
        claimedAt: null,
        consecutiveFailureCount: 0,
        lastFailureClass: null,
        lastFailureCode: null,
        lastSucceededAt: now,
        ...(input.coveredTo ? { lastCoveredPeriodEnd: input.coveredTo } : {}),
        ...backfillFields,
        nextAttemptAt: new Date(now.getTime() + intervalMinutes * 60_000),
        freshness: freshnessFor(this.#policy, now, this.#clock),
      },
    });
  }

  #backfillIsComplete(cursor: CursorRow, reachedBack: Date): boolean {
    const adapter = this.#registry.get(cursor.provider);
    const horizonDays = Math.min(
      this.#policy.backfill.maxDays,
      adapter.capabilities.maxBackfillDays,
    );
    const horizon = startOfDay(new Date(this.#clock.now().getTime() - horizonDays * DAY_MS));
    return reachedBack.getTime() <= horizon.getTime();
  }

  /**
   * A rate-limited pass is a WAIT, not a failure.
   *
   * The consecutive-failure counter is untouched, the connection's health is
   * untouched, and the freshness stays whatever the last success earned. Treating
   * politeness as failure would back a busy account off exponentially until it
   * stopped being fetched at all.
   */
  async #releaseRateLimited(cursor: CursorRow, retryAfterSeconds: number): Promise<void> {
    await this.#db.analyticsIngestionCursor.update({
      where: { id: cursor.id },
      data: {
        claimedAt: null,
        nextAttemptAt: new Date(this.#clock.now().getTime() + retryAfterSeconds * 1_000),
        freshness: freshnessFor(this.#policy, cursor.lastSucceededAt, this.#clock),
      },
    });
  }

  /**
   * An auth failure on the analytics path is a fact about the CONNECTION.
   *
   * The publishing pipeline already records connection health; ingestion must
   * feed the same record rather than keeping a private opinion, or the
   * integrations screen would say a connection is healthy while every chart on
   * it was failing.
   */
  async #recordConnectionFailure(
    socialConnectionId: string,
    failureClass: PublishFailureClass,
  ): Promise<void> {
    const needsReauth = failureClass === 'AUTH_EXPIRED' || failureClass === 'INSUFFICIENT_SCOPE';
    await this.#db.socialConnection.updateMany({
      where: { id: socialConnectionId, workspaceId: this.#workspaceId },
      data: {
        lastCheckedAt: this.#clock.now(),
        lastFailureClass: failureClass,
        consecutiveFailureCount: { increment: 1 },
        ...(needsReauth ? { status: 'NEEDS_REAUTH' } : {}),
        ...(failureClass === 'AUTH_REVOKED'
          ? { status: 'REVOKED', revokedAt: this.#clock.now() }
          : {}),
      },
    });

    if (needsReauth || failureClass === 'AUTH_REVOKED') {
      await writeAuditEvent(this.#db, this.#workspaceId, {
        action: 'analytics.connection_unhealthy',
        actorType: 'SYSTEM',
        resourceType: 'SocialConnection',
        resourceId: socialConnectionId,
        severity: 'WARNING',
        outcome: 'ERROR',
        // The CLASS, never a provider message — which routinely echoes content.
        after: { failureClass },
      });
    }
  }
}

/** Midnight UTC of the given instant. Window boundaries are days, not moments. */
export function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Turn what an adapter returned into rows this platform will store.
 *
 * THE VALIDATION HERE IS THE SECOND HALF OF THE CAPABILITY CONTRACT. An adapter
 * declares `supportedMetrics`; this refuses anything outside that declaration,
 * anything outside the canonical vocabulary, and anything derived. Without it, a
 * mistaken adapter could introduce a metric the product has no definition for —
 * no unit, no additivity rule, no idea whether summing it means anything — and
 * it would flow all the way to a chart.
 *
 * A DERIVED METRIC IS NEVER STORED. `engagement_rate` is recomputed at query time
 * from observations a provider actually returned, so it cannot outlive its
 * components or disagree with them.
 */
export function normalizeReadings(input: {
  readings: readonly MetricReading[];
  adapter: AnalyticsConnectorAdapter;
  workspaceId: string;
  brandId: string;
  socialConnectionId: string;
  provider: SocialProvider;
  runId: string | null;
  resolveSubject: (externalId: string) => { publishJobId: string; contentItemId: string } | null;
}): readonly ObservationInput[] {
  const supported = new Set(input.adapter.capabilities.supportedMetrics);
  const out: ObservationInput[] = [];

  for (const reading of input.readings) {
    if (!supported.has(reading.metricKey)) continue;
    if (!isIngestedMetric(reading.metricKey)) continue;

    const definition = findMetric(reading.metricKey);
    /* c8 ignore next -- isIngestedMetric already proved the key exists. */
    if (!definition) continue;
    // The UNIT IS THE CATALOGUE'S, not the adapter's. An adapter that disagrees
    // has a mapping bug, and storing its opinion would make the same metric mean
    // two things on two platforms.
    if (reading.unit !== definition.unit) continue;
    if (reading.periodEnd < reading.periodStart) continue;

    const subject =
      reading.subjectType === 'POST' ? input.resolveSubject(reading.subjectExternalId) : null;

    /*
     * A POST READING WE CANNOT TIE TO ONE OF OUR OWN PUBLISHED POSTS IS
     * DISCARDED. The customer may well have posted it from the platform's own
     * app, and we have no content row for it; keeping it would put a figure on a
     * brand analytics page that no BrandSpace content produced, which is a
     * different claim from the one the page makes.
     */
    if (reading.subjectType === 'POST' && !subject) continue;

    out.push({
      workspaceId: input.workspaceId,
      brandId: input.brandId,
      socialConnectionId: input.socialConnectionId,
      provider: input.provider,
      subjectType: reading.subjectType,
      subjectExternalId: reading.subjectExternalId,
      publishJobId: subject?.publishJobId || null,
      contentItemId: subject?.contentItemId || null,
      metricKey: reading.metricKey,
      granularity: reading.granularity,
      periodStart: reading.periodStart,
      periodEnd: reading.periodEnd,
      value: reading.value,
      unit: definition.unit,
      observedAt: reading.observedAt,
      sourceKind: input.adapter.sourceKind,
      sourceVersion: input.adapter.sourceVersion,
      ingestionRunId: input.runId,
    });
  }
  return out;
}

/** Re-export so callers do not reach past this module for the key function. */
export { observationKeyFor };

/** A correlation id for one ingestion pass. Joins run, log line and audit event. */
export function newCorrelationId(): string {
  return randomUUID();
}

/** Narrowing helper used by the scheduler and the worker. */
export type { CursorRow as IngestionCursorRow };
export type { MetricSubjectType, MetricGranularity };
