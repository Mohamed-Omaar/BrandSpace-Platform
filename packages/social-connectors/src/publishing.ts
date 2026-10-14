import { createHash } from 'node:crypto';
import type { Environment } from '@brandspace/config';
import {
  recordAutomationEvent,
  writeAuditEvent,
  type PublishFailureClass,
  type PublishJob,
  type SocialConnection,
  type SocialProvider,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  approvalCoversItem,
  brandIdQueryFilter,
  readApprovedFingerprint,
  systemClock,
  type Clock,
} from '@brandspace/shared';
import type {
  AdapterCredentials,
  PublishMedia,
  PublishObservation,
  PublishOutcome,
  PublishRequest,
} from './adapter';
import {
  FAILURE_BEHAVIOUR,
  publishJobNotCancellable,
  publishJobNotFound,
  publishJobNotRetryable,
  publishJobPastDeadline,
  publishJobSuperseded,
} from './errors';
import {
  capabilitiesFor,
  PROVIDER_CONFIG_KEYS,
  TenantPublishingPolicySource,
  type MediaRule,
  type PublishingPolicy,
} from './policy';
import { postKindFor } from './post-kinds';
import { readTikTokOptions, tiktokOptionsProblems } from './tiktok/options';
import { ProviderRateLimiter } from './rate-limits';
import { markNeedsReauth, type ReauthNotifier } from './reauth';

/**
 * The failures an ACCOUNT caused, which a reconnection of that account fixes
 * (D-291). Deliberately not derived from `needsReconnect`: `AUTH_EXPIRED` is a
 * token the refresh could not renew, and after that the fix is also a
 * reconnection. Never an indeterminate class.
 */
const RECONNECT_RETRY_CLASSES: ReadonlySet<string> = new Set([
  'AUTH_EXPIRED',
  'AUTH_REVOKED',
  'INSUFFICIENT_SCOPE',
]);

/**
 * May this failed job be retried through a reconnected account? One of the
 * account classes above — or a job that WAITED for its account and failed at
 * the deadline with `preflight.reconnect_required` (Q9, D-332; review item 12).
 * That job is `NOT_CONNECTED` with that code: the connection itself is never
 * given a status of that name.
 */
