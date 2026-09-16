import { createHash } from 'node:crypto';
import {
  writeAuditEvent,
  type PublishFailureClass,
  type PublishJob,
  type SocialProvider,
  type TenantScopedClient,
} from '@brandspace/database';
import { brandIdQueryFilter, systemClock, type Clock } from '@brandspace/shared';
import type { AdapterCredentials, PublishOutcome } from './adapter';
import {
  FAILURE_BEHAVIOUR,
  publishJobNotCancellable,
  publishJobNotFound,
  publishJobNotRetryable,
} from './errors';
import { capabilitiesFor, PROVIDER_CONFIG_KEYS, type PublishingPolicy } from './policy';
import type { ConnectorRegistry } from './registry';
import type { SocialTokenVault } from './token-vault';

/**
 * The publishing pipeline — docs/SOCIAL-INTEGRATIONS.md §7.
 *
 * THE ONE RULE EVERYTHING ELSE SERVES: a customer's post goes out ONCE, or not
 * at all, and they can always tell which. Every design choice below is in
 * service of that and is worth stating, because each of them looks like
 * overhead until the day it is the only thing that helps.
 *
 *   - THE UNIT IS (slot, connection, variant), not the slot. One platform
 *     rejecting a caption must not fail the others, and a retry must retry only
 *     what failed.
 *   - THE IDEMPOTENCY KEY IS DERIVED, NOT GENERATED. It is a hash of the four
 *     ids, so the sweeper racing the producer, a duplicate queue delivery, and
 *     two workers waking together all compute the SAME key and collide on a
 *     unique index instead of creating a second job.
 *   - A JOB IS CLAIMED WITH A CONDITIONAL UPDATE. `updateMany` with the prior
 *     status in the predicate is atomic; a read-then-write leaves a window two
 *     workers fit through.
 *   - AN UNCERTAIN OUTCOME IS NEVER RETRIED. A timeout means the request left
 *     and the answer did not come back — the post may be live. The job goes to
 *     VERIFICATION_PENDING and we ASK. Where a provider cannot be asked
 *     (`supportsPostLookup: false`), we stop and tell the customer, because a
 *     duplicate post is worse than a missing one.
 *   - APPROVAL IS CHECKED AGAIN HERE. Not because the calendar did not check
 *     it, but because approval can be withdrawn in between, and the gate that
 *     matters is the one immediately before the external call
 *     (docs/SOCIAL-INTEGRATIONS.md §6.2).
 */

/**
 * The single question this pipeline asks the Approvals module.
 *
 * AN INTERFACE THE CALLER INJECTS, exactly as `ContentCalendarService` takes
 * `ApprovalGate`. A package dependency on `@brandspace/content` would buy the
 * same answer and a cycle risk.
 */
export interface PublishApprovalGate {
  /** Does this brand require approval before anything of its goes out? */
  policyForBrand(brandId: string): Promise<{ requireApprovalBeforeScheduling: boolean }>;
  /** The live approval for an item, if a cycle is open or was decided. */
  openForItem(itemId: string): Promise<{ status: string } | null>;
}

/**
 * Who hears about a publish.
 *
 * AN INTERFACE THE CALLER INJECTS, for the same reason the approval gate is
 * one: `@brandspace/notifications` is not on this package's import list, and
 * more importantly WHO may be told is an authorization question that belongs
 * where the other authorization lives. A notification says that content exists,
 * in that brand, and what happened to it — a member restricted to another brand
 * must not receive it.
 *
 * OPTIONAL, because the sweep that materialises jobs has nothing to announce
 * and should not be forced to construct one.
 */
export interface PublishNotifier {
  published(input: {
    jobId: string;
    contentItemId: string;
    brandId: string;
    provider: SocialProvider;
    notifyUserId: string | null;
    externalPostUrl: string | null;
  }): Promise<void>;
  failed(input: {
    jobId: string;
    contentItemId: string;
    brandId: string;
    provider: SocialProvider;
    notifyUserId: string | null;
    failureClass: PublishFailureClass;
    needsReconnect: boolean;
  }): Promise<void>;
}

