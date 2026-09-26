import { createHash } from 'node:crypto';
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
import type { AdapterCredentials, PublishMedia, PublishOutcome } from './adapter';
import {
  FAILURE_BEHAVIOUR,
  publishJobNotCancellable,
  publishJobNotFound,
  publishJobNotRetryable,
} from './errors';
import { capabilitiesFor, PROVIDER_CONFIG_KEYS, type PublishingPolicy } from './policy';

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
): {
  unreachableChannels(brandId: string, platformKeys: readonly string[]): Promise<readonly string[]>;
} {
  return {
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
/** On a held job, while it waits. */
export const AWAITING_RECONNECT_CODE = 'preflight.awaiting_reconnect';
/** On the job that waited until its deadline and the account never came back. */
export const RECONNECT_REQUIRED_CODE = 'preflight.reconnect_required';

type PreflightOutcome =
  PublishFailureClass | typeof AWAITING_RECONNECT | typeof RECONNECT_TOO_LATE | null;

export class PublishPipelineService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: PublishingPolicy;
  readonly #registry: ConnectorRegistry;
  readonly #vault: SocialTokenVault;
  readonly #approvals: PublishApprovalGate;
  readonly #media: PublishMediaPort | undefined;
  readonly #notifier: PublishNotifier | undefined;
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

    const inserted =
      rows.length === 0
        ? { count: 0 }
        : await this.#db.publishJob.createMany({ data: rows, skipDuplicates: true });
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
    if (preflight === AWAITING_RECONNECT) return this.#holdForReconnect(job);
    if (preflight === RECONNECT_TOO_LATE) {
      return this.#fail(job, 'NOT_CONNECTED', RECONNECT_REQUIRED_CODE, null);
    }
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
        return this.#fail(job, 'UNSUPPORTED', 'preflight.too_many_media', null);
      }
      if (!this.#media) {
        return this.#fail(job, 'CONTENT_REJECTED', 'preflight.media_unavailable', null);
      }
      try {
        media = await this.#media.resolve({
          brandId: job.brandId,
          assetIds: variant.assetIds,
        });
      } catch {
        // The reason is the port's and is not a customer's to read as prose: a
        // stable code goes on the job and the history screen translates it.
        return this.#fail(job, 'CONTENT_REJECTED', 'preflight.media_rejected', null);
      }
      if (media.length !== variant.assetIds.length) {
        return this.#fail(job, 'CONTENT_REJECTED', 'preflight.media_rejected', null);
      }
    }

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
          media,
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
    const job = await this.#db.publishJob.findFirst({
      where: { id: jobId, workspaceId: this.#workspaceId },
    });
    if (!job) throw publishJobNotFound();
    if (job.status !== 'VERIFICATION_PENDING') {
      return {
        jobId: job.id,
        status: job.status,
        failureClass: job.failureClass,
        externalPostId: job.externalPostId,
      };
    }

    const adapter = this.#registry.get(job.provider);
    const lookup = adapter.findPostByIdempotencyKey;
    if (!adapter.capabilities.supportsPostLookup || !lookup) {
      // NOT A FAILURE AND NOT A RETRY. It stays where a human can see it.
      return {
        jobId: job.id,
        status: 'VERIFICATION_PENDING',
        failureClass: job.failureClass,
        externalPostId: null,
      };
    }

    const connection = await this.#db.socialConnection.findFirst({
      where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
    });
    if (!connection) return this.#fail(job, 'NOT_CONNECTED', 'verify.not_connected', null);

    const credentials = await this.#credentialsFor(connection.id);
    if (!credentials) return this.#fail(job, 'NOT_CONNECTED', 'verify.no_credential', null);

    let found: { externalPostId: string; externalPostUrl: string | null } | null;
    try {
      found = await lookup.call(adapter, {
        externalAccountId: connection.externalAccountId,
        idempotencyKey: job.idempotencyKey,
        credentials,
      });
    } catch {
      /*
       * WE ASKED AND COULD NOT GET AN ANSWER. That is not "it did not publish";
       * it is the same uncertainty we started with, so the job does not move.
       * The provider's own words are not repeated for the usual reason.
       */
      return {
        jobId: job.id,
        status: 'VERIFICATION_PENDING',
        failureClass: job.failureClass,
        externalPostId: null,
      };
    }

    if (found) return this.#succeed(job, found.externalPostId, found.externalPostUrl);

    /*
     * THE PROVIDER SAYS NOTHING LANDED. Only now may this be sent again, and
     * only through the ordinary QUEUED path with its attempt budget intact — so
     * a verification that keeps answering "not there" cannot loop for ever.
     */
    const attemptCount = job.attemptCount;
    if (attemptCount >= job.maxAttempts) {
      return this.#fail(job, job.failureClass ?? 'TIMEOUT', 'verify.exhausted', attemptCount);
    }
    await this.#db.publishJob.update({
      where: { id: job.id },
      data: {
        status: 'QUEUED',
        claimedAt: null,
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
   */
  async recoverStaleClaim(jobId: string): Promise<ExecuteResult> {
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
      return {
        jobId: current.id,
        status: current.status,
        failureClass: current.failureClass,
        externalPostId: current.externalPostId,
      };
    }

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'social.post.claim_recovered',
      actorType: 'SYSTEM',
      resourceType: 'PublishJob',
      resourceId: jobId,
      brandId: undefined,
      before: { status: 'PUBLISHING' },
      after: { status: 'VERIFICATION_PENDING', reason: 'claim_expired' },
    });

    // AND THEN ASK. A provider that can be queried resolves in this same pass;
    // one that cannot stays VERIFICATION_PENDING for a human.
    return this.verify(jobId);
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
        // as a manual retry, and for the same reason.
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
    if (job.status !== 'FAILED') throw publishJobNotRetryable();
    if (job.failureClass && !FAILURE_BEHAVIOUR[job.failureClass].manualRetryUseful) {
      throw publishJobNotRetryable();
    }
    /*
     * AND NOT AN INDETERMINATE CLASS EVEN WHEN FAILED. A job that exhausted its
     * attempts on a TIMEOUT is a job whose last request may have landed; it
     * reaches FAILED through `#fail`, and retrying it is the same duplicate by
     * a longer route.
     */
    if (job.failureClass && FAILURE_BEHAVIOUR[job.failureClass].indeterminate) {
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
    if (job.status !== 'FAILED' || !RECONNECT_RETRY_CLASSES.has(job.failureClass ?? '')) {
      throw publishJobNotRetryable();
    }
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
    for (const job of jobs) {
      if (!RECONNECT_RETRY_CLASSES.has(job.failureClass ?? '')) continue;
      if (await this.#reconnectedConnection(job)) ready.add(job.id);
    }
    return ready;
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

    const lateByMs = this.#clock.now().getTime() - job.scheduledAtUtc.getTime();
    const tooLate = lateByMs > this.#lateness();

    const connection = await this.#db.socialConnection.findFirst({
      where: { id: job.socialConnectionId, workspaceId: this.#workspaceId },
      select: { status: true },
    });
    /*
     * Q9 (D-332): AN ACCOUNT THAT NEEDS RECONNECTING HOLDS ITS JOB until the
     * lateness deadline, then fails it with the reason. A job that waited and
     * whose account came back only after the deadline fails with the same
     * reason — the post is late BECAUSE it waited for the reconnection, and
     * "the destination is unavailable" would not say so.
     */
    if (connection?.status === 'NEEDS_REAUTH')
      return tooLate ? RECONNECT_TOO_LATE : AWAITING_RECONNECT;
    if (!connection || connection.status !== 'ACTIVE') return 'NOT_CONNECTED';
    if (tooLate && job.failureCode === AWAITING_RECONNECT_CODE) return RECONNECT_TOO_LATE;

    const capabilities = capabilitiesFor(this.#policy, job.provider);
    if (!capabilities.enabled) return 'UNSUPPORTED';

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