export function retryableAfterReconnect(job: {
  readonly failureClass: string | null;
  readonly failureCode: string | null;
}): boolean {
  if (RECONNECT_RETRY_CLASSES.has(job.failureClass ?? '')) return true;
  return job.failureClass === 'NOT_CONNECTED' && job.failureCode === RECONNECT_REQUIRED_CODE;
}
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
  /**
   * The live approval for an item, if a cycle is open or was decided.
   *
   * `approvedFingerprint` IS WHAT THE VERDICT WAS GRANTED OVER (D-223) — see
   * `@brandspace/shared`'s `content-fingerprint`. It is part of this port
   * rather than something the pipeline reads off the row itself because the
   * approval table belongs to the Approvals module, and a publisher that read
   * another module's columns directly would be a second reader of a meaning it
   * does not own.
   */
  latestForItem(itemId: string): Promise<{ status: string; approvedFingerprint?: unknown } | null>;
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
export interface PublishNotifier extends Partial<ReauthNotifier> {
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

/**
 * HOW THE PIPELINE TURNS ASSET IDS INTO BYTES (AC-29.3).
 *
 * A PORT RATHER THAN A DEPENDENCY, deliberately. Resolving media needs the
 * Asset Library's rules AND the object store, and this package has neither —
 * importing them would make every connector's package graph include the whole
 * media subsystem, and would put the tenant boundary for assets in two places.
 * The wiring layer, which already holds both, supplies one implementation and
 * the pipeline calls it.
 *
 * IT MUST THROW rather than return a short list. A resolver that silently
 * dropped an inadmissible asset would publish a post the author never
 * reviewed — the caption they wrote, with the picture missing. The pipeline
 * maps a throw to `CONTENT_REJECTED` and the job fails honestly.
 */
export interface PublishMediaPort {
  resolve(input: {
    readonly brandId: string;
    readonly assetIds: readonly string[];
    /**
     * D-505 O1 — present only for a platform that fetches media by URL: mint a
     * pre-signed GET URL for each file, living this long. A port whose store
     * cannot pre-sign leaves `fetchUrl` absent and the pipeline refuses.
     */
    readonly fetchUrlTtlSeconds?: number;
  }): Promise<readonly PublishMedia[]>;
}

export interface PublishPipelineOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: PublishingPolicy;
  readonly registry: ConnectorRegistry;
  readonly vault: SocialTokenVault;
  readonly approvals: PublishApprovalGate;
  /**
   * PHASE 8. OPTIONAL, and its absence is load-bearing: a caller that supplies
   * no resolver cannot publish media, so a variant carrying assets is REFUSED
   * rather than published without them. Silently dropping media because the
   * wiring forgot a port is exactly the failure this phase is closing.
   */
  readonly media?: PublishMediaPort | undefined;
  readonly notifier?: PublishNotifier | undefined;
  /**
   * CONNECTORS A (W12) — the process's request budget, SHARED with analytics.
   * One per process, held by the caller: a limiter built per pipeline would
   * forget every reservation with the transaction.
   */
  readonly rateLimiter?: ProviderRateLimiter | undefined;
  /**
   * D-531 — the plan's monthly scheduling quota, to refund a post that is held
   * because every platform it was queued for was switched off. The worker and
   * the API pass `createScheduleQuota`; without it the hold still happens and
   * nothing is refunded.
   */
  readonly scheduleQuota?: { refund(idempotencyKey: string): Promise<void> } | undefined;
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

/**
 * Why `retry()` would refuse a job (Phase 2B-3 PR 5). `retryRefusal()` answers
 * with one of these, read-only; `retry()` throws the matching error.
 */
export type RetryRefusal = 'not_found' | 'not_retryable' | 'deadline_passed' | 'superseded';

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
 * Q9 (D-332) — THE CALENDAR'S QUESTION: which of a post's channels can reach
 * no account at all? One whose every account for the brand was REVOKED or
 * DISABLED. An account that needs reconnecting still counts as reachable (its
 * post waits for it), a pending one is ignored, and a channel with no account
 * at all is not answered here — scheduling it keeps today's behaviour.
 *
 * The workspace predicate goes into the query beside RLS, the two
 * independent layers CLAUDE.md §2.1 asks for.
 */
export function unreachableChannelGate(
  db: TenantScopedClient,
  workspaceId: string,
  /**
   * PR F (b), Q8 — with the environment, the gate also answers which channels
   * cannot be connected at all (the activated publishing policy has their
   * platform switched off), read per call from the tenant-readable catalogue.
   */
  environment?: Environment,
): {
  unreachableChannels(brandId: string, platformKeys: readonly string[]): Promise<readonly string[]>;
  notConnectable(platformKeys: readonly string[]): Promise<readonly string[]>;
} {
  return {
    async notConnectable(platformKeys) {
      if (!environment || platformKeys.length === 0) return [];
      const policy = await new TenantPublishingPolicySource(db as never, environment).load();
      return platformKeys.filter((platformKey) => {
        const provider = providerForPlatformKey(platformKey);
        return !provider || !capabilitiesFor(policy, provider).enabled;
      });
    },
    async unreachableChannels(brandId, platformKeys) {
      if (platformKeys.length === 0) return [];
      const accounts = await db.socialConnection.findMany({
        where: { workspaceId, brandId, status: { not: 'PENDING' } },
        select: { provider: true, status: true },
      });
      return platformKeys.filter((platformKey) => {
        const provider = providerForPlatformKey(platformKey);
        if (!provider) return false;
        const forProvider = accounts.filter((account) => account.provider === provider);
        return (
          forProvider.length > 0 &&
          forProvider.every(
            (account) => account.status === 'REVOKED' || account.status === 'DISABLED',
          )
        );
      });
    },
  };
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

/**
 * Q9 (D-332) — a job whose account needs reconnecting, before and after its
 * lateness deadline. Not failure classes: the first is not a failure at all,
 * and the second is `NOT_CONNECTED` with its own code, which the publishing
 * log translates as "reconnect the account".
 */
const AWAITING_RECONNECT = 'AWAITING_RECONNECT' as const;
const RECONNECT_TOO_LATE = 'RECONNECT_TOO_LATE' as const;
/**
 * D-531 (owner, step B) — THE JOB'S PLATFORM WAS SWITCHED OFF AFTER IT WAS
 * QUEUED. Not a failure of the post: it is held, never FAILED, never noticed.
 */
const PLATFORM_SWITCHED_OFF = 'PLATFORM_SWITCHED_OFF' as const;
/** The code a job held for a switched-off platform is cancelled with. */
export const PLATFORM_SWITCHED_OFF_CODE = 'held.platform_switched_off';
/**
 * D-538 (owner, #82) — A TIKTOK POST WHOSE OPTIONS ARE NOT CHOSEN IS HELD
 * BEFORE DISPATCH, NEVER SENT AND NEVER FAILED. On the job while it waits for
 * the panel, and on the job cancelled when its lateness deadline passes with
 * the panel still incomplete. The publishing log says "Choose who can see this
 * post".
 */
export const TIKTOK_OPTIONS_HELD_CODE = 'held.tiktok_options_missing';
const TIKTOK_OPTIONS_MISSING = 'TIKTOK_OPTIONS_MISSING' as const;
const TIKTOK_OPTIONS_TOO_LATE = 'TIKTOK_OPTIONS_TOO_LATE' as const;
/** On a held job, while it waits. */
export const AWAITING_RECONNECT_CODE = 'preflight.awaiting_reconnect';
/** On the job that waited until its deadline and the account never came back. */
export const RECONNECT_REQUIRED_CODE = 'preflight.reconnect_required';
/** Connectors A (W12): on a job waiting for its account's request budget. */
export const AWAITING_BUDGET_CODE = 'preflight.awaiting_budget';
/** Connectors A (W5): on a job the platform accepted and has not finished. */
export const PUBLISH_IN_PROGRESS_CODE = 'adapter.publish_in_progress';

type PreflightOutcome =
  | PublishFailureClass
  | typeof AWAITING_RECONNECT
  | typeof RECONNECT_TOO_LATE
  | typeof PLATFORM_SWITCHED_OFF
  | typeof TIKTOK_OPTIONS_MISSING
  | typeof TIKTOK_OPTIONS_TOO_LATE
  | null;

/**
 * PHASE 2B-3 PR 2 — which attempt a transition to FAILED concludes with (see
 * `#concludingAttempt`). Every caller of `#fail` says which kind it is.
 */
type FailureEvidence =
  | { readonly kind: 'attempt'; readonly attemptId: string }
  | { readonly kind: 'preflight' }
  | { readonly kind: 'verified' };
const PREFLIGHT: FailureEvidence = { kind: 'preflight' };
const VERIFIED: FailureEvidence = { kind: 'verified' };

/** Ours, fixed and bounded: never the provider's words, never the content. */
export const PREFLIGHT_REFUSED_SUMMARY = 'Refused before sending: no request was made.';
/**
 * D1 — explicit about the uncertainty. It does NOT say a request was made or
 * that an answer came back; it says the send state is unknown.
 */
export const UNKNOWN_SEND_STATE_SUMMARY =
  'The worker claim ended before its result was recorded; whether the request was sent is unknown.';

export class PublishPipelineService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: PublishingPolicy;
  readonly #registry: ConnectorRegistry;
  readonly #vault: SocialTokenVault;
  readonly #approvals: PublishApprovalGate;
  readonly #media: PublishMediaPort | undefined;
  readonly #notifier: PublishNotifier | undefined;
  readonly #rateLimiter: ProviderRateLimiter | undefined;
  readonly #scheduleQuota: { refund(idempotencyKey: string): Promise<void> } | undefined;
  readonly #clock: Clock;

  constructor(options: PublishPipelineOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#registry = options.registry;
    this.#vault = options.vault;
    this.#approvals = options.approvals;
    this.#media = options.media;
    this.#notifier = options.notifier;
    this.#rateLimiter = options.rateLimiter;
    this.#scheduleQuota = options.scheduleQuota;
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
      const approval = await this.#approvals.latestForItem(item.id);
      if (!approval || approval.status !== 'APPROVED') return empty('approval_required');
    }

    /*
     * AN EXPIRED ACCOUNT STILL GETS ITS JOB (Q9, D-332). A connection that
     * needs reconnecting used to be skipped here, so its channel was silently
     * dropped from the post while the others went out. Its job is now created
     * like any other and WAITS for the reconnection in `execute()` until the
     * lateness deadline, then fails saying to reconnect the account — visible
     * in the publishing log, never silent. Revoked, disabled and pending
     * accounts publish nothing and are still left out.
     */
    const connections = await this.#db.socialConnection.findMany({
      where: {
        workspaceId: this.#workspaceId,
        brandId: slot.brandId,
        status: { in: ['ACTIVE', 'NEEDS_REAUTH'] },
      },
      orderBy: [{ provider: 'asc' }, { id: 'asc' }],
    });
    if (connections.length === 0) return empty('no_active_connection');

    const variants = await this.#db.contentVariant.findMany({
      where: { workspaceId: this.#workspaceId, contentItemId: item.id },
      orderBy: [{ platformKey: 'asc' }, { id: 'asc' }],
    });

    /*
     * THE ROWS ARE BUILT FIRST AND WRITTEN IN ONE STATEMENT, and that is the
     * whole concurrency fix (D-144).
     *
     * The first version asked `findFirst` whether the job existed and then
     * called `create`. Two sweeps running together — the scheduler and a manual
     * dispatch, or two API instances, which is the normal deployment — both see
     * no row, both insert, and the unique index correctly refuses the second.
     * Correct DATA, and a thrown `P2002` that aborts the loser's whole
     * workspace pass, so every later slot in that batch goes unmaterialised
     * because an earlier one was already done. The check-then-act was never
     * atomic; the index was doing all the work and reporting it as a crash.
     *
     * `createMany` with `skipDuplicates` compiles to `INSERT ... ON CONFLICT DO
     * NOTHING`, which is ONE statement: the conflict is resolved inside
     * PostgreSQL, the loser inserts nothing and raises nothing, and `count` is
     * the number of rows that actually landed. `existing` is then arithmetic
     * rather than a second query, and it is exact under concurrency, which the
     * `findFirst` answer never was.
     */
    const rows: {
      workspaceId: string;
      brandId: string;
      calendarSlotId: string;
      contentItemId: string;
      contentVariantId: string;
      socialConnectionId: string;
      provider: SocialProvider;
      status: 'QUEUED';
      idempotencyKey: string;
      scheduledAtUtc: Date;
      maxAttempts: number;
      nextAttemptAt: Date;
      createdByUserId: string | null;
    }[] = [];

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

      rows.push({
        workspaceId: this.#workspaceId,
        brandId: slot.brandId,
        calendarSlotId: slot.id,
        contentItemId: item.id,
        contentVariantId: variant.id,
        socialConnectionId: connection.id,
        provider: connection.provider,
        status: 'QUEUED',
        idempotencyKey: publishIdempotencyKey({
          workspaceId: this.#workspaceId,
          calendarSlotId: slot.id,
          socialConnectionId: connection.id,
          contentVariantId: variant.id,
        }),
        scheduledAtUtc: slot.scheduledAtUtc,
        maxAttempts: this.#policy.retry.maxAttempts,
        nextAttemptAt: this.#clock.now(),
        createdByUserId: slot.createdByUserId,
      });
    }

    if (rows.length === 0) {
      return { slotId, created: 0, existing: 0, skipped: 0, skipReason: 'no_matching_variant' };
    }

    /*
     * THE CLAIM (review item 4). Everything above was decided from the slot as
     * it was READ. A time-zone change (D-334) can commit in between — moving
     * the post back to PLANNED or to another instant — and jobs built from the
     * stale read would publish a post that is no longer due. So the slot is
     * locked HERE, and only if it is still SCHEDULED at the instant this
     * materialisation read. No match: nothing is created and the slot is left
     * alone. A change arriving after this point waits for the lock and then
     * finds the slot PUBLISHING, which it does not move.
     *
     * THE LOCK, THE INSERT AND THE TRANSITION share the caller's transaction:
     * a failure anywhere below rolls all three back, so a slot is never left
     * PUBLISHING without its jobs.
     */
    const claimed = await this.#db.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "calendar_slot"
       WHERE "id" = ${slot.id}::uuid
         AND "workspaceId" = ${this.#workspaceId}::uuid
         AND "status" = 'SCHEDULED'
         AND date_trunc('milliseconds', "scheduledAtUtc") = ${slot.scheduledAtUtc}
       FOR UPDATE`;
    if (claimed.length === 0) return empty('slot_changed');

    const inserted = await this.#db.publishJob.createMany({ data: rows, skipDuplicates: true });
    const created = inserted.count;
    const existing = rows.length - created;

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
   *
   * ONLY `QUEUED` ENTERS THIS METHOD, AND THAT IS A CORRECTNESS RULE, NOT A
   * TIDINESS ONE (D-143).
   *
   * The first version claimed `QUEUED` OR `VERIFICATION_PENDING` and then ran
   * straight into `adapter.publish()`. `VERIFICATION_PENDING` means exactly one
   * thing: the request left, the answer never came back, and THE POST MAY BE
   * LIVE. Publishing such a job is the single outcome this whole pipeline is
   * built to prevent, and a duplicate BullMQ delivery — which the queue
   * guarantees is possible, not merely conceivable — was enough to cause it.
   * The header of this file claimed "an uncertain outcome is never retried"
   * while the claim predicate said otherwise; the predicate was what ran.
   *
   * An uncertain outcome now has its own path, `verify()`, which has no call to
   * `publish()` in it at all — not a guarded one, none — so the rule holds by
   * construction rather than by remembering.
   */
  async execute(jobId: string): Promise<ExecuteResult> {
    return executePublishJob(this.#inPlace, jobId);
  }

  /**
   * W1 (connectors A, D-505) — THE STEPS RUN ON THIS ONE CLIENT, IN ORDER.
   *
   * `execute`, `verify` and `recoverStaleClaim` keep their single-call shape
   * for a caller that already holds one client. The worker does not use them:
   * it runs `executePublishJob` and friends with a fresh transaction per step,
   * so the provider call sits between two commits rather than inside one.
   */
  readonly #inPlace: PipelineTransactions = { run: (step) => step(this) };

  /**
   * STEP 1 OF 3 — CLAIM AND PREFLIGHT, then commit (W1).
   *
   * Everything decided before a provider is called is decided here, inside
   * the caller's transaction: the claim QUEUED → PUBLISHING, every preflight
   * refusal, the connection, the credential, the variant and its media. What
   * comes back is either the job's settled answer — a duplicate delivery, a
   * refusal, a hold — or everything the provider call needs, and nothing the
   * database does.
   *
   * THE CLAIM IS COMMITTED BEFORE THE PROVIDER IS CALLED, AND THAT IS THE FIX.
   * The worker used to run this, the provider call and the outcome in ONE
   * transaction. A provider slower than the transaction's timeout aborted it,
   * the claim rolled back to QUEUED with the post possibly live, and the
   * redelivery published it again. Now the row says PUBLISHING before the
   * request leaves, whatever happens to the process or the transaction after.
   */
  async beginExecution(jobId: string): Promise<ExecutionStep> {
    const now = this.#clock.now();
    const claimed = await this.#db.publishJob.updateMany({
      where: {
        id: jobId,
        workspaceId: this.#workspaceId,
        // QUEUED AND NOTHING ELSE. See above.
        status: 'QUEUED',
      },
      data: {
        status: 'PUBLISHING',
        claimedAt: now,
        startedAt: now,
      },
    });
    if (claimed.count !== 1) {
      const current = await this.#db.publishJob.findFirst({
        where: { id: jobId, workspaceId: this.#workspaceId },
      });
      if (!current) throw publishJobNotFound();
      // NOT AN ERROR. A duplicate delivery finding the job already finished —
      // or already claimed, or awaiting verification — is the system working:
      // the row is the state, and it says what happened. Nothing is sent.
      return settled({
        jobId,
        status: current.status,
        failureClass: current.failureClass,
        externalPostId: current.externalPostId,
      });
    }

    const job = await this.#db.publishJob.findFirst({
      where: { id: jobId, workspaceId: this.#workspaceId },
    });
    if (!job) throw publishJobNotFound();

    const preflight = await this.#preflight(job);
    if (preflight === AWAITING_RECONNECT) return settled(await this.#holdForReconnect(job));
    if (preflight === PLATFORM_SWITCHED_OFF) return settled(await this.#holdSwitchedOff(job));
    if (preflight === TIKTOK_OPTIONS_MISSING) return settled(await this.#holdForOptions(job));
    if (preflight === TIKTOK_OPTIONS_TOO_LATE) return settled(await this.#holdWithoutOptions(job));
    if (preflight === RECONNECT_TOO_LATE) {
      return settled(
        await this.#fail(job, 'NOT_CONNECTED', RECONNECT_REQUIRED_CODE, null, PREFLIGHT),
      );
    }
    if (preflight)
      return settled(
        await this.#fail(job, preflight, `preflight.${preflight.toLowerCase()}`, null, PREFLIGHT),
      );

    const connection = await this.#db.socialConnection.findFirst({
      where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
    });
    if (!connection)
      return settled(
        await this.#fail(job, 'NOT_CONNECTED', 'preflight.not_connected', null, PREFLIGHT),
      );

    const credentials = await this.#credentialsFor(connection.id);
    if (!credentials)
      return settled(
        await this.#fail(job, 'NOT_CONNECTED', 'preflight.no_credential', null, PREFLIGHT),
      );

    const variant = await this.#db.contentVariant.findFirst({
      where: { id: job.contentVariantId, workspaceId: this.#workspaceId },
    });
    if (!variant)
      return settled(
        await this.#fail(job, 'CONTENT_REJECTED', 'preflight.variant_missing', null, PREFLIGHT),
      );

    /*
     * MEDIA IS RESOLVED BEFORE THE PROVIDER IS CALLED (AC-29.3), and every
     * refusal happens here rather than inside an adapter:
     *
     *   - the PROVIDER'S CEILING, from the activated publishing policy. A
     *     carousel of eleven where the platform takes ten is refused, not
     *     truncated — a post missing its last picture is a post the author did
     *     not approve.
     *   - the ASSET ITSELF, by the port: this workspace, this brand or the
     *     shared shelf, inside the member's scope, READY and CLEAN, of a type
     *     a post can carry. The port throws; nothing is dropped.
     *   - the WIRING: a variant with media and no resolver is refused, because
     *     publishing the caption alone would be worse than not publishing.
     */
    const capabilities = capabilitiesFor(this.#policy, job.provider);
    let media: readonly PublishMedia[] = [];
    if (variant.assetIds.length > 0) {
      if (variant.assetIds.length > capabilities.maxMediaItems) {
        return settled(
          await this.#fail(job, 'UNSUPPORTED', 'preflight.too_many_media', null, PREFLIGHT),
        );
      }
      if (!this.#media) {
        return settled(
          await this.#fail(job, 'CONTENT_REJECTED', 'preflight.media_unavailable', null, PREFLIGHT),
        );
      }
      try {
        media = await this.#media.resolve({
          brandId: job.brandId,
          assetIds: variant.assetIds,
          // D-505 O1: only for a platform that fetches media by URL.
          ...(capabilities.mediaByUrl
            ? { fetchUrlTtlSeconds: this.#policy.media.fetchUrlTtlSeconds }
            : {}),
        });
      } catch {
        // The reason is the port's and is not a customer's to read as prose: a
        // stable code goes on the job and the history screen translates it.
        return settled(
          await this.#fail(job, 'CONTENT_REJECTED', 'preflight.media_rejected', null, PREFLIGHT),
        );
      }
      if (media.length !== variant.assetIds.length) {
        return settled(
          await this.#fail(job, 'CONTENT_REJECTED', 'preflight.media_rejected', null, PREFLIGHT),
        );
      }
      /*
       * D-505 O1 — A PLATFORM THAT FETCHES BY URL GETS ONE FOR EVERY FILE OR
       * NOTHING IS SENT. A store that cannot pre-sign (the development store)
       * cannot serve such a platform, and a post with a missing picture is not
       * the one the author approved.
       */
      if (capabilities.mediaByUrl && media.some((item) => !item.fetchUrl)) {
        return settled(
          await this.#fail(
            job,
            'CONTENT_REJECTED',
            'preflight.media_url_unavailable',
            null,
            PREFLIGHT,
          ),
        );
      }
    }

    /*
     * CONNECTORS A (W2) — THE POST KIND, from the post's format and its media,
     * and it must be one the provider DECLARES. A reel sent to a platform
     * configured for feed posts only is refused here, before any request,
     * rather than rejected by the platform as if the content were at fault.
     */
    const item = await this.#db.contentItem.findFirst({
      where: { id: job.contentItemId, workspaceId: this.#workspaceId },
      select: { contentType: true },
    });
    const postKind = item ? postKindFor(item.contentType, media) : null;
    if (!postKind || !capabilities.postKinds.includes(postKind)) {
      return settled(
        await this.#fail(job, 'UNSUPPORTED', 'preflight.post_kind_unsupported', null, PREFLIGHT),
      );
    }

    /*
     * CONNECTORS A (W3) — THE MEDIA RULES FOR THAT KIND, from configuration:
     * type, size, dimensions, aspect ratio, duration and count. A file the
     * platform would refuse is refused here, with the rule it broke.
     */
    const broken = mediaRuleViolation(capabilities.mediaRules[postKind], media);
    if (broken) {
      return settled(
        await this.#fail(job, 'MEDIA_INVALID', `preflight.media_rule.${broken}`, null, PREFLIGHT),
      );
    }

    /*
     * CONNECTORS A (W12) — PUBLISHING SPENDS FROM THE SAME REQUEST BUDGET AS
     * ANALYTICS, last, so only a request that is really about to leave spends.
     * An empty budget is not a failure and not an attempt: nothing was sent,
     * so the job waits for the window like a reconnect hold waits for the
     * account, and the lateness deadline still applies when it comes back.
     */
    if (capabilities.rateLimit && this.#rateLimiter) {
      const decision = this.#rateLimiter.reserve({
        key: ProviderRateLimiter.keyFor(
          this.#workspaceId,
          job.provider,
          connection.externalAccountId,
        ),
        budget: { ...capabilities.rateLimit, analyticsReserveMilli: 0 },
        priority: 'publishing',
      });
      if (!decision.allowed) {
        return settled(await this.#holdForBudget(job, decision.retryAfterSeconds));
      }
    }

    /*
     * THE JOB IS ALREADY IN A STATE THAT SAYS "WE MAY HAVE SENT THIS", and
     * after this step commits, it says so durably. If this process dies
     * between the commit and the outcome, the row says PUBLISHING, and
     * recovery verifies rather than resends.
     */
    return {
      kind: 'send',
      send: {
        jobId: job.id,
        claimedAt: now,
        startedAt: this.#clock.now(),
        adapter: this.#registry.get(job.provider),
        credentials,
        request: {
          externalAccountId: connection.externalAccountId,
          body: variant.body ?? '',
          hashtags: variant.hashtags,
          firstComment: variant.firstComment,
          media,
          idempotencyKey: job.idempotencyKey,
          postKind,
          linkUrl: variant.linkUrl,
          options: plainOptions(variant.platformOptions),
        },
      },
    };
  }

  /**
   * STEP 3 OF 3 — RECORD WHAT THE PROVIDER SAID, in a second transaction (W1).
   *
   * THE ROW IS LOCKED, THEN THE CLAIM IS CHECKED. The outcome belongs to the
   * claim that sent it: the job must still be PUBLISHING under that claim, or
   * VERIFICATION_PENDING because recovery decided the claim was dead (a worker
   * that is alive after all settles it with the real answer, as before). Any
   * other state means the job moved on without us — the attempt is still
   * recorded, because it happened, and a post that DID land is still recorded
   * as published unless another claim is in flight; nothing else is changed.
   *
   * PR 0 — THE ATTEMPT IS NUMBERED HERE, after the highest one recorded, not
   * when the claim was taken. Recovery may have recorded an unknown-send-state
   * row in between, and numbering it then would collide with that row.
   */
  async concludeExecution(send: PreparedSend, report: SendReport): Promise<ExecuteResult> {
    const job = await this.#lockJob(send.jobId);
    if (!job) throw publishJobNotFound();

    const mismatches =
      report.kind === 'answered' && report.outcome.ok === true
        ? observationMismatches(send.request, report.outcome.observed)
        : [];
    const attempt = attemptFromReport(report, mismatches);
    const landed = landedPost(report);
    const ours =
      job.claimedAt !== null &&
      job.claimedAt.getTime() === send.claimedAt.getTime() &&
      (job.status === 'PUBLISHING' || job.status === 'VERIFICATION_PENDING');

    const attemptId = await this.#recordAttempt({
      job,
      attemptNumber: await this.#nextAttemptNumber(job.id),
      startedAt: send.startedAt,
      ...attempt,
    });

    /*
     * W12 — THE PLATFORM SAID "TOO MANY". Whatever our own arithmetic said, the
     * window is spent for this account, so our optimism cannot try again at
     * once (the platform is the authority on its own limit).
     */
    const capabilities = capabilitiesFor(this.#policy, job.provider);
    if (attempt.failureClass === 'RATE_LIMITED' && capabilities.rateLimit && this.#rateLimiter) {
      this.#rateLimiter.markRefusedByProvider(
        ProviderRateLimiter.keyFor(this.#workspaceId, job.provider, send.request.externalAccountId),
        { ...capabilities.rateLimit, analyticsReserveMilli: 0 },
      );
    }

    if (!ours) {
      // THE JOB MOVED ON. A post that went out is still the truth, unless
      // another claim is mid-send and will record its own answer.
      if (landed && job.status !== 'PUBLISHED' && job.status !== 'PUBLISHING') {
        return this.#succeed(job, landed.externalPostId, landed.externalPostUrl);
      }
      return {
        jobId: job.id,
        status: job.status,
        failureClass: job.failureClass,
        externalPostId: job.externalPostId,
      };
    }

    if (report.kind === 'answered' && report.outcome.ok === 'pending') {
      return this.#awaitPublish(job, report.outcome.providerHandle);
    }
    if (report.kind === 'answered' && report.outcome.ok === true) {
      const result = await this.#succeed(
        job,
        report.outcome.externalPostId,
        report.outcome.externalPostUrl,
      );
      if (mismatches.length > 0) await this.#auditMismatch(job, mismatches);
      return result;
    }
    const failureClass = attempt.failureClass ?? 'UNKNOWN';
    const failureCode =
      report.kind === 'answered' && report.outcome.ok === false
        ? report.outcome.failureCode
        : `adapter.${failureClass.toLowerCase()}`;
    return this.#afterFailure(
      job,
      attemptId,
      failureClass,
      failureCode,
      report.lookup,
      report.kind === 'answered' && report.outcome.ok === false
        ? report.outcome.retryAfterSeconds
        : undefined,
    );
  }

  /**
   * CONNECTORS A (W5) — THE PLATFORM HAS THE POST AND HAS NOT FINISHED IT.
   *
   * The handle is stored and the job waits in VERIFICATION_PENDING — the state
   * that means "we may have sent this" — to be asked about every
   * `publishPollSeconds`, never resent. The class is TIMEOUT because that is
   * the existing name for "sent, outcome not yet known" (and the attempt's
   * CHECK requires one); the code says it is a publish in progress.
   */
  async #awaitPublish(job: PublishJob, providerHandle: string): Promise<ExecuteResult> {
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'VERIFICATION_PENDING',
        providerHandle,
        attemptCount: { increment: 1 },
        failureClass: 'TIMEOUT',
        failureCode: PUBLISH_IN_PROGRESS_CODE,
        nextAttemptAt: new Date(
          this.#clock.now().getTime() + this.#policy.dispatch.publishPollSeconds * 1_000,
        ),
      },
    });
    await this.#syncLifecycle(job);
    return {
      jobId: job.id,
      status: 'VERIFICATION_PENDING',
      failureClass: 'TIMEOUT',
      externalPostId: null,
    };
  }

  /**
   * CONNECTORS A (R8) — THE POST WENT OUT, AND THE PLATFORM'S COPY DIFFERS
   * FROM THE PREVIEW. It is still PUBLISHED — it is live, and saying otherwise
   * would be false — but the difference is recorded: the attempt's summary
   * names the fields, and this event says so for support. The NAMES of the
   * fields only; never the caption.
   */
  async #auditMismatch(job: PublishJob, mismatches: readonly string[]): Promise<void> {
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.post.result_mismatch',
      actorType: 'SYSTEM',
      resourceType: 'PublishJob',
      resourceId: job.id,
      brandId: job.brandId,
      after: { provider: job.provider, differs: [...mismatches] },
    });
  }

  /**
   * What happens after a failed attempt — and the duplicate-prevention rule.
   *
   * AN INDETERMINATE OUTCOME IS VERIFIED, NEVER RESENT. If the adapter looked
   * the post up and found it, the job SUCCEEDED and we say so. If it could not
   * look it up at all — or asked and got no answer — the job stops and a human
   * decides: resending a post that may already be live is the one failure this
   * whole design exists to avoid.
   *
   * W1 — THE LOOKUP HAPPENED OUTSIDE ANY TRANSACTION, in the send step, and
   * this method only reads its answer. A lookup that threw used to abort the
   * worker's transaction and return the job to QUEUED; it is now "no answer",
   * which is VERIFICATION_PENDING.
   */
  async #afterFailure(
    job: PublishJob,
    attemptId: string,
    failureClass: PublishFailureClass,
    failureCode: string,
    lookup: LookupReport | null,
    retryAfterSeconds?: number,
  ): Promise<ExecuteResult> {
    const behaviour = FAILURE_BEHAVIOUR[failureClass];

    if (behaviour.indeterminate) {
      if (lookup?.kind === 'found') {
        return this.#succeed(job, lookup.externalPostId, lookup.externalPostUrl);
      }
      if (lookup?.kind !== 'absent') {
        /*
         * WE CANNOT ASK, OR ASKED AND HEARD NOTHING, SO WE STOP. The
         * alternative is to guess, and a wrong guess posts twice.
         * `VERIFICATION_PENDING` is a state a human can act on; a second send
         * is not something they can undo.
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

    if (behaviour.needsReconnect) await this.#markNeedsReauth(job, failureClass);

    const attemptCount = job.attemptCount + 1;
    const exhausted = attemptCount >= job.maxAttempts;
    if (!behaviour.retryable || exhausted) {
      return this.#fail(job, failureClass, failureCode, attemptCount, {
        kind: 'attempt',
        attemptId,
      });
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
  /**
   * PR 0 — A FRESH BUDGET FOR A HUMAN DECISION, WITHOUT REWINDING THE HISTORY.
   *
   * `retry`, `retryOnReconnectedAccount` and `resolveVerification(NOT_PUBLISHED)`
   * used to write `attemptCount: 0`. The count is part of the attempt history
   * the next provider attempt is numbered from, and rewinding it re-used
   * attempt number 1 (see `execute`). So the count stays where it is and the
   * CEILING moves instead: the job gets exactly `retry.maxAttempts` more
   * attempts, which is the budget a reset gave it, and `attemptCount <=
   * maxAttempts` (the table's CHECK) still holds.
   */
  #freshBudget(job: PublishJob): { maxAttempts: number } {
    return { maxAttempts: job.attemptCount + this.#policy.retry.maxAttempts };
  }

  async #scheduleRetry(
    job: PublishJob,
    failureClass: PublishFailureClass,
    failureCode: string,
    attemptCount: number,
    retryAfterSeconds?: number,
  ): Promise<ExecuteResult> {
    const retry = this.#policy.retry;
    /*
     * THE BACKOFF COUNTS FROM THE LATEST BUDGET, NOT FROM THE WHOLE HISTORY.
     *
     * A human retry used to reset `attemptCount`, so the first automatic retry
     * after it waited the INITIAL step. The count is no longer reset (PR 0); the
     * budget is granted by extending `maxAttempts` by the policy's own number
     * (`#freshBudget`), so the attempts spent inside the current budget are
     * `attemptCount - (maxAttempts - retry.maxAttempts)` — exactly the old
     * count while the policy is unchanged, and never below 1 if it was edited.
     */
    const budgetStart = Math.max(0, job.maxAttempts - retry.maxAttempts);
    const attemptsInBudget = Math.max(1, attemptCount - budgetStart);
    const base =
      retryAfterSeconds ??
      Math.min(
        retry.initialBackoffSeconds * Math.pow(retry.backoffMultiplier, attemptsInBudget - 1),
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
        // A new send gets a new handle (W5).
        providerHandle: null,
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
    /*
     * THE AUTOMATION EVENT (A1). `POST_PUBLISHED` had no producer.
     *
     * HERE, AND NOT AT THE CALL SITES. `#succeed` is reached three ways — a
     * clean send, a retry that worked, and an INDETERMINATE outcome the adapter
     * later verified as live — and every one of them is the post going out. A
     * producer at the first call site only would have made "it published on the
     * second attempt" a silent non-event for every rule listening.
     *
     * THE KEY IS THE JOB'S ID, so all three paths converge on ONE event even if
     * verification and the original attempt both arrive at this line.
     */
    await recordAutomationEvent(
      this.#db,
      this.#workspaceId,
      { triggerType: 'POST_PUBLISHED', refType: 'PublishJob' },
      { brandId: job.brandId, refId: job.id },
    );
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
    evidence: FailureEvidence,
  ): Promise<ExecuteResult> {
    const now = this.#clock.now();
    const concludingAttemptId = await this.#concludingAttempt(job, failureClass, evidence);
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
    /*
     * PHASE 2B-3 PR 2 — THE AUTOMATION EVENT for "a post failed to publish".
     *
     * HERE, AND ONLY HERE, because `#fail` is the one writer of FAILED: every
     * path — a provider refusal, an exhausted retry budget, a pre-flight
     * refusal, a verification that could not be resolved — passes through it,
     * and an automatic retry or a reconnect hold never does. One event per
     * transition, keyed by the attempt that concluded it, so a redelivery of
     * the same failure is the same event and a later failure of the same job
     * (after a person retried it) is a new one.
     */
    await recordAutomationEvent(
      this.#db,
      this.#workspaceId,
      { triggerType: 'POST_FAILED', refType: 'PublishAttempt' },
      { brandId: job.brandId, refId: concludingAttemptId },
    );
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
  // Verification and recovery: deciding what happened, never re-sending.
  // -------------------------------------------------------------------------

  /**
   * Resolve a job whose outcome is UNKNOWN — by asking, never by re-sending.
   *
   * THIS METHOD CONTAINS NO CALL TO `adapter.publish()`, AND THAT IS THE POINT
   * (D-143). `VERIFICATION_PENDING` means the request left and the answer did
   * not come back, so the post may already be live. There are exactly three
   * honest answers and this returns one of them:
   *
   *   - THE PROVIDER CAN BE ASKED AND SAYS THE POST IS THERE. It published. We
   *     record the external id we were given and stop.
   *   - THE PROVIDER CAN BE ASKED AND SAYS IT IS NOT THERE. Nothing went out,
   *     so the job may go back on the queue and be sent — once — through the
   *     ordinary path. The provider's answer is what authorises that, not a
   *     timer and not an assumption.
   *   - THE PROVIDER CANNOT BE ASKED. We stop, and a human decides. A provider
   *     with `supportsPostLookup: false` is NEVER automatically resent, no
   *     matter how long it has been waiting: elapsed time is not evidence.
   *
   * IDEMPOTENT AND SAFE TO CALL REPEATEDLY. A job in any other status is
   * returned unchanged, so a duplicate delivery does nothing.
   */
  async verify(jobId: string): Promise<ExecuteResult> {
    return verifyPublishJob(this.#inPlace, jobId);
  }

  /**
   * STEP 1 OF 3 OF A VERIFICATION — decide whether there is anything to ask,
   * and gather what asking needs (W1). Runs in its own transaction; the
   * question itself is asked outside any.
   */
  async beginVerification(jobId: string): Promise<VerificationStep> {
    const job = await this.#db.publishJob.findFirst({
      where: { id: jobId, workspaceId: this.#workspaceId },
    });
    if (!job) throw publishJobNotFound();
    if (job.status !== 'VERIFICATION_PENDING') {
      return settled({
        jobId: job.id,
        status: job.status,
        failureClass: job.failureClass,
        externalPostId: job.externalPostId,
      });
    }

    const adapter = this.#registry.get(job.provider);
    // W5: a publish the platform accepted is asked about by its handle.
    const byHandle = job.providerHandle !== null && Boolean(adapter.checkPublish);
    if (
      !byHandle &&
      (!adapter.capabilities.supportsPostLookup || !adapter.findPostByIdempotencyKey)
    ) {
      // NOT A FAILURE AND NOT A RETRY. It stays where a human can see it.
      return settled({
        jobId: job.id,
        status: 'VERIFICATION_PENDING',
        failureClass: job.failureClass,
        externalPostId: null,
      });
    }

    const connection = await this.#db.socialConnection.findFirst({
      where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
    });
    if (!connection)
      return settled(
        await this.#fail(job, 'NOT_CONNECTED', 'verify.not_connected', null, VERIFIED),
      );

    const credentials = await this.#credentialsFor(connection.id);
    if (!credentials)
      return settled(
        await this.#fail(job, 'NOT_CONNECTED', 'verify.no_credential', null, VERIFIED),
      );

    return {
      kind: 'lookup',
      lookup: {
        jobId: job.id,
        adapter,
        credentials,
        externalAccountId: connection.externalAccountId,
        idempotencyKey: job.idempotencyKey,
        providerHandle: byHandle ? job.providerHandle : null,
      },
    };
  }

  /**
   * STEP 3 OF 3 OF A VERIFICATION — act on the provider's answer, in a second
   * transaction (W1). The row is locked and must still be VERIFICATION_PENDING:
   * a worker that settled it meanwhile, or a person who resolved it, already
   * gave the answer, and this one is not written over it.
   */
  async concludeVerification(lookup: PreparedLookup, report: LookupReport): Promise<ExecuteResult> {
    const job = await this.#lockJob(lookup.jobId);
    if (!job) throw publishJobNotFound();
    if (
      job.status !== 'VERIFICATION_PENDING' ||
      report.kind === 'unanswered' ||
      report.kind === 'pending'
    ) {
      /*
       * WE ASKED AND COULD NOT GET AN ANSWER — or the platform is still
       * working on it, or the job no longer needs one. "No answer" is not "it
       * did not publish"; it is the same uncertainty we started with, so the
       * job does not move. The provider's own words are not repeated for the
       * usual reason.
       *
       * W5 — A PUBLISH IN PROGRESS IS ASKED AGAIN after `publishPollSeconds`,
       * for at most `publishPollMaxMinutes` from when it was sent; after that
       * it waits for a person, like every outcome we cannot confirm.
       */
      if (job.status === 'VERIFICATION_PENDING' && job.providerHandle !== null) {
        await this.#db.publishJob.update({
          where: { id: job.id },
          data: { nextAttemptAt: this.#nextPoll(job) },
        });
      }
      return {
        jobId: job.id,
        status: job.status,
        failureClass: job.failureClass,
        externalPostId: job.externalPostId,
      };
    }

    if (report.kind === 'found') {
      return this.#succeed(job, report.externalPostId, report.externalPostUrl);
    }

    /*
     * W5 — THE PLATFORM FINISHED, AND THE PUBLISH FAILED. Nothing went out, on
     * the platform's own word, so this is an ordinary determinate failure: a
     * class that a retry can fix goes back on the queue within its budget, an
     * account problem marks the account, and anything else fails with the
     * attempt that sent it as its evidence.
     */
    if (report.kind === 'failed') {
      const behaviour = FAILURE_BEHAVIOUR[report.failureClass];
      if (behaviour.needsReconnect) await this.#markNeedsReauth(job, report.failureClass);
      if (!behaviour.retryable || job.attemptCount >= job.maxAttempts) {
        return this.#fail(job, report.failureClass, report.failureCode, job.attemptCount, VERIFIED);
      }
      return this.#scheduleRetry(job, report.failureClass, report.failureCode, job.attemptCount);
    }

    /*
     * THE PROVIDER SAYS NOTHING LANDED. Only now may this be sent again, and
     * only through the ordinary QUEUED path with its attempt budget intact — so
     * a verification that keeps answering "not there" cannot loop for ever.
     */
    const attemptCount = job.attemptCount;
    if (attemptCount >= job.maxAttempts) {
      return this.#fail(
        job,
        job.failureClass ?? 'TIMEOUT',
        'verify.exhausted',
        attemptCount,
        VERIFIED,
      );
    }
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        claimedAt: null,
        providerHandle: null,
        failureCode: 'verify.not_published',
        nextAttemptAt: this.#clock.now(),
      },
    });
    return {
      jobId: job.id,
      status: 'QUEUED',
      failureClass: job.failureClass,
      externalPostId: null,
    };
  }

  /**
   * Recover a job whose worker died between the claim and the answer.
   *
   * THE GAP THIS CLOSES (D-143). `execute()` moves a job to PUBLISHING before
   * the external call — the right order, because if the process dies in between
   * the row already says "we may have sent this". But the reconciliation sweep
   * only ever re-dispatched QUEUED jobs, so such a row stayed PUBLISHING for
   * ever, with the post possibly live, the customer shown "Publishing", and
   * nothing in the system looking at it again.
   *
   * THE LEASE IS THE EVIDENCE OF DEATH, AND IT IS NOT EVIDENCE OF ANYTHING
   * ELSE. Past `claimLeaseSeconds` the claim is treated as abandoned and the
   * job moves to `VERIFICATION_PENDING` — the state that means UNKNOWN — and is
   * then resolved by `verify()`, which asks the provider or stops. A timer
   * never authorises a send.
   *
   * THE MOVE IS A CONDITIONAL UPDATE, so a worker that is alive after all and
   * settles a millisecond later simply wins: its `PUBLISHED` or `FAILED` write
   * lands on top, and the row records the real outcome rather than the guess.
   *
   * W1 — THE MOVE COMMITS ON ITS OWN, and the verification that follows runs
   * as its own steps, so a slow lookup cannot roll the move back.
   */
  async recoverStaleClaim(jobId: string): Promise<ExecuteResult> {
    return recoverStalePublishJob(this.#inPlace, jobId);
  }

  /**
   * The recovery's database step: move a claim past its lease to
   * VERIFICATION_PENDING and record that its send state is unknown. `null`
   * when the claim was recovered and should now be verified; otherwise the
   * job's current answer, untouched.
   */
  async claimStale(jobId: string): Promise<ExecuteResult | null> {
    const now = this.#clock.now();
    const deadline = new Date(now.getTime() - this.#policy.dispatch.claimLeaseSeconds * 1_000);

    const moved = await this.#db.publishJob.updateMany({
      where: {
        id: jobId,
        workspaceId: this.#workspaceId,
        status: 'PUBLISHING',
        claimedAt: { lt: deadline },
      },
      data: {
        status: 'VERIFICATION_PENDING',
        // TIMEOUT is the truthful class: the request left and no answer came.
        failureClass: 'TIMEOUT',
        failureCode: 'recovery.claim_expired',
        nextAttemptAt: null,
      },
    });
    if (moved.count !== 1) {
      const current = await this.#db.publishJob.findFirst({
        where: { id: jobId, workspaceId: this.#workspaceId },
      });
      if (!current) throw publishJobNotFound();
      /*
       * W5 — A PUBLISH THE PLATFORM ACCEPTED is polled through this same
       * message: it is already VERIFICATION_PENDING, holds a handle, and the
       * verification that follows asks `checkPublish`. Still no path to a send.
       */
      if (current.status === 'VERIFICATION_PENDING' && current.providerHandle !== null) {
        return null;
      }
      return {
        jobId: current.id,
        status: current.status,
        failureClass: current.failureClass,
        externalPostId: current.externalPostId,
      };
    }

    /*
     * PHASE 2B-3 PR 2 (D1) — THE RECOVERY IS RECORDED AS AN ATTEMPT whose send
     * state is unknown. Not a provider answer and not a claim that a request
     * reached the platform: the worker holding the claim stopped, and nobody
     * knows whether it sent. The verification that follows, and any failure it
     * concludes with, cites this row.
     */
    const recovered = await this.#db.publishJob.findFirst({
      where: { id: jobId, workspaceId: this.#workspaceId },
    });
    if (!recovered) throw publishJobNotFound();
    await this.#recordUnknownSendState(recovered, recovered.claimedAt ?? now);

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.post.claim_recovered',
      actorType: 'SYSTEM',
      resourceType: 'PublishJob',
      resourceId: jobId,
      brandId: undefined,
      before: { status: 'PUBLISHING' },
      after: { status: 'VERIFICATION_PENDING', reason: 'claim_expired' },
    });
    return null;
  }

  /** R3 — the account needs reconnecting; its owner hears it once (`reauth.ts`). */
  async #markNeedsReauth(job: PublishJob, failureClass: PublishFailureClass): Promise<void> {
    await markNeedsReauth({
      db: this.#db,
      workspaceId: this.#workspaceId,
      connectionId: job.socialConnectionId,
      failureClass,
      now: this.#clock.now(),
      notifier: this.#notifier?.connectionNeedsReauth
        ? (this.#notifier as ReauthNotifier)
        : undefined,
    });
  }

  /**
   * W5 — when a publish in progress is asked about next: `publishPollSeconds`
   * from now, until `publishPollMaxMinutes` after it was sent; then never
   * (null), and a person decides.
   */
  #nextPoll(job: PublishJob): Date | null {
    const now = this.#clock.now().getTime();
    const sentAt = (job.startedAt ?? job.claimedAt ?? job.updatedAt).getTime();
    if (now - sentAt >= this.#policy.dispatch.publishPollMaxMinutes * 60_000) return null;
    return new Date(now + this.#policy.dispatch.publishPollSeconds * 1_000);
  }

  /**
   * W1 — LOCK THE JOB'S ROW for the rest of this transaction, then read it.
   * Two record steps for one job (a late worker and a recovery's verification)
   * are serialized here, so each sees the other's answer.
   */
  async #lockJob(jobId: string): Promise<PublishJob | null> {
    await this.#db.$queryRaw`
      SELECT "id" FROM "publish_job"
       WHERE "id" = ${jobId}::uuid
         AND "workspaceId" = ${this.#workspaceId}::uuid
       FOR UPDATE`;
    return this.#db.publishJob.findFirst({
      where: { id: jobId, workspaceId: this.#workspaceId },
    });
  }

  /**
   * Resolve a verification by hand, when the provider cannot be asked.
   *
   * THE ONLY WAY AN UNVERIFIABLE JOB LEAVES `VERIFICATION_PENDING`, and it
   * requires a person to state which of the two things happened. That is the
   * honest shape: we genuinely do not know, the provider cannot tell us, and
   * guessing in either direction has a cost — a duplicate post one way, a
   * missing one the other.
   *
   * `PUBLISHED` NEEDS THE EXTERNAL ID. Not bureaucracy: the database CHECK
   * `publish_job_published_has_post` refuses a published job without one, and a
   * human who has found the post in order to confirm it is holding its id.
   */
  async resolveVerification(input: {
    jobId: string;
    actorUserId: string;
    brandScope: readonly string[];
    resolution: 'PUBLISHED' | 'NOT_PUBLISHED';
    externalPostId?: string | undefined;
    externalPostUrl?: string | undefined;
  }): Promise<ExecuteResult> {
    const job = await this.#db.publishJob.findFirst({
      where: { id: input.jobId, ...brandIdQueryFilter({ brandScope: input.brandScope }) },
    });
    if (!job) throw publishJobNotFound();
    if (job.status !== 'VERIFICATION_PENDING') throw publishJobNotRetryable();

    if (input.resolution === 'PUBLISHED') {
      if (!input.externalPostId) throw publishJobNotRetryable();
      await writeAuditEvent(this.#db, this.#workspaceId, {
        action: 'social.post.verification_resolved',
        actorType: 'USER',
        actorId: input.actorUserId,
        resourceType: 'PublishJob',
        resourceId: job.id,
        brandId: job.brandId,
        before: { status: job.status },
        after: { resolution: 'PUBLISHED' },
      });
      return this.#succeed(job, input.externalPostId, input.externalPostUrl ?? null);
    }

    const now = this.#clock.now();
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        // A PERSON DECIDED TO SEND IT, so the budget starts again — same rule
        // as a manual retry, and for the same reason. The history does not.
        ...this.#freshBudget(job),
        providerHandle: null,
        nextAttemptAt: now,
        completedAt: null,
        claimedAt: null,
        failureClass: null,
        failureCode: null,
      },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.post.verification_resolved',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'PublishJob',
      resourceId: job.id,
      brandId: job.brandId,
      before: { status: job.status },
      after: { resolution: 'NOT_PUBLISHED', status: 'QUEUED' },
    });
    return { jobId: job.id, status: 'QUEUED', failureClass: null, externalPostId: null };
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
   * WOULD `retry()` REFUSE THIS JOB, AND WHY? READ-ONLY (Phase 2B-3 PR 5, D3).
   *
   * The same checks `retry()` makes, in the same order, without changing
   * anything — so an automation can decline to ask a person to approve a retry
   * that is certain to be refused, and say why. `null` means a retry would be
   * accepted now; it is not a promise, and `retry()` checks again.
   */
  async retryRefusal(input: {
    jobId: string;
    brandScope: readonly string[];
  }): Promise<RetryRefusal | null> {
    return publishRetryRefusal({
      db: this.#db,
      workspaceId: this.#workspaceId,
      policy: this.#policy,
      clock: this.#clock,
      ...input,
    });
  }

  #retryRefusal(job: PublishJob): Promise<RetryRefusal | null> {
    return refusalForJob(this.#db, this.#workspaceId, this.#policy, this.#clock, job);
  }

  /**
   * Retry by hand, after a human has fixed whatever was wrong.
   *
   * REFUSED FOR CLASSES WHERE RETRYING CANNOT HELP. `AUTH_REVOKED` needs a
   * reconnection, not another attempt, and offering a button that cannot work
   * is worse than not offering one.
   *
   * `FAILED` ONLY. `VERIFICATION_PENDING` IS NOT RETRYABLE, AND THAT WAS A REAL
   * HOLE (D-143). The first version accepted both, and `TIMEOUT` and
   * `PLATFORM_UNAVAILABLE` are both `indeterminate: true` AND
   * `manualRetryUseful: true` — so a customer pressing Retry on a post whose
   * outcome was deliberately recorded as UNKNOWN sent it again. A button in the
   * product, two clicks from the publishing history, that produced exactly the
   * duplicate post the indeterminate state exists to prevent.
   *
   * An unknown outcome is not a failure to retry, it is a question to answer.
   * `resolveVerification()` is where it is answered, by a person saying which
   * of the two things happened — and only a "NOT_PUBLISHED" from that person,
   * or a provider lookup in `verify()`, ever puts such a job back on the queue.
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
    const refusal = await this.#retryRefusal(job);
    // D-332 (owner decision): a retry never publishes late. Refused, not queued.
    if (refusal === 'deadline_passed') throw publishJobPastDeadline();
    // Item 9 (D-332 amended): the post was scheduled again; this attempt is history.
    if (refusal === 'superseded') throw publishJobSuperseded();
    if (refusal) throw publishJobNotRetryable();

    const now = this.#clock.now();
    /*
     * A CONDITIONAL WRITE, NOT READ-THEN-WRITE (Phase 2B-3 PR 5). The checks
     * above read a FAILED job; two retries racing — a person's and an approved
     * automation's — would both pass them and both re-queue it. The status in
     * the WHERE makes the database the referee: exactly one moves the job, and
     * the other is refused as the job no longer being retryable.
     */
    const queued = await this.#db.publishJob.updateMany({
      where: { id: job.id, workspaceId: this.#workspaceId, status: 'FAILED' },
      data: {
        status: 'QUEUED',
        // A FRESH ATTEMPT BUDGET, because a human deciding to try again is a
        // new decision, not a continuation of the automatic schedule. The
        // history is not rewound (PR 0): see `#freshBudget`.
        ...this.#freshBudget(job),
        providerHandle: null,
        nextAttemptAt: now,
        completedAt: null,
        claimedAt: null,
        failureClass: null,
        failureCode: null,
      },
    });
    if (queued.count !== 1) throw publishJobNotRetryable();

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

  /**
   * RETRY THROUGH THE SAME ACCOUNT, RECONNECTED (Phase 6 final, D-277 §33, D-291).
   *
   * THE GAP THIS CLOSES. A post that failed because its ACCOUNT was broken
   * (`AUTH_REVOKED`, `INSUFFICIENT_SCOPE`, `AUTH_EXPIRED`) could not be tried
   * again after the customer fixed the account: `retry()` refuses the classes
   * a retry alone cannot fix (`manualRetryUseful: false`) — correctly, while
   * the account is still broken — and nothing said when it no longer was.
   *
   * WHAT IS ALLOWED, AND NOTHING MORE:
   *   - the job is FAILED with one of those account classes — never an
   *     indeterminate one, whose last request may have landed;
   *   - the account the post was meant for is ACTIVE now and its credential
   *     was renewed AFTER the failure: the job's own connection reconnected in
   *     place, or — after a disconnect — a new connection for the SAME brand,
   *     provider and external account, never "some other page on the same
   *     platform";
   *   - on a new connection, no job already exists for the slot, variant and
   *     that connection. The job is RE-BOUND rather than duplicated: one job
   *     per slot and account keeps the slot's lifecycle (derived from all its
   *     jobs) honest, and the idempotency key becomes exactly the one
   *     `materialiseSlot` would have written. Nothing was published under the
   *     old key — the failure was a determinate refusal.
   *
   * IT ONLY QUEUES. Every check in `#preflight` — approval, cancellation,
   * content, rights, lateness — runs again before anything is sent, and the
   * request is a person pressing Retry: nothing does this on their behalf.
   */
  async retryOnReconnectedAccount(input: {
    jobId: string;
    actorUserId: string;
    brandScope: readonly string[];
  }): Promise<ExecuteResult> {
    const job = await this.#db.publishJob.findFirst({
      where: { id: input.jobId, ...brandIdQueryFilter({ brandScope: input.brandScope }) },
    });
    if (!job) throw publishJobNotFound();
    if (job.status !== 'FAILED' || !retryableAfterReconnect(job)) {
      throw publishJobNotRetryable();
    }
    /*
     * D-332 (owner decision): THE TIME PASSED WHILE THE ACCOUNT WAS
     * DISCONNECTED, so the post is not published late. Refused before anything
     * changes: the job stays FAILED with the failure it recorded, and nothing
     * is queued or sent.
     */
    if (this.pastLatenessDeadline(job.scheduledAtUtc)) throw publishJobPastDeadline();
    // Item 9 (D-332 amended): the post was scheduled again; this attempt is history.
    if ((await this.supersededJobs([job.id])).has(job.id)) throw publishJobSuperseded();
    const replacement = await this.#reconnectedConnection(job);
    if (!replacement) throw publishJobNotRetryable();

    const rebinding = replacement.id !== job.socialConnectionId;
    const idempotencyKey = rebinding
      ? publishIdempotencyKey({
          workspaceId: this.#workspaceId,
          calendarSlotId: job.calendarSlotId,
          socialConnectionId: replacement.id,
          contentVariantId: job.contentVariantId,
        })
      : job.idempotencyKey;
    if (rebinding) {
      const clash = await this.#db.publishJob.findFirst({
        where: { workspaceId: this.#workspaceId, idempotencyKey },
        select: { id: true },
      });
      if (clash) throw publishJobNotRetryable();
    }

    const now = this.#clock.now();
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        socialConnectionId: replacement.id,
        idempotencyKey,
        status: 'QUEUED',
        ...this.#freshBudget(job),
        providerHandle: null,
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
      before: {
        status: job.status,
        failureClass: job.failureClass,
        socialConnectionId: job.socialConnectionId,
      },
      after: { status: 'QUEUED', socialConnectionId: replacement.id, via: 'reconnected_account' },
    });
    return { jobId: job.id, status: 'QUEUED', failureClass: null, externalPostId: null };
  }

  /**
   * Which of these failed jobs could be retried through a reconnected account
   * — for the screen, so the button exists exactly when the action would be
   * accepted. Read-only; the same rule as `retryOnReconnectedAccount`.
   */
  async reconnectedRetryable(jobIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (jobIds.length === 0) return new Set();
    const jobs = await this.#db.publishJob.findMany({
      where: { workspaceId: this.#workspaceId, id: { in: [...jobIds] }, status: 'FAILED' },
    });
    const ready = new Set<string>();
    const superseded = await this.supersededJobs(jobs.map((job) => job.id));
    for (const job of jobs) {
      if (!retryableAfterReconnect(job)) continue;
      // Past its deadline it cannot be retried (D-332), so it is not offered.
      if (this.pastLatenessDeadline(job.scheduledAtUtc)) continue;
      // Scheduled again as a new slot (item 9): history, not offered.
      if (superseded.has(job.id)) continue;
      if (await this.#reconnectedConnection(job)) ready.add(job.id);
    }
    return ready;
  }

  /**
   * ITEM 9 — whether this brand requires approval before scheduling, so a
   * screen offers "Reschedule" (the calendar) or "Send for review again" (the
   * post) for a failed post. The same gate `#preflight` and `schedule()` read.
   */
  async approvalRequiredFor(brandId: string): Promise<boolean> {
    return (await this.#approvals.policyForBrand(brandId)).requireApprovalBeforeScheduling;
  }

  /**
   * ITEM 9 (Phase 2B-2, D-332 amended) — which of these jobs belong to a slot
   * that a NEWER, non-cancelled slot of the same post has replaced. Such a job
   * is history: both retry paths refuse it and the screens offer no Retry.
   * Read-only, and one query per call.
   */
  async supersededJobs(jobIds: readonly string[]): Promise<ReadonlySet<string>> {
    return supersededJobIds(this.#db, this.#workspaceId, jobIds);
  }

  /**
   * Has this post's LATENESS DEADLINE passed — its scheduled time plus the
   * configured tolerance? The same measure the preflight uses to stop a post
   * that is too late to be worth sending, read here so the retry paths refuse
   * it up front and the screens stop offering Retry (D-332). Read-only.
   */
  pastLatenessDeadline(scheduledAtUtc: Date): boolean {
    return this.#clock.now().getTime() - scheduledAtUtc.getTime() > this.#lateness();
  }

  /**
   * The same account, renewed since the job failed and ACTIVE now — or null.
   *
   * Either the job's own connection, reconnected in place (the normal case,
   * `SocialOAuthService#connect`), or — after a disconnect and a fresh
   * connection — the new row for the SAME brand, provider and external
   * account. "Renewed since" is a credential written after the failure
   * (`connectedAt` or `lastRefreshedAt`), so a connection that was merely
   * active all along does not turn a stale failure into a retry.
   */
  async #reconnectedConnection(job: PublishJob): Promise<SocialConnection | null> {
    const failedAt = job.completedAt ?? job.updatedAt;
    const renewed = (connection: SocialConnection) =>
      [connection.connectedAt, connection.lastRefreshedAt].some(
        (at) => at !== null && at.getTime() > failedAt.getTime(),
      );
    const own = await this.#db.socialConnection.findFirst({
      where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
    });
    if (!own) return null;
    if (own.status === 'ACTIVE') return renewed(own) ? own : null;
    const replacement = await this.#db.socialConnection.findFirst({
      where: {
        workspaceId: this.#workspaceId,
        brandId: job.brandId,
        provider: job.provider,
        externalAccountId: own.externalAccountId,
        status: 'ACTIVE',
        id: { not: own.id },
      },
      orderBy: [{ connectedAt: 'desc' }, { id: 'desc' }],
    });
    return replacement && renewed(replacement) ? replacement : null;
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
  /**
   * WAIT FOR THE ACCOUNT TO BE RECONNECTED (Q9, D-332).
   *
   * Nothing was sent and nothing was attempted, so this is not a retry: the
   * attempt count is untouched and no attempt row is written. The job goes
   * back to QUEUED and is looked at again after the configured interval — or
   * just after its lateness deadline, whichever comes first, so a job never
   * waits past the moment it must fail. The code says why it is waiting, and
   * the publishing log shows it.
   */
  /**
   * D-531 (owner, step B) — A JOB WHOSE PLATFORM WAS SWITCHED OFF AFTER IT WAS
   * QUEUED IS HELD, NOT FAILED.
   *
   * This job (just claimed by us) and every sibling still waiting for a
   * switched-off platform are CANCELLED with `held.platform_switched_off` — no
   * attempt is recorded, nothing is FAILED, no notice is sent. Each is audited
   * as SYSTEM.
   *
   * If nothing of the post is left to send, the POST is held exactly as the
   * sweep holds one at its time (`holdPostWithoutChannel`): the slot goes back
   * to PLANNED on its day, its scheduling quota is refunded once, and the
   * item returns to APPROVED (DRAFT with no approval) with its time kept as its
   * proposal. If another channel is still on, that one goes out as usual and
   * the post's state follows its jobs.
   */
  async #holdSwitchedOff(job: PublishJob): Promise<ExecuteResult> {
    const now = this.#clock.now();
    const cancelled = {
      status: 'CANCELLED' as const,
      cancelledAt: now,
      completedAt: now,
      nextAttemptAt: null,
      failureCode: PLATFORM_SWITCHED_OFF_CODE,
    };
    const mine = await this.#db.publishJob.updateMany({
      where: {
        id: job.id,
        workspaceId: this.#workspaceId,
        status: 'PUBLISHING',
        claimedAt: job.claimedAt,
      },
      data: cancelled,
    });
    if (mine.count !== 1) {
      const current = await this.#db.publishJob.findFirst({
        where: { id: job.id, workspaceId: this.#workspaceId },
      });
      return {
        jobId: job.id,
        status: current?.status ?? job.status,
        failureClass: current?.failureClass ?? null,
        externalPostId: current?.externalPostId ?? null,
      };
    }

    const waiting = await this.#db.publishJob.findMany({
      where: {
        workspaceId: this.#workspaceId,
        calendarSlotId: job.calendarSlotId,
        status: { in: ['PENDING', 'QUEUED'] },
      },
      select: { id: true, provider: true, status: true },
    });
    const switchedOff = waiting.filter(
      (candidate) => !capabilitiesFor(this.#policy, candidate.provider).enabled,
    );
    if (switchedOff.length > 0) {
      await this.#db.publishJob.updateMany({
        where: {
          id: { in: switchedOff.map((candidate) => candidate.id) },
          workspaceId: this.#workspaceId,
          status: { in: ['PENDING', 'QUEUED'] },
        },
        data: cancelled,
      });
    }
    for (const held of [{ id: job.id, provider: job.provider }, ...switchedOff]) {
      await writeAuditEvent(this.#db, this.#workspaceId, {
        action: 'social.post.cancelled',
        actorType: 'SYSTEM',
        resourceType: 'PublishJob',
        resourceId: held.id,
        brandId: job.brandId,
        after: { status: 'CANCELLED', reason: 'platform_switched_off', provider: held.provider },
      });
    }

    const jobs = await this.#db.publishJob.findMany({
      where: { workspaceId: this.#workspaceId, calendarSlotId: job.calendarSlotId },
      select: { status: true },
    });
    if (jobs.every((candidate) => candidate.status === 'CANCELLED')) {
      await this.#holdPost(job);
    } else {
      await this.#syncLifecycle(job);
    }
    return { jobId: job.id, status: 'CANCELLED', failureClass: null, externalPostId: null };
  }

  /** D-531 — the D-334 path for a post none of whose jobs can go out any more. */
  async #holdPost(job: PublishJob): Promise<void> {
    const slot = await this.#db.calendarSlot.findFirst({
      where: { id: job.calendarSlotId, workspaceId: this.#workspaceId },
    });
    if (!slot || slot.status !== 'PUBLISHING') return;
    const held = await this.#db.calendarSlot.updateMany({
      where: {
        id: slot.id,
        workspaceId: this.#workspaceId,
        status: 'PUBLISHING',
        rescheduleAttempt: slot.rescheduleAttempt,
      },
      data: { status: 'PLANNED', rescheduleAttempt: { increment: 1 } },
    });
    if (held.count === 0) return;
    if (slot.usageIdempotencyKey && this.#scheduleQuota) {
      await this.#scheduleQuota.refund(`${slot.usageIdempotencyKey}:refund`);
    }
    const approval = await this.#approvals.latestForItem(job.contentItemId);
    const itemStatus = approval?.status === 'APPROVED' ? 'APPROVED' : 'DRAFT';
    await this.#db.contentItem.updateMany({
      where: { id: job.contentItemId, workspaceId: this.#workspaceId, status: 'PUBLISHING' },
      data: {
        status: itemStatus,
        proposedLocalTime: slot.scheduledLocalTime,
        publishChoice: 'PICK',
      },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'content.rescheduled',
      actorType: 'SYSTEM',
      resourceType: 'CalendarSlot',
      resourceId: slot.id,
      brandId: slot.brandId,
      after: {
        reason: 'no_connectable_channel',
        fromStatus: 'PUBLISHING',
        toStatus: 'PLANNED',
        localTime: slot.scheduledLocalTime,
        timezone: slot.timezone,
        itemStatus,
      },
    });
  }

  /**
   * D-538 (owner, #82) — WAIT FOR THE TIKTOK OPTIONS. Nothing was sent and
   * nothing was attempted, exactly as a reconnect hold: no attempt row, the
   * attempt count untouched, no failure class, no notice. The job goes back to
   * QUEUED with `held.tiktok_options_missing` and is looked at again after the
   * reconnect interval — or just after its lateness deadline, whichever comes
   * first. Once someone completes the panel, the next look sends it.
   */
  async #holdForOptions(job: PublishJob): Promise<ExecuteResult> {
    const now = this.#clock.now().getTime();
    const deadline = job.scheduledAtUtc.getTime() + this.#lateness();
    const next = Math.min(
      now + this.#policy.dispatch.reconnectRecheckSeconds * 1_000,
      deadline + 1_000,
    );
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        claimedAt: null,
        failureClass: null,
        failureCode: TIKTOK_OPTIONS_HELD_CODE,
        nextAttemptAt: new Date(Math.max(next, now + 1_000)),
      },
    });
    if (job.failureCode !== TIKTOK_OPTIONS_HELD_CODE) {
      await writeAuditEvent(this.#db, this.#workspaceId, {
        action: 'social.post.held',
        actorType: 'SYSTEM',
        resourceType: 'PublishJob',
        resourceId: job.id,
        brandId: job.brandId,
        after: { status: 'QUEUED', reason: 'tiktok_options_missing', provider: job.provider },
      });
    }
    return { jobId: job.id, status: 'QUEUED', failureClass: null, externalPostId: null };
  }

  /**
   * D-538 — THE LATENESS DEADLINE PASSED AND THE OPTIONS ARE STILL NOT CHOSEN.
   * Held exactly as D-531 holds a job whose platform was switched off: this
   * job is CANCELLED with `held.tiktok_options_missing` (no attempt, no
   * FAILED, no notice, a SYSTEM audit), and if nothing of the post is left to
   * send, the post goes back to PLANNED on its day with its quota refunded and
   * its time kept as its proposal; someone completes the panel and schedules
   * it again. If another channel still has its own job, the post's state
   * follows its jobs.
   */
  async #holdWithoutOptions(job: PublishJob): Promise<ExecuteResult> {
    const now = this.#clock.now();
    const mine = await this.#db.publishJob.updateMany({
      where: {
        id: job.id,
        workspaceId: this.#workspaceId,
        status: 'PUBLISHING',
        claimedAt: job.claimedAt,
      },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        completedAt: now,
        nextAttemptAt: null,
        failureClass: null,
        failureCode: TIKTOK_OPTIONS_HELD_CODE,
      },
    });
    if (mine.count !== 1) {
      const current = await this.#db.publishJob.findFirst({
        where: { id: job.id, workspaceId: this.#workspaceId },
      });
      return {
        jobId: job.id,
        status: current?.status ?? job.status,
        failureClass: current?.failureClass ?? null,
        externalPostId: current?.externalPostId ?? null,
      };
    }
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.post.cancelled',
      actorType: 'SYSTEM',
      resourceType: 'PublishJob',
      resourceId: job.id,
      brandId: job.brandId,
      after: { status: 'CANCELLED', reason: 'tiktok_options_missing', provider: job.provider },
    });
    const jobs = await this.#db.publishJob.findMany({
      where: { workspaceId: this.#workspaceId, calendarSlotId: job.calendarSlotId },
      select: { status: true },
    });
    if (jobs.every((candidate) => candidate.status === 'CANCELLED')) {
      await this.#holdPost(job);
    } else {
      await this.#syncLifecycle(job);
    }
    return { jobId: job.id, status: 'CANCELLED', failureClass: null, externalPostId: null };
  }

  async #holdForReconnect(job: PublishJob): Promise<ExecuteResult> {
    const now = this.#clock.now().getTime();
    const deadline = job.scheduledAtUtc.getTime() + this.#lateness();
    const next = Math.min(
      now + this.#policy.dispatch.reconnectRecheckSeconds * 1_000,
      deadline + 1_000,
    );
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        claimedAt: null,
        failureClass: 'NOT_CONNECTED',
        failureCode: AWAITING_RECONNECT_CODE,
        nextAttemptAt: new Date(Math.max(next, now + 1_000)),
      },
    });
    return { jobId: job.id, status: 'QUEUED', failureClass: 'NOT_CONNECTED', externalPostId: null };
  }

  /**
   * CONNECTORS A (W12) — WAIT FOR THE ACCOUNT'S REQUEST BUDGET. Nothing was
   * sent and nothing was attempted, exactly as a reconnect hold: the attempt
   * count is untouched and no attempt row is written. The job comes back when
   * the window reopens; the lateness deadline is checked again then.
   */
  async #holdForBudget(job: PublishJob, retryAfterSeconds: number): Promise<ExecuteResult> {
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        claimedAt: null,
        failureClass: 'RATE_LIMITED',
        failureCode: AWAITING_BUDGET_CODE,
        nextAttemptAt: new Date(
          this.#clock.now().getTime() + Math.max(1, retryAfterSeconds) * 1_000,
        ),
      },
    });
    return { jobId: job.id, status: 'QUEUED', failureClass: 'RATE_LIMITED', externalPostId: null };
  }

  #lateness(): number {
    return this.#policy.dispatch.latenessToleranceMinutes * 60_000;
  }

  async #preflight(job: PublishJob): Promise<PreflightOutcome> {
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
      const approval = await this.#approvals.latestForItem(job.contentItemId);
      if (!approval || approval.status !== 'APPROVED') return 'APPROVAL_REVOKED';

      /*
       * AND THE APPROVAL MUST COVER THIS ITEM, AS IT STANDS NOW (D-223, D-230).
       *
       * Checking that an approval exists and says APPROVED was the whole gate,
       * and it is not enough: `editVariant` returns an APPROVED item to DRAFT
       * but deliberately leaves a SCHEDULED one alone — the calendar owns that
       * edge — while the send below reads `variant.body` live. So
       * submit → approve → schedule → edit → publish put unreviewed words on a
       * customer's channel under a genuine verdict, with every audit row
       * individually true.
       *
       * EVERY VARIANT OF THE ITEM IS READ, not only the one being sent, because
       * the verdict was granted over the POST: its channels, its captions, and
       * the fact that there were that many of them. Comparing one row's hash
       * would miss a channel ADDED after approval — the two original variants
       * are untouched, so they still match — and a channel REMOVED from a
       * campaign a reviewer approved as a whole.
       *
       * A difference anywhere in that set, a variant that did not exist at
       * approval time, or an approval too old to carry a fingerprint at all are
       * the same answer: this verdict does not authorize this post. It fails as
       * APPROVAL_REVOKED rather than publishing, and the history screen already
       * translates that class.
       */
      const variantsNow = await this.#db.contentVariant.findMany({
        where: { contentItemId: job.contentItemId, workspaceId: this.#workspaceId },
        select: {
          id: true,
          platformKey: true,
          locale: true,
          body: true,
          hashtags: true,
          firstComment: true,
          linkUrl: true,
          assetIds: true,
          slides: true,
        },
      });
      if (!variantsNow.some((variant) => variant.id === job.contentVariantId)) {
        return 'CONTENT_REJECTED';
      }
      if (
        !approvalCoversItem(
          readApprovedFingerprint(approval.approvedFingerprint),
          variantsNow,
          job.contentVariantId,
        )
      ) {
        return 'APPROVAL_REVOKED';
      }
    }

    /*
     * D-531 (owner, step B): A PLATFORM SWITCHED OFF AFTER THE JOB WAS QUEUED
     * holds the post — before the account is looked at, so an account that
     * also expired meanwhile cannot turn a hold into a failure.
     */
    if (!capabilitiesFor(this.#policy, job.provider).enabled) return PLATFORM_SWITCHED_OFF;

    const lateByMs = this.#clock.now().getTime() - job.scheduledAtUtc.getTime();
    const tooLate = lateByMs > this.#lateness();

    /*
     * D-538 (owner, #82): A TIKTOK POST WITHOUT ITS OPTIONS IS HELD, NOT SENT
     * AND NOT FAILED. The Studio requires them only when the brand has a
     * TikTok account; an account connected after the post was scheduled leaves
     * it without them. The same check the adapter makes before any call, made
     * here first so the post waits instead of failing. Before the account is
     * looked at, so an account problem cannot turn the hold into a failure.
     */
    if (job.provider === 'TIKTOK') {
      const variant = await this.#db.contentVariant.findFirst({
        where: { id: job.contentVariantId, workspaceId: this.#workspaceId },
        select: { platformOptions: true },
      });
      const forcedPrivate =
        capabilitiesFor(this.#policy, job.provider).forcedAudience === 'private';
      if (
        variant &&
        tiktokOptionsProblems(readTikTokOptions(variant.platformOptions), null, forcedPrivate)
          .length > 0
      ) {
        return tooLate ? TIKTOK_OPTIONS_TOO_LATE : TIKTOK_OPTIONS_MISSING;
      }
    }

    const connection = await this.#db.socialConnection.findFirst({
      where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
      select: { status: true, tokenExpiresAt: true },
    });
    /*
     * REVIEW ITEM 3: AN ACTIVE CONNECTION WHOSE TOKEN HAS EXPIRED IS NOT SENT
     * TO THE PROVIDER. The publishing sweep refreshes it first, through the
     * existing refresh path, on the surface allowed to (F-07); a job that
     * reaches this point with the token still expired — no refresh token, a
     * refused refresh, or one not yet attempted — is treated exactly like one
     * whose account needs reconnecting. The persisted status is not changed
     * here: the refresh path is the one that decides that.
     */
    const tokenExpired =
      connection?.status === 'ACTIVE' &&
      connection.tokenExpiresAt !== null &&
      connection.tokenExpiresAt.getTime() <= this.#clock.now().getTime();
    /*
     * Q9 (D-332): AN ACCOUNT THAT NEEDS RECONNECTING HOLDS ITS JOB until the
     * lateness deadline, then fails it with the reason. A job that waited and
     * whose account came back only after the deadline fails with the same
     * reason — the post is late BECAUSE it waited for the reconnection, and
     * "the destination is unavailable" would not say so.
     */
    if (connection?.status === 'NEEDS_REAUTH' || tokenExpired)
      return tooLate ? RECONNECT_TOO_LATE : AWAITING_RECONNECT;
    if (!connection || connection.status !== 'ACTIVE') return 'NOT_CONNECTED';
    if (tooLate && job.failureCode === AWAITING_RECONNECT_CODE) return RECONNECT_TOO_LATE;

    /*
     * TOO LATE TO BE WORTH SENDING. A time-sensitive post six hours late is
     * worse than one not posted at all, so beyond the configured tolerance the
     * job stops and the customer decides (docs/SOCIAL-INTEGRATIONS.md §8).
     */
    if (tooLate) return 'TARGET_UNAVAILABLE';

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
    outcome:
      | 'SUCCEEDED'
      | 'RETRYABLE_FAILURE'
      | 'PERMANENT_FAILURE'
      | 'INDETERMINATE'
      | 'PREFLIGHT_REFUSED';
    failureClass: PublishFailureClass | null;
    providerStatusCode: number | null;
    providerErrorCode: string | null;
    safeSummary: string | null;
    /** Connectors A (W5): the handle a `pending` answer gave. */
    providerHandle?: string | null;
  }): Promise<string> {
    const finishedAt = this.#clock.now();
    const attempt = await this.#db.publishAttempt.create({
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
        providerHandle: input.providerHandle ?? null,
      },
      select: { id: true },
    });
    return attempt.id;
  }

  /** The next attempt number after the highest one recorded (PR 0). */
  async #nextAttemptNumber(jobId: string): Promise<number> {
    const last = await this.#db.publishAttempt.aggregate({
      where: { workspaceId: this.#workspaceId, publishJobId: jobId },
      _max: { attemptNumber: true },
    });
    return (last._max.attemptNumber ?? 0) + 1;
  }

  /**
   * PHASE 2B-3 PR 2 — THE ATTEMPT A FAILURE CONCLUDES WITH (owner decisions
   * D1/D2). Every transition to FAILED names exactly one attempt row, so the
   * history says which attempt ended the job and a "post failed" event has one
   * stable thing to point at.
   *
   *   - A PROVIDER FAILURE concludes with the row the call itself recorded.
   *   - A PRE-FLIGHT REFUSAL sent nothing, so there is no such row: one
   *     `PREFLIGHT_REFUSED` row is written, numbered after the highest attempt
   *     so far. `attemptCount` is NOT touched — no attempt of the budget was
   *     spent — so `attemptCount <= maxAttempts` and every retry and
   *     idempotency rule stay exactly as they were.
   *   - A VERIFICATION FAILURE concludes with the attempt being verified: the
   *     latest row, which is INDETERMINATE by construction (a job reaches
   *     VERIFICATION_PENDING only after one is written — by a provider answer
   *     that never came back, or by `recoverStaleClaim`). A job left
   *     VERIFICATION_PENDING by a claim recovered BEFORE this release has no
   *     such row; it gets the same unknown-send-state row `recoverStaleClaim`
   *     now writes, because that is exactly what it was.
   */
  async #concludingAttempt(
    job: PublishJob,
    failureClass: PublishFailureClass,
    evidence: FailureEvidence,
  ): Promise<string> {
    if (evidence.kind === 'attempt') return evidence.attemptId;
    if (evidence.kind === 'preflight') {
      const at = this.#clock.now();
      return this.#recordAttempt({
        job,
        attemptNumber: await this.#nextAttemptNumber(job.id),
        startedAt: at,
        outcome: 'PREFLIGHT_REFUSED',
        failureClass,
        providerStatusCode: null,
        providerErrorCode: null,
        safeSummary: PREFLIGHT_REFUSED_SUMMARY,
      });
    }
    const verified = await this.#db.publishAttempt.findFirst({
      where: { workspaceId: this.#workspaceId, publishJobId: job.id },
      orderBy: { attemptNumber: 'desc' },
      select: { id: true, outcome: true },
    });
    if (verified?.outcome === 'INDETERMINATE') return verified.id;
    return this.#recordUnknownSendState(job, job.claimedAt ?? this.#clock.now());
  }

  /**
   * D1 — THE WORKER CLAIM ENDED WITH AN UNKNOWN SEND STATE. One INDETERMINATE
   * row, class TIMEOUT, numbered after the highest attempt so far; no provider
   * status or error code, because no answer was received, and a summary that
   * says the send state is unknown rather than that a request was made.
   * `attemptCount` is not touched.
   */
  async #recordUnknownSendState(job: PublishJob, startedAt: Date): Promise<string> {
    return this.#recordAttempt({
      job,
      attemptNumber: await this.#nextAttemptNumber(job.id),
      startedAt,
      outcome: 'INDETERMINATE',
      failureClass: 'TIMEOUT',
      providerStatusCode: null,
      providerErrorCode: null,
      safeSummary: UNKNOWN_SEND_STATE_SUMMARY,
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