export interface PublishPipelineOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: PublishingPolicy;
  readonly registry: ConnectorRegistry;
  readonly vault: SocialTokenVault;
  readonly approvals: PublishApprovalGate;
  readonly notifier?: PublishNotifier | undefined;
  readonly clock?: Clock;
}

/** What a materialisation pass produced. Counts, never ids, for logging. */
export interface MaterialiseResult {
  readonly slotId: string;
  readonly created: number;
  readonly existing: number;
  readonly skipped: number;
  readonly skipReason: string | null;
}

export interface ExecuteResult {
  readonly jobId: string;
  readonly status: PublishJob['status'];
  readonly failureClass: PublishFailureClass | null;
  readonly externalPostId: string | null;
}

/** The provider a content platform key publishes through. */
const PLATFORM_KEY_TO_PROVIDER: Record<string, SocialProvider> = Object.fromEntries(
  Object.entries(PROVIDER_CONFIG_KEYS).map(([provider, key]) => [key, provider as SocialProvider]),
) as Record<string, SocialProvider>;

export function providerForPlatformKey(platformKey: string): SocialProvider | null {
  return PLATFORM_KEY_TO_PROVIDER[platformKey.toLowerCase()] ?? null;
}

/**
 * The idempotency key.
 *
 * DERIVED FROM THE FOUR IDS AND NOTHING ELSE — no clock, no counter, no random
 * component. That is what makes it the same on every path that could ever
 * create this job, which is the entire mechanism preventing a duplicate post.
 */
export function publishIdempotencyKey(input: {
  workspaceId: string;
  calendarSlotId: string;
  socialConnectionId: string;
  contentVariantId: string;
}): string {
  return createHash('sha256')
    .update(
      [
        input.workspaceId,
        input.calendarSlotId,
        input.socialConnectionId,
        input.contentVariantId,
      ].join('|'),
    )
    .digest('hex');
}