// ---------------------------------------------------------------------------
// CONNECTORS A — what is checked before a request leaves, and after it lands
// ---------------------------------------------------------------------------

/**
 * W3 — THE FIRST MEDIA RULE THIS POST BREAKS, by name, or null. Every rule is
 * configuration; a rule left null is not checked. A size the library does not
 * know (no width, no duration) cannot be shown to satisfy a rule that needs
 * it, so it is refused rather than guessed.
 */
export function mediaRuleViolation(
  rule: MediaRule | undefined,
  media: readonly Pick<
    PublishMedia,
    'mimeType' | 'sizeBytes' | 'width' | 'height' | 'durationMs'
  >[],
): string | null {
  if (!rule) return null;
  if (rule.minItems !== null && media.length < rule.minItems) return 'min_items';
  if (rule.maxItems !== null && media.length > rule.maxItems) return 'max_items';
  for (const item of media) {
    if (rule.mimeTypes.length > 0 && !rule.mimeTypes.includes(item.mimeType)) return 'mime_type';
    if (rule.maxBytes !== null && item.sizeBytes > rule.maxBytes) return 'max_bytes';
    const needsSize =
      rule.minWidth !== null ||
      rule.maxWidth !== null ||
      rule.minHeight !== null ||
      rule.maxHeight !== null ||
      rule.minAspectRatio !== null ||
      rule.maxAspectRatio !== null;
    if (needsSize && (item.width === null || item.height === null)) return 'dimensions_unknown';
    if (item.width !== null && item.height !== null) {
      if (rule.minWidth !== null && item.width < rule.minWidth) return 'min_width';
      if (rule.maxWidth !== null && item.width > rule.maxWidth) return 'max_width';
      if (rule.minHeight !== null && item.height < rule.minHeight) return 'min_height';
      if (rule.maxHeight !== null && item.height > rule.maxHeight) return 'max_height';
      const aspect = item.width / item.height;
      if (rule.minAspectRatio !== null && aspect < rule.minAspectRatio) return 'min_aspect_ratio';
      if (rule.maxAspectRatio !== null && aspect > rule.maxAspectRatio) return 'max_aspect_ratio';
    }
    if (rule.minDurationSeconds !== null || rule.maxDurationSeconds !== null) {
      if (!item.mimeType.startsWith('video/')) continue;
      const seconds =
        item.durationMs === null || item.durationMs === undefined ? null : item.durationMs / 1_000;
      if (seconds === null) return 'duration_unknown';
      if (rule.minDurationSeconds !== null && seconds < rule.minDurationSeconds)
        return 'min_duration';
      if (rule.maxDurationSeconds !== null && seconds > rule.maxDurationSeconds)
        return 'max_duration';
    }
  }
  return null;
}

/** Compare captions as words, not bytes: case, spacing and Unicode form aside. */
function normalisedCaption(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/**
 * R8 — WHERE THE PLATFORM'S COPY DIFFERS FROM WHAT THE AUTHOR PREVIEWED, as
 * field names. The caption must CONTAIN what the author wrote: a platform may
 * append the hashtags or a link, and that is not a different post.
 */
export function observationMismatches(
  request: Pick<PublishRequest, 'postKind' | 'media' | 'body'>,
  observed: PublishObservation | undefined,
): string[] {
  if (!observed) return [];
  const differs: string[] = [];
  if (observed.postKind !== undefined && observed.postKind !== request.postKind)
    differs.push('postKind');
  if (observed.mediaCount !== undefined && observed.mediaCount !== request.media.length)
    differs.push('mediaCount');
  if (observed.caption !== undefined) {
    const expected = normalisedCaption(request.body);
    const seen = normalisedCaption(observed.caption ?? '');
    if (!seen.includes(expected)) differs.push('caption');
  }
  return differs;
}

/** A variant's stored per-platform options, as a plain object, or none. */
function plainOptions(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// W1 (connectors A, D-505) — THE PROVIDER CALL RUNS BETWEEN TWO COMMITS
// ---------------------------------------------------------------------------

/**
 * How a caller runs one database step of a publish or a verification.
 *
 * THE WORKER OPENS A FRESH TENANT TRANSACTION PER STEP, with a pipeline bound
 * to it; a caller that already holds a client runs every step on it
 * (`PublishPipelineService#execute`). Either way the provider is called by
 * `sendPrepared` / `lookupPost` BETWEEN steps, never inside one — so a
 * provider slower than the transaction's timeout can no longer roll the claim
 * back to QUEUED with the post possibly live.
 */
export interface PipelineTransactions {
  run<T>(step: (pipeline: PublishPipelineService) => Promise<T>): Promise<T>;
}

type Adapter = ReturnType<ConnectorRegistry['get']>;

/** Everything the provider call needs, and nothing the database does. */
export interface PreparedSend {
  readonly jobId: string;
  /** The claim this send belongs to: the record step is fenced on it. */
  readonly claimedAt: Date;
  readonly startedAt: Date;
  readonly adapter: Adapter;
  /** Decrypted in memory, exactly as before W1. Never logged or serialized. */
  readonly credentials: AdapterCredentials;
  readonly request: PublishRequest;
}

/** Everything a post lookup needs. */
export interface PreparedLookup {
  readonly jobId: string;
  readonly adapter: Adapter;
  readonly credentials: AdapterCredentials;
  readonly externalAccountId: string;
  readonly idempotencyKey: string;
  /**
   * Connectors A (W5): the handle of a publish the platform accepted and had
   * not finished. When present the question is `checkPublish(handle)`, not a
   * lookup by key.
   */
  readonly providerHandle: string | null;
}

/** What asking the provider "did this land?" produced. */
export type LookupReport =
  | {
      readonly kind: 'found';
      readonly externalPostId: string;
      readonly externalPostUrl: string | null;
    }
  | { readonly kind: 'absent' }
  /** Not asked (no lookup), or asked and no answer came back. */
  | { readonly kind: 'unanswered' }
  /** W5: the platform is still working on it. */
  | { readonly kind: 'pending' }
  /** W5: the platform finished, and the publish FAILED — nothing went out. */
  | {
      readonly kind: 'failed';
      readonly failureClass: PublishFailureClass;
      readonly failureCode: string;
    };

/** What the send step observed. The lookup is present only after an indeterminate failure. */
export type SendReport =
  | {
      readonly kind: 'answered';
      readonly outcome: PublishOutcome;
      readonly lookup: LookupReport | null;
    }
  | {
      readonly kind: 'thrown';
      readonly failureClass: PublishFailureClass;
      readonly lookup: LookupReport | null;
    };

export type ExecutionStep =
  | { readonly kind: 'settled'; readonly result: ExecuteResult }
  | { readonly kind: 'send'; readonly send: PreparedSend };

export type VerificationStep =
  | { readonly kind: 'settled'; readonly result: ExecuteResult }
  | { readonly kind: 'lookup'; readonly lookup: PreparedLookup };

/** Claim and preflight (commit) → send (no transaction) → record (commit). */
export async function executePublishJob(
  transactions: PipelineTransactions,
  jobId: string,
): Promise<ExecuteResult> {
  const step = await transactions.run((pipeline) => pipeline.beginExecution(jobId));
  if (step.kind === 'settled') return step.result;
  const report = await sendPrepared(step.send);
  return transactions.run((pipeline) => pipeline.concludeExecution(step.send, report));
}

/** Read (commit) → ask the provider (no transaction) → act on the answer (commit). */
export async function verifyPublishJob(
  transactions: PipelineTransactions,
  jobId: string,
): Promise<ExecuteResult> {
  const step = await transactions.run((pipeline) => pipeline.beginVerification(jobId));
  if (step.kind === 'settled') return step.result;
  const report = await lookupPost(step.lookup);
  return transactions.run((pipeline) => pipeline.concludeVerification(step.lookup, report));
}

/**
 * Move a dead claim to VERIFICATION_PENDING (commit), then verify it. THERE IS
 * NO PATH FROM HERE TO `sendPrepared` (D-143): recovery asks, it never sends.
 */
export async function recoverStalePublishJob(
  transactions: PipelineTransactions,
  jobId: string,
): Promise<ExecuteResult> {
  const unchanged = await transactions.run((pipeline) => pipeline.claimStale(jobId));
  if (unchanged) return unchanged;
  return verifyPublishJob(transactions, jobId);
}

/**
 * STEP 2 OF 3 — THE ONE EXTERNAL CALL, outside any transaction.
 *
 * NEVER THROWS FOR A PROVIDER'S SAKE. A thrown error is classified here, by
 * the adapter that threw it, and becomes a report; the thrown message is not
 * kept, because an exception from deep in an HTTP client can carry the
 * request body, which is the customer's caption. An INDETERMINATE answer is
 * looked up immediately, still outside any transaction, so the record step
 * only reads answers and never waits on a provider.
 */
export async function sendPrepared(send: PreparedSend): Promise<SendReport> {
  const lookupAfter = async (failureClass: PublishFailureClass) =>
    FAILURE_BEHAVIOUR[failureClass].indeterminate &&
    send.adapter.capabilities.supportsPostLookup &&
    send.adapter.findPostByIdempotencyKey
      ? lookupPost({
          jobId: send.jobId,
          adapter: send.adapter,
          credentials: send.credentials,
          externalAccountId: send.request.externalAccountId,
          idempotencyKey: send.request.idempotencyKey,
          providerHandle: null,
        })
      : null;

  let outcome: PublishOutcome;
  try {
    outcome = await send.adapter.publish({ credentials: send.credentials, request: send.request });
  } catch (error: unknown) {
    const failureClass = send.adapter.classifyError(error);
    return { kind: 'thrown', failureClass, lookup: await lookupAfter(failureClass) };
  }
  return {
    kind: 'answered',
    outcome,
    lookup: outcome.ok === false ? await lookupAfter(outcome.failureClass) : null,
  };
}

/**
 * "Did this post land?" — asked outside any transaction. A throw is "no
 * answer". A publish the platform accepted (W5) is asked about by its handle;
 * anything else by its idempotency key.
 */
export async function lookupPost(lookup: PreparedLookup): Promise<LookupReport> {
  const check = lookup.adapter.checkPublish;
  if (lookup.providerHandle !== null && check) {
    try {
      const outcome = await check.call(lookup.adapter, {
        providerHandle: lookup.providerHandle,
        externalAccountId: lookup.externalAccountId,
        credentials: lookup.credentials,
      });
      if (outcome.ok === true) {
        return {
          kind: 'found',
          externalPostId: outcome.externalPostId,
          externalPostUrl: outcome.externalPostUrl,
        };
      }
      if (outcome.ok === 'pending') return { kind: 'pending' };
      // AN INDETERMINATE ANSWER TO "DID IT FINISH?" IS NOT AN ANSWER.
      if (FAILURE_BEHAVIOUR[outcome.failureClass].indeterminate) return { kind: 'unanswered' };
      return {
        kind: 'failed',
        failureClass: outcome.failureClass,
        failureCode: outcome.failureCode,
      };
    } catch {
      return { kind: 'unanswered' };
    }
  }
  const find = lookup.adapter.findPostByIdempotencyKey;
  if (!lookup.adapter.capabilities.supportsPostLookup || !find) return { kind: 'unanswered' };
  try {
    const found = await find.call(lookup.adapter, {
      externalAccountId: lookup.externalAccountId,
      idempotencyKey: lookup.idempotencyKey,
      credentials: lookup.credentials,
    });
    return found
      ? {
          kind: 'found',
          externalPostId: found.externalPostId,
          externalPostUrl: found.externalPostUrl,
        }
      : { kind: 'absent' };
  } catch {
    return { kind: 'unanswered' };
  }
}

function settled(result: ExecuteResult): {
  readonly kind: 'settled';
  readonly result: ExecuteResult;
} {
  return { kind: 'settled', result };
}

/** Ours, fixed and bounded: what an accepted-but-unfinished publish's attempt says. */
export const PUBLISH_IN_PROGRESS_SUMMARY = 'Accepted by the platform; still being published.';

/** The attempt row a send report becomes. Ours, bounded, never the provider's prose. */
function attemptFromReport(
  report: SendReport,
  mismatches: readonly string[],
): {
  readonly outcome: 'SUCCEEDED' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE' | 'INDETERMINATE';
  readonly failureClass: PublishFailureClass | null;
  readonly providerStatusCode: number | null;
  readonly providerErrorCode: string | null;
  readonly safeSummary: string | null;
  readonly providerHandle: string | null;
} {
  const failedAs = (failureClass: PublishFailureClass) =>
    FAILURE_BEHAVIOUR[failureClass].indeterminate
      ? ('INDETERMINATE' as const)
      : FAILURE_BEHAVIOUR[failureClass].retryable
        ? ('RETRYABLE_FAILURE' as const)
        : ('PERMANENT_FAILURE' as const);
  if (report.kind === 'thrown') {
    return {
      outcome: failedAs(report.failureClass),
      failureClass: report.failureClass,
      providerStatusCode: null,
      providerErrorCode: null,
      safeSummary: 'The platform call did not complete.',
      providerHandle: null,
    };
  }
  const outcome = report.outcome;
  if (outcome.ok === true) {
    return {
      outcome: 'SUCCEEDED',
      failureClass: null,
      providerStatusCode: outcome.providerStatusCode,
      providerErrorCode: null,
      // R8: field NAMES only, never the caption.
      safeSummary:
        mismatches.length === 0
          ? null
          : `Published; the platform's copy differs from the preview in: ${mismatches.join(', ')}.`,
      providerHandle: null,
    };
  }
  if (outcome.ok === 'pending') {
    // W5: sent, outcome not yet known — the attempt's CHECK requires a class.
    return {
      outcome: 'INDETERMINATE',
      failureClass: 'TIMEOUT',
      providerStatusCode: outcome.providerStatusCode,
      providerErrorCode: null,
      safeSummary: PUBLISH_IN_PROGRESS_SUMMARY,
      providerHandle: outcome.providerHandle,
    };
  }
  return {
    outcome: failedAs(outcome.failureClass),
    failureClass: outcome.failureClass,
    providerStatusCode: outcome.providerStatusCode,
    providerErrorCode: outcome.providerErrorCode,
    safeSummary: outcome.safeSummary,
    providerHandle: null,
  };
}

/** The post the send step proved is live, if it proved one. */
function landedPost(
  report: SendReport,
): { externalPostId: string; externalPostUrl: string | null } | null {
  if (report.kind === 'answered' && report.outcome.ok === true) return report.outcome;
  if (report.lookup?.kind === 'found') return report.lookup;
  return null;
}

// ---------------------------------------------------------------------------
// READ-ONLY RETRY CHECKS (Phase 2B-3 PR 5)
// ---------------------------------------------------------------------------

/**
 * WOULD `retry()` REFUSE THIS JOB, AND WHY? READ-ONLY, AND WITHOUT A PIPELINE.
 *
 * The same checks `retry()` makes, in the same order. It needs only the
 * tenant's client and the publishing policy, so the automation WORKER can ask
 * it when a retry request would be created (owner decision D3) without being
 * handed anything that can publish — the worker is deliberately wired with no
 * publish capability at all. `null` means a retry would be accepted now; it is
 * not a promise, and `retry()` checks again under its own conditional write.
 */
export async function publishRetryRefusal(input: {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: PublishingPolicy;
  readonly clock?: Clock | undefined;
  readonly jobId: string;
  readonly brandScope: readonly string[];
}): Promise<RetryRefusal | null> {
  const job = await input.db.publishJob.findFirst({
    where: {
      id: input.jobId,
      workspaceId: input.workspaceId,
      ...brandIdQueryFilter({ brandScope: input.brandScope }),
    },
  });
  if (!job) return 'not_found';
  return refusalForJob(input.db, input.workspaceId, input.policy, input.clock ?? systemClock, job);
}

async function refusalForJob(
  db: TenantScopedClient,
  workspaceId: string,
  policy: PublishingPolicy,
  clock: Clock,
  job: PublishJob,
): Promise<RetryRefusal | null> {
  if (job.status !== 'FAILED') return 'not_retryable';
  /*
   * AND NOT AN INDETERMINATE CLASS EVEN WHEN FAILED. A job that exhausted its
   * attempts on a TIMEOUT is a job whose last request may have landed; it
   * reaches FAILED through `#fail`, and retrying it is the same duplicate by a
   * longer route.
   */
  if (job.failureClass && FAILURE_BEHAVIOUR[job.failureClass].indeterminate) {
    return 'not_retryable';
  }
  // D-332 (owner decision): a retry never publishes late. Refused, not queued.
  const lateness = policy.dispatch.latenessToleranceMinutes * 60_000;
  if (clock.now().getTime() - job.scheduledAtUtc.getTime() > lateness) return 'deadline_passed';
  // Item 9 (D-332 amended): the post was scheduled again; this attempt is history.
  if ((await supersededJobIds(db, workspaceId, [job.id])).has(job.id)) return 'superseded';
  if (job.failureClass && !FAILURE_BEHAVIOUR[job.failureClass].manualRetryUseful) {
    return 'not_retryable';
  }
  return null;
}

/** ITEM 9 — the jobs whose slot a newer, non-cancelled slot of the same post replaced. */
async function supersededJobIds(
  db: TenantScopedClient,
  workspaceId: string,
  jobIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (jobIds.length === 0) return new Set();
  const jobs = await db.publishJob.findMany({
    where: { workspaceId, id: { in: [...jobIds] } },
    select: {
      id: true,
      contentItemId: true,
      slot: { select: { id: true, createdAt: true } },
    },
  });
  if (jobs.length === 0) return new Set();
  const slots = await db.calendarSlot.findMany({
    where: {
      workspaceId,
      contentItemId: { in: [...new Set(jobs.map((job) => job.contentItemId))] },
      status: { not: 'CANCELLED' },
    },
    select: { id: true, contentItemId: true, createdAt: true },
  });
  const superseded = new Set<string>();
  for (const job of jobs) {
    const newer = slots.some(
      (slot) =>
        slot.contentItemId === job.contentItemId &&
        slot.id !== job.slot.id &&
        slot.createdAt > job.slot.createdAt,
    );
    if (newer) superseded.add(job.id);
  }
  return superseded;
}