export class PublishPipelineService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: PublishingPolicy;
  readonly #registry: ConnectorRegistry;
  readonly #vault: SocialTokenVault;
  readonly #approvals: PublishApprovalGate;
  readonly #notifier: PublishNotifier | undefined;
  readonly #clock: Clock;

  constructor(options: PublishPipelineOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#registry = options.registry;
    this.#vault = options.vault;
    this.#approvals = options.approvals;
    this.#notifier = options.notifier;
    this.#clock = options.clock ?? systemClock;
  }

  // -------------------------------------------------------------------------
  // Materialisation: a due slot becomes jobs.
  // -------------------------------------------------------------------------

  /**
   * Turn one due calendar slot into publish jobs.
   *
   * IDEMPOTENT BY CONSTRUCTION. Called twice — by the sweeper and by a retry —
   * the second pass computes the same keys, collides, and reports them as
   * `existing`. Nothing is created twice and nothing is lost.
   *
   * THE APPROVAL GATE RUNS HERE AND AGAIN AT DISPATCH. An item still in review
   * never produces a job at all, which is the first of the two places
   * docs/SOCIAL-INTEGRATIONS.md §6.2 requires it to be checked.
   */
  async materialiseSlot(slotId: string): Promise<MaterialiseResult> {
    const slot = await this.#db.calendarSlot.findFirst({
      where: { id: slotId, workspaceId: this.#workspaceId },
    });
    if (!slot) throw publishJobNotFound();

    const empty = (reason: string): MaterialiseResult => ({
      slotId,
      created: 0,
      existing: 0,
      skipped: 1,
      skipReason: reason,
    });

    if (slot.status !== 'SCHEDULED') return empty('slot_not_scheduled');

    const item = await this.#db.contentItem.findFirst({
      where: { id: slot.contentItemId, workspaceId: this.#workspaceId },
    });
    if (!item || item.deletedAt) return empty('item_missing');

    /*
     * IN_REVIEW CONTENT CAN NEVER PUBLISH — a hard rule, checked against the
     * ITEM's own state rather than inferred from the slot's. The two are kept
     * in step deliberately, and a rule that relies on them being in step would
     * fail exactly when they are not.
     */
    if (item.status === 'IN_REVIEW' || item.status === 'CHANGES_REQUESTED') {
      return empty('awaiting_review');
    }

    const gate = await this.#approvals.policyForBrand(slot.brandId);
    if (gate.requireApprovalBeforeScheduling) {
      const approval = await this.#approvals.openForItem(item.id);
      if (!approval || approval.status !== 'APPROVED') return empty('approval_required');
    }

    const connections = await this.#db.socialConnection.findMany({
      where: { workspaceId: this.#workspaceId, brandId: slot.brandId, status: 'ACTIVE' },
      orderBy: [{ provider: 'asc' }, { id: 'asc' }],
    });
    if (connections.length === 0) return empty('no_active_connection');

    const variants = await this.#db.contentVariant.findMany({
      where: { workspaceId: this.#workspaceId, contentItemId: item.id },
      orderBy: [{ platformKey: 'asc' }, { id: 'asc' }],
    });

    let created = 0;
    let existing = 0;

    for (const connection of connections) {
      /*
       * A CONNECTION PUBLISHES THE VARIANT WRITTEN FOR ITS PLATFORM. A variant
       * written for Instagram must not be posted to LinkedIn because both
       * happen to be connected: the caption, the hashtags and the length were
       * all chosen for one platform.
       */
      const variant = variants.find(
        (candidate) => providerForPlatformKey(candidate.platformKey) === connection.provider,
      );
      if (!variant) continue;

      const capabilities = capabilitiesFor(this.#policy, connection.provider);
      if (!capabilities.enabled) continue;

      const idempotencyKey = publishIdempotencyKey({
        workspaceId: this.#workspaceId,
        calendarSlotId: slot.id,
        socialConnectionId: connection.id,
        contentVariantId: variant.id,
      });

      const already = await this.#db.publishJob.findFirst({
        where: { workspaceId: this.#workspaceId, idempotencyKey },
        select: { id: true },
      });
      if (already) {
        existing += 1;
        continue;
      }

      await this.#db.publishJob.create({
        data: {
          workspaceId: this.#workspaceId,
          brandId: slot.brandId,
          calendarSlotId: slot.id,
          contentItemId: item.id,
          contentVariantId: variant.id,
          socialConnectionId: connection.id,
          provider: connection.provider,
          status: 'QUEUED',
          idempotencyKey,
          scheduledAtUtc: slot.scheduledAtUtc,
          maxAttempts: this.#policy.retry.maxAttempts,
          nextAttemptAt: this.#clock.now(),
          createdByUserId: slot.createdByUserId,
        },
      });
      created += 1;
    }

    if (created > 0) {
      await this.#db.calendarSlot.update({
        where: { id: slot.id },
        data: { status: 'PUBLISHING' },
      });
      await this.#db.contentItem.update({
        where: { id: item.id },
        data: { status: 'PUBLISHING' },
      });
    }

    return {
      slotId,
      created,
      existing,
      skipped: 0,
      skipReason: created === 0 && existing === 0 ? 'no_matching_variant' : null,
    };
  }

  // -------------------------------------------------------------------------
  // Execution: one job, one external call at most.
  // -------------------------------------------------------------------------

  /**
   * Claim and run one job.
   *
   * THE CLAIM IS THE CONCURRENCY CONTROL. `updateMany` with the prior status in
   * the predicate either matches one row or none; two workers cannot both take
   * it, and a job whose status moved underneath us is simply not ours.
   */
  async execute(jobId: string): Promise<ExecuteResult> {
    const now = this.#clock.now();
    const claimed = await this.#db.publishJob.updateMany({
      where: {
        id: jobId,
        workspaceId: this.#workspaceId,
        status: { in: ['QUEUED', 'VERIFICATION_PENDING'] },
      },
      data: { status: 'PUBLISHING', claimedAt: now, startedAt: now },
    });
    if (claimed.count !== 1) {
      const current = await this.#db.publishJob.findFirst({
        where: { id: jobId, workspaceId: this.#workspaceId },
      });
      if (!current) throw publishJobNotFound();
      // NOT AN ERROR. A duplicate delivery finding the job already finished is
      // the system working: the row is the state, and it says what happened.
      return {
        jobId,
        status: current.status,
        failureClass: current.failureClass,
        externalPostId: current.externalPostId,
      };
    }

    const job = await this.#db.publishJob.findFirst({
      where: { id: jobId, workspaceId: this.#workspaceId },
    });
    if (!job) throw publishJobNotFound();

    const preflight = await this.#preflight(job);
    if (preflight) return this.#fail(job, preflight, `preflight.${preflight.toLowerCase()}`, null);

    const connection = await this.#db.socialConnection.findFirst({
      where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
    });
    if (!connection) return this.#fail(job, 'NOT_CONNECTED', 'preflight.not_connected', null);

    const credentials = await this.#credentialsFor(connection.id);
    if (!credentials) return this.#fail(job, 'NOT_CONNECTED', 'preflight.no_credential', null);

    const variant = await this.#db.contentVariant.findFirst({
      where: { id: job.contentVariantId, workspaceId: this.#workspaceId },
    });
    if (!variant) return this.#fail(job, 'CONTENT_REJECTED', 'preflight.variant_missing', null);

    const adapter = this.#registry.get(job.provider);
    const attemptNumber = job.attemptCount + 1;
    const startedAt = this.#clock.now();

    /*
     * THE JOB IS ALREADY IN A STATE THAT SAYS "WE MAY HAVE SENT THIS".
     * That ordering matters: if this process dies between here and the
     * response, the row says PUBLISHING, and recovery verifies rather than
     * resends.
     */
    let outcome: PublishOutcome;
    try {
      outcome = await adapter.publish({
        credentials,
        request: {
          externalAccountId: connection.externalAccountId,
          body: variant.body ?? '',
          hashtags: variant.hashtags,
          firstComment: variant.firstComment,
          idempotencyKey: job.idempotencyKey,
        },
      });
    } catch (error: unknown) {
      const failureClass = adapter.classifyError(error);
      await this.#recordAttempt({
        job,
        attemptNumber,
        startedAt,
        outcome: FAILURE_BEHAVIOUR[failureClass].indeterminate
          ? 'INDETERMINATE'
          : FAILURE_BEHAVIOUR[failureClass].retryable
            ? 'RETRYABLE_FAILURE'
            : 'PERMANENT_FAILURE',
        failureClass,
        providerStatusCode: null,
        providerErrorCode: null,
        // NEVER the thrown message: an exception from deep in an HTTP client
        // can carry the request body, which is the customer's caption.
        safeSummary: 'The platform call did not complete.',
      });
      return this.#afterFailure(
        job,
        failureClass,
        `adapter.${failureClass.toLowerCase()}`,
        adapter,
        connection.externalAccountId,
        credentials,
      );
    }

    if (outcome.ok) {
      await this.#recordAttempt({
        job,
        attemptNumber,
        startedAt,
        outcome: 'SUCCEEDED',
        failureClass: null,
        providerStatusCode: outcome.providerStatusCode,
        providerErrorCode: null,
        safeSummary: null,
      });
      return this.#succeed(job, outcome.externalPostId, outcome.externalPostUrl);
    }

    const behaviour = FAILURE_BEHAVIOUR[outcome.failureClass];
    await this.#recordAttempt({
      job,
      attemptNumber,
      startedAt,
      outcome: behaviour.indeterminate
        ? 'INDETERMINATE'
        : behaviour.retryable
          ? 'RETRYABLE_FAILURE'
          : 'PERMANENT_FAILURE',
      failureClass: outcome.failureClass,
      providerStatusCode: outcome.providerStatusCode,
      providerErrorCode: outcome.providerErrorCode,
      safeSummary: outcome.safeSummary,
    });

    return this.#afterFailure(
      job,
      outcome.failureClass,
      outcome.failureCode,
      adapter,
      connection.externalAccountId,
      credentials,
      outcome.retryAfterSeconds,
    );
  }

  /**
   * What happens after a failed attempt — and the duplicate-prevention rule.
   *
   * AN INDETERMINATE OUTCOME IS VERIFIED, NEVER RESENT. If the adapter can look
   * the post up and finds it, the job SUCCEEDED and we say so. If it cannot
   * look it up at all, the job stops and a human decides — resending a post
   * that may already be live is the one failure this whole design exists to
   * avoid.
   */
  async #afterFailure(
    job: PublishJob,
    failureClass: PublishFailureClass,
    failureCode: string,
    adapter: ReturnType<ConnectorRegistry['get']>,
    externalAccountId: string,
    credentials: AdapterCredentials,
    retryAfterSeconds?: number,
  ): Promise<ExecuteResult> {
    const behaviour = FAILURE_BEHAVIOUR[failureClass];

    if (behaviour.indeterminate) {
      if (adapter.capabilities.supportsPostLookup && adapter.findPostByIdempotencyKey) {
        const found = await adapter.findPostByIdempotencyKey({
          externalAccountId,
          idempotencyKey: job.idempotencyKey,
          credentials,
        });
        if (found) return this.#succeed(job, found.externalPostId, found.externalPostUrl);
      } else {
        /*
         * WE CANNOT ASK, SO WE STOP. The alternative is to guess, and a wrong
         * guess posts twice. `VERIFICATION_PENDING` is a state a human can act
         * on; a second send is not something they can undo.
         */
        await this.#db.publishJob.update({
          where: { id: job.id },
          data: {
            status: 'VERIFICATION_PENDING',
            attemptCount: { increment: 1 },
            failureClass,
            failureCode,
            nextAttemptAt: null,
          },
        });
        await this.#syncLifecycle(job);
        return {
          jobId: job.id,
          status: 'VERIFICATION_PENDING',
          failureClass,
          externalPostId: null,
        };
      }
    }

    if (behaviour.needsReconnect) {
      await this.#db.socialConnection.updateMany({
        where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
        data: {
          status: 'NEEDS_REAUTH',
          lastFailureClass: failureClass,
          lastCheckedAt: this.#clock.now(),
          consecutiveFailureCount: { increment: 1 },
        },
      });
    }

    const attemptCount = job.attemptCount + 1;
    const exhausted = attemptCount >= job.maxAttempts;
    if (!behaviour.retryable || exhausted) {
      return this.#fail(job, failureClass, failureCode, attemptCount);
    }

    return this.#scheduleRetry(job, failureClass, failureCode, attemptCount, retryAfterSeconds);
  }

  /**
   * Exponential backoff with jitter, honouring `Retry-After` when given.
   *
   * JITTER IS NOT DECORATION. After a platform outage every held job becomes
   * due at the same instant; without jitter they arrive together and are rate
   * limited together, which is the outage extending itself.
   */
  async #scheduleRetry(
    job: PublishJob,
    failureClass: PublishFailureClass,
    failureCode: string,
    attemptCount: number,
    retryAfterSeconds?: number,
  ): Promise<ExecuteResult> {
    const retry = this.#policy.retry;
    const base =
      retryAfterSeconds ??
      Math.min(
        retry.initialBackoffSeconds * Math.pow(retry.backoffMultiplier, attemptCount - 1),
        retry.maxBackoffSeconds,
      );
    /*
     * DETERMINISTIC JITTER, derived from the job's own key. A test can predict
     * it and a herd still spreads, because two different jobs hash differently.
     * `Math.random()` here would make the retry schedule untestable, and an
     * untested retry schedule is how a backoff quietly becomes a busy loop.
     *
     * THE KEY IS HASHED RATHER THAN PARSED. `publishIdempotencyKey` returns hex
     * today, and reading the first bytes of it directly worked — until a job
     * whose key came from anywhere else produced `NaN`, then an `Invalid Date`,
     * then a Prisma validation error at the moment a rate-limited post was
     * trying to back off. Hashing accepts any key by construction, so the
     * schedule cannot depend on a format nothing enforces.
     */
    const seedBytes = createHash('sha256').update(job.idempotencyKey).digest();
    const jitterSeed = seedBytes.readUInt32BE(0) / 0xffffffff;
    const jitter = base * retry.jitterRatio * (jitterSeed - 0.5) * 2;
    const delayMs = Math.max(1_000, Math.round((base + jitter) * 1_000));

    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        attemptCount,
        failureClass,
        failureCode,
        claimedAt: null,
        nextAttemptAt: new Date(this.#clock.now().getTime() + delayMs),
      },
    });
    return { jobId: job.id, status: 'QUEUED', failureClass, externalPostId: null };
  }

  async #succeed(
    job: PublishJob,
    externalPostId: string,
    externalPostUrl: string | null,
  ): Promise<ExecuteResult> {
    const now = this.#clock.now();
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'PUBLISHED',
        attemptCount: { increment: 1 },
        externalPostId,
        externalPostUrl,
        publishedAt: now,
        completedAt: now,
        nextAttemptAt: null,
        failureClass: null,
        failureCode: null,
      },
    });
    await this.#db.socialConnection.updateMany({
      where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
      data: { lastSyncedAt: now, consecutiveFailureCount: 0, lastFailureClass: null },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.post.published',
      actorType: 'SYSTEM',
      resourceType: 'PublishJob',
      resourceId: job.id,
      brandId: job.brandId,
      // The external id and the provider. NOT the caption, and NOT the token.
      after: { provider: job.provider, externalPostId },
    });
    await this.#notifier?.published({
      jobId: job.id,
      contentItemId: job.contentItemId,
      brandId: job.brandId,
      provider: job.provider,
      // WHOEVER SCHEDULED IT, which is the person waiting to know. A broadcast
      // to everyone with `publishing.read` would be a disclosure to members
      // who never asked and, for a brand-restricted member, about a brand they
      // may not see.
      notifyUserId: job.createdByUserId,
      externalPostUrl,
    });
    await this.#syncLifecycle(job);
    return { jobId: job.id, status: 'PUBLISHED', failureClass: null, externalPostId };
  }

  async #fail(
    job: PublishJob,
    failureClass: PublishFailureClass,
    failureCode: string,
    attemptCount: number | null,
  ): Promise<ExecuteResult> {
    const now = this.#clock.now();
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        ...(attemptCount === null ? {} : { attemptCount }),
        failureClass,
        failureCode,
        completedAt: now,
        nextAttemptAt: null,
      },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.post.failed',
      actorType: 'SYSTEM',
      resourceType: 'PublishJob',
      resourceId: job.id,
      brandId: job.brandId,
      // The CLASS and the CODE — both ours, both stable, neither echoing the
      // provider's own words or the content it rejected.
      after: { provider: job.provider, failureClass, failureCode },
    });
    await this.#notifier?.failed({
      jobId: job.id,
      contentItemId: job.contentItemId,
      brandId: job.brandId,
      provider: job.provider,
      notifyUserId: job.createdByUserId,
      failureClass,
      needsReconnect: FAILURE_BEHAVIOUR[failureClass].needsReconnect,
    });
    await this.#syncLifecycle(job);
    return { jobId: job.id, status: 'FAILED', failureClass, externalPostId: null };
  }

  // -------------------------------------------------------------------------
  // Customer-initiated transitions.
  // -------------------------------------------------------------------------

  /**
   * Cancel before dispatch.
   *
   * ONLY FROM A STATE WHERE NOTHING HAS LEFT. A job that is PUBLISHING may
   * already be in the provider's hands, and marking it cancelled would be
   * telling the customer something we do not know to be true.
   */
  async cancel(input: {
    jobId: string;
    actorUserId: string;
    brandScope: readonly string[];
  }): Promise<ExecuteResult> {
    const job = await this.#db.publishJob.findFirst({
      where: { id: input.jobId, ...brandIdQueryFilter({ brandScope: input.brandScope }) },
    });
    if (!job) throw publishJobNotFound();
    if (job.status !== 'PENDING' && job.status !== 'QUEUED') throw publishJobNotCancellable();

    const now = this.#clock.now();
    const cancelled = await this.#db.publishJob.updateMany({
      where: {
        id: job.id,
        workspaceId: this.#workspaceId,
        // THE STATUS IS IN THE PREDICATE, so a worker claiming it a millisecond
        // ago wins and the cancel is refused — rather than both succeeding.
        status: { in: ['PENDING', 'QUEUED'] },
      },
      data: { status: 'CANCELLED', cancelledAt: now, completedAt: now, nextAttemptAt: null },
    });
    if (cancelled.count !== 1) throw publishJobNotCancellable();

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.post.cancelled',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'PublishJob',
      resourceId: job.id,
      brandId: job.brandId,
      before: { status: job.status },
      after: { status: 'CANCELLED' },
    });
    await this.#syncLifecycle(job);
    return { jobId: job.id, status: 'CANCELLED', failureClass: null, externalPostId: null };
  }

  /**
   * Retry by hand, after a human has fixed whatever was wrong.
   *
   * REFUSED FOR CLASSES WHERE RETRYING CANNOT HELP. `AUTH_REVOKED` needs a
   * reconnection, not another attempt, and offering a button that cannot work
   * is worse than not offering one.
   */
  async retry(input: {
    jobId: string;
    actorUserId: string;
    brandScope: readonly string[];
  }): Promise<ExecuteResult> {
    const job = await this.#db.publishJob.findFirst({
      where: { id: input.jobId, ...brandIdQueryFilter({ brandScope: input.brandScope }) },
    });
    if (!job) throw publishJobNotFound();
    if (job.status !== 'FAILED' && job.status !== 'VERIFICATION_PENDING') {
      throw publishJobNotRetryable();
    }
    if (job.failureClass && !FAILURE_BEHAVIOUR[job.failureClass].manualRetryUseful) {
      throw publishJobNotRetryable();
    }

    const now = this.#clock.now();
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        // THE ATTEMPT BUDGET IS RESET, because a human deciding to try again is
        // a new decision, not a continuation of the automatic schedule.
        attemptCount: 0,
        maxAttempts: this.#policy.retry.maxAttempts,
        nextAttemptAt: now,
        completedAt: null,
        claimedAt: null,
        failureClass: null,
        failureCode: null,
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.post.retry_requested',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'PublishJob',
      resourceId: job.id,
      brandId: job.brandId,
      before: { status: job.status, failureClass: job.failureClass },
      after: { status: 'QUEUED' },
    });
    return { jobId: job.id, status: 'QUEUED', failureClass: null, externalPostId: null };
  }

  // -------------------------------------------------------------------------
  // Internals.
  // -------------------------------------------------------------------------

  /**
   * Everything that must be true before an external call — §7.1.
   *
   * RUN INSIDE THE JOB, NOT ONLY AT SCHEDULING. Every one of these can change
   * between the two: approval is withdrawn, a connection expires, a slot is
   * cancelled, the post becomes too late to be worth sending.
   */
  async #preflight(job: PublishJob): Promise<PublishFailureClass | null> {
    const slot = await this.#db.calendarSlot.findFirst({
      where: { id: job.calendarSlotId, workspaceId: this.#workspaceId },
    });
    if (!slot || slot.status === 'CANCELLED') return 'APPROVAL_REVOKED';

    const item = await this.#db.contentItem.findFirst({
      where: { id: job.contentItemId, workspaceId: this.#workspaceId },
    });
    if (!item || item.deletedAt) return 'CONTENT_REJECTED';
    // THE HARD RULE, restated at the last possible moment.
    if (item.status === 'IN_REVIEW' || item.status === 'CHANGES_REQUESTED') {
      return 'APPROVAL_REVOKED';
    }

    const gate = await this.#approvals.policyForBrand(job.brandId);
    if (gate.requireApprovalBeforeScheduling) {
      const approval = await this.#approvals.openForItem(job.contentItemId);
      if (!approval || approval.status !== 'APPROVED') return 'APPROVAL_REVOKED';
    }

    const connection = await this.#db.socialConnection.findFirst({
      where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
      select: { status: true },
    });
    if (!connection || connection.status !== 'ACTIVE') return 'NOT_CONNECTED';

    const capabilities = capabilitiesFor(this.#policy, job.provider);
    if (!capabilities.enabled) return 'UNSUPPORTED';

    /*
     * TOO LATE TO BE WORTH SENDING. A time-sensitive post six hours late is
     * worse than one not posted at all, so beyond the configured tolerance the
     * job stops and the customer decides (docs/SOCIAL-INTEGRATIONS.md §8).
     */
    const lateByMs = this.#clock.now().getTime() - job.scheduledAtUtc.getTime();
    if (lateByMs > this.#policy.dispatch.latenessToleranceMinutes * 60_000) {
      return 'TARGET_UNAVAILABLE';
    }

    return null;
  }

  async #credentialsFor(connectionId: string): Promise<AdapterCredentials | null> {
    const live = await this.#db.socialCredential.findFirst({
      where: { workspaceId: this.#workspaceId, socialConnectionId: connectionId, retiredAt: null },
      orderBy: { version: 'desc' },
    });
    if (!live) return null;
    return this.#vault.open({
      ciphertext: live.ciphertext,
      iv: live.iv,
      authTag: live.authTag,
      wrappedDataKey: live.wrappedDataKey,
      keyProvider: live.keyProvider,
      keyId: live.keyId,
      algorithm: 'AES-256-GCM',
      encryptionContext: live.encryptionContext,
      maskedHint: live.maskedHint,
      fingerprint: live.fingerprint,
    });
  }

  async #recordAttempt(input: {
    job: PublishJob;
    attemptNumber: number;
    startedAt: Date;
    outcome: 'SUCCEEDED' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE' | 'INDETERMINATE';
    failureClass: PublishFailureClass | null;
    providerStatusCode: number | null;
    providerErrorCode: string | null;
    safeSummary: string | null;
  }): Promise<void> {
    const finishedAt = this.#clock.now();
    await this.#db.publishAttempt.create({
      data: {
        workspaceId: this.#workspaceId,
        publishJobId: input.job.id,
        attemptNumber: input.attemptNumber,
        startedAt: input.startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - input.startedAt.getTime(),
        outcome: input.outcome,
        failureClass: input.failureClass,
        providerStatusCode: input.providerStatusCode,
        providerErrorCode: input.providerErrorCode,
        // BOUNDED HERE AS WELL AS BY THE CHECK. Two guards, because the column
        // is the one place a raw provider body would otherwise land.
        safeSummary: input.safeSummary === null ? null : input.safeSummary.slice(0, 500),
      },
    });
  }

  /**
   * Keep the slot and the item in step with their jobs.
   *
   * DERIVED FROM THE JOBS, NEVER SET INDEPENDENTLY. Three places recording
   * "published" is three places that can disagree; here there is one rule, and
   * it reads the jobs every time rather than remembering.
   */
  async #syncLifecycle(job: PublishJob): Promise<void> {
    const jobs = await this.#db.publishJob.findMany({
      where: { workspaceId: this.#workspaceId, calendarSlotId: job.calendarSlotId },
      select: { status: true },
    });
    if (jobs.length === 0) return;

    const terminal = jobs.every((candidate) =>
      ['PUBLISHED', 'FAILED', 'CANCELLED'].includes(candidate.status),
    );
    if (!terminal) return;

    const published = jobs.filter((candidate) => candidate.status === 'PUBLISHED').length;
    const cancelled = jobs.filter((candidate) => candidate.status === 'CANCELLED').length;

    const slotStatus =
      published === jobs.length
        ? 'PUBLISHED'
        : published > 0
          ? 'PARTIALLY_PUBLISHED'
          : cancelled === jobs.length
            ? 'CANCELLED'
            : 'FAILED';
    const itemStatus =
      published === jobs.length
        ? 'PUBLISHED'
        : published > 0
          ? 'PARTIALLY_PUBLISHED'
          : cancelled === jobs.length
            ? 'SCHEDULED'
            : 'FAILED';

    await this.#db.calendarSlot.updateMany({
      where: { id: job.calendarSlotId, workspaceId: this.#workspaceId },
      data:
        slotStatus === 'CANCELLED'
          ? { status: 'CANCELLED', cancelledAt: this.#clock.now() }
          : { status: slotStatus },
    });
    await this.#db.contentItem.updateMany({
      where: { id: job.contentItemId, workspaceId: this.#workspaceId },
      data: { status: itemStatus },
    });
  }
}
