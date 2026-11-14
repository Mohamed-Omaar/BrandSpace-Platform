import type { TenantScopedClient } from '@brandspace/database';
import { writeAuditEvent } from '@brandspace/database';
import type { ImageQuality } from '@brandspace/ai-gateway';
import type { AssetActor } from '@brandspace/assets';
import { AppError, assertBrandInScope, systemClock, type Clock } from '@brandspace/shared';
import { findCreativeFormat } from './formats';
import {
  CreativeStudioService,
  creativeBriefRequired,
  unknownCreativeFormat,
  type BrandIdentityInput,
  type CreativeRun,
} from './studio';

/**
 * PR 1 (Images, D-597) — AN IMAGE IS A BACKGROUND JOB.
 *
 * Staging: `POST /api/creative/generate` held the request open while the
 * provider worked and failed after 90 s; an image made from a post was only
 * added to the editor's unsaved state, so leaving the page lost it. Now:
 *
 *   1. `enqueue` writes a QUEUED row and the caller answers at once;
 *   2. `runCreativeGenerationJob` claims the row (compare-and-set), calls the
 *      studio with NO transaction open, and finishes it SUCCEEDED or FAILED;
 *   3. a job asked for from a post attaches the image to that variant on the
 *      server, audited, even if nobody is looking — ONLY ONCE THE IMAGE HAS
 *      PASSED ITS CHECK (below). Publishing still needs the
 *      post's own approval: attaching changes media, never status.
 *
 * NEVER CHARGED TWICE. The job's idempotency key is the studio's: a second
 * run of the same job (a restart, the recovery sweep, two replicas) finds the
 * stored asset and calls no provider, or gets the gateway's recorded outcome
 * for the same AI request. The ledger's reserve -> confirm -> settle is the
 * gateway's and is never touched here.
 *
 * THE IMAGE IS CHECKED BEFORE THE JOB SUCCEEDS (the #122 race, fixed in PR A
 * on the owner's word, 2026-11-11). A made image enters the library through
 * the person's own upload path, and the asset worker scans it afterwards. The
 * job used to succeed and attach at once, while the image was still
 * PROCESSING: the editor then saved a post holding an image that was not yet
 * usable, and the save — which accepts only READY + CLEAN media — answered
 * NOT_FOUND. Now the job records its image and STAYS RUNNING until the image
 * is READY + CLEAN, then succeeds and attaches; the attach checks READY +
 * CLEAN again in its own transaction. An image the check refuses (quarantined,
 * failed, gone) FAILS the job `image_not_checked` and is attached nowhere.
 */

export type CreativeJobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/** How many times a job may be claimed before the sweep gives up on it. */
export const CREATIVE_JOB_MAX_ATTEMPTS = 3;
/** A QUEUED job nobody has claimed after this long is the sweep's to start. */
export const CREATIVE_JOB_QUEUED_STALE_MS = 60_000;
/**
 * A RUNNING job silent this long is the sweep's to finish or fail. Above the
 * image attempt's 180 s and the gateway's own sweep of a request past its
 * deadline, so a live run is never taken over.
 */
export const CREATIVE_JOB_RUNNING_STALE_MS = 15 * 60_000;

/** Stable reason keys the dashboard translates (`creative.job.failed.*`). */
export type CreativeJobFailure =
  | 'generation_failed'
  | 'insufficient_credits'
  | 'limit_reached'
  | 'ai_paused'
  | 'busy'
  | 'storage_full'
  | 'not_found'
  | 'access_revoked'
  | 'stuck_timeout'
  // The made image did not pass its check (quarantined, failed or gone).
  | 'image_not_checked';

/**
 * How long ONE run waits for the made image's check before handing the job
 * to the recovery sweep (it stays RUNNING; the sweep's re-run replays the
 * image, uncharged, and waits again). Well under the RUNNING stale limit.
 */
export const CREATIVE_JOB_CHECK_WAIT_MS = 120_000;
/** How often a waiting run looks at the image again. */
export const CREATIVE_JOB_CHECK_POLL_MS = 1_000;

/** Where a made image stands: usable, not yet decided, or refused for good. */
export type CreativeImageCheck = 'clean' | 'pending' | 'refused';

/** What finishing a job came to. */
export type CreativeJobFinish =
  | { readonly kind: 'done'; readonly view: CreativeJobView }
  /** The image is not READY + CLEAN (any more): nothing was written. */
  | { readonly kind: 'not_clean' }
  /** This run no longer holds the job (finished, or claimed by another run). */
  | { readonly kind: 'lost' };

export interface CreativeJobView {
  readonly id: string;
  readonly brandId: string;
  readonly status: CreativeJobStatus;
  readonly formatKey: string;
  readonly contentVariantId: string | null;
  /** PR B — whether the brand's logo is put on the image, and the headline. */
  readonly addLogo: boolean;
  readonly headline: string | null;
  readonly assetId: string | null;
  readonly attached: boolean;
  readonly failureReason: string | null;
  readonly creditsChargedMilli: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface EnqueueCreativeJobInput {
  readonly brandId: string;
  readonly requestedByUserId: string;
  readonly brandScope: readonly string[];
  readonly idempotencyKey: string;
  readonly brief: string;
  readonly formatKey: string;
  readonly quality?: ImageQuality | undefined;
  readonly contentVariantId?: string | undefined;
  /** PR B — put the brand's real logo on the image. Absent: true (owner default). */
  readonly addLogo?: boolean | undefined;
  /** PR B — an optional headline drawn on the image, 1–80 characters. */
  readonly headline?: string | null | undefined;
}

/** PR B — the longest headline drawn on an image (a CHECK holds the same). */
export const CREATIVE_HEADLINE_MAX = 80;

/** PR B — a headline as stored: trimmed, null when empty, refused when too long. */
export function creativeHeadline(raw: string | null | undefined): string | null {
  const headline = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (headline === '') return null;
  if ([...headline].length > CREATIVE_HEADLINE_MAX) {
    throw new AppError(
      'VALIDATION_FAILED',
      `A headline holds at most ${CREATIVE_HEADLINE_MAX} characters.`,
    );
  }
  return headline;
}

interface JobRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly brandId: string;
  readonly requestedByUserId: string | null;
  readonly idempotencyKey: string;
  readonly brief: string;
  readonly formatKey: string;
  readonly quality: string | null;
  readonly contentVariantId: string | null;
  readonly addLogo: boolean;
  readonly headline: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly assetId: string | null;
  readonly creditsChargedMilli: bigint | null;
  readonly attachedAt: Date | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

function notFound(): AppError {
  // A job, a variant or a brand that is not the caller's reads as a miss.
  return new AppError('NOT_FOUND', 'That item no longer exists.');
}

export function viewOf(row: JobRow): CreativeJobView {
  return {
    id: row.id,
    brandId: row.brandId,
    status: row.status as CreativeJobStatus,
    formatKey: row.formatKey,
    contentVariantId: row.contentVariantId,
    addLogo: row.addLogo,
    headline: row.headline,
    // The image is the person's only once the job has SUCCEEDED: a RUNNING job
    // waiting for the check, or a FAILED one the check refused, names none.
    assetId: row.status === 'SUCCEEDED' ? row.assetId : null,
    attached: row.attachedAt !== null,
    failureReason: row.failureReason,
    creditsChargedMilli:
      row.creditsChargedMilli === null ? null : row.creditsChargedMilli.toString(),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** The reason key a run's error stands for. Never the error's own words. */
export function failureReasonOf(error: unknown): CreativeJobFailure {
  const code = error instanceof AppError ? error.code : (error as { code?: unknown })?.code;
  switch (code) {
    case 'INSUFFICIENT_CREDITS':
      return 'insufficient_credits';
    case 'QUOTA_EXCEEDED':
      return 'limit_reached';
    case 'AI_PAUSED':
      return 'ai_paused';
    case 'RATE_LIMITED':
      return 'busy';
    case 'STORAGE_LIMIT_EXCEEDED':
    case 'PAYLOAD_TOO_LARGE':
      return 'storage_full';
    case 'NOT_FOUND':
      return 'not_found';
    default:
      return 'generation_failed';
  }
}

export class CreativeGenerationJobs {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #clock: Clock;

  constructor(options: { db: TenantScopedClient; workspaceId: string; clock?: Clock }) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * One job per key. The same person asking again with the same key gets the
   * same job back (a retried request); a key another person or brand used is
   * a miss, never their job (P7-R2: a key is not a credential).
   */
  async enqueue(
    input: EnqueueCreativeJobInput,
  ): Promise<{ readonly job: CreativeJobView; readonly created: boolean }> {
    assertBrandInScope(input.brandScope, input.brandId);
    const brief = input.brief.trim();
    if (brief === '') throw creativeBriefRequired();
    if (!findCreativeFormat(input.formatKey)) throw unknownCreativeFormat();
    const headline = creativeHeadline(input.headline);

    const existing = await this.#db.creativeGenerationJob.findFirst({
      where: { workspaceId: this.#workspaceId, idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (
        existing.requestedByUserId !== input.requestedByUserId ||
        existing.brandId !== input.brandId
      ) {
        throw notFound();
      }
      return { job: viewOf(existing), created: false };
    }

    const brand = await this.#db.brand.findFirst({
      where: { id: input.brandId, workspaceId: this.#workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw notFound();

    if (input.contentVariantId) {
      // The variant must be this brand's, in this workspace. RLS and the
      // composite foreign key refuse another workspace's; this refuses
      // another brand's, as the same miss.
      const variant = await this.#db.contentVariant.findFirst({
        where: {
          id: input.contentVariantId,
          workspaceId: this.#workspaceId,
          brandId: input.brandId,
        },
        select: { id: true },
      });
      if (!variant) throw notFound();
    }

    const row = await this.#db.creativeGenerationJob.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        requestedByUserId: input.requestedByUserId,
        idempotencyKey: input.idempotencyKey,
        brief: brief.slice(0, 4_000),
        formatKey: input.formatKey,
        quality: input.quality ?? null,
        contentVariantId: input.contentVariantId ?? null,
        addLogo: input.addLogo ?? true,
        headline,
        status: 'QUEUED',
      },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'creative.generation.queued',
      actorType: 'USER',
      actorId: input.requestedByUserId,
      resourceType: 'CreativeGenerationJob',
      resourceId: row.id,
      brandId: input.brandId,
      // Ids and the format only: the brief is customer content.
      after: {
        formatKey: row.formatKey,
        ...(row.contentVariantId ? { contentVariantId: row.contentVariantId } : {}),
      },
    });
    return { job: viewOf(row), created: true };
  }

  /** The caller's own job, or a miss. */
  async get(
    jobId: string,
    caller: { readonly userId: string; readonly brandScope: readonly string[] },
  ): Promise<CreativeJobView> {
    const row = await this.#db.creativeGenerationJob.findFirst({
      where: { id: jobId, workspaceId: this.#workspaceId, requestedByUserId: caller.userId },
    });
    if (!row) throw notFound();
    if (caller.brandScope.length > 0 && !caller.brandScope.includes(row.brandId)) throw notFound();
    return viewOf(row);
  }

  /** The caller's recent jobs on one brand (the Creative Studio page, the editor). */
  async recent(input: {
    readonly userId: string;
    readonly brandId: string;
    readonly contentVariantIds?: readonly string[];
    readonly unfinishedOnly?: boolean;
    readonly limit?: number;
  }): Promise<readonly CreativeJobView[]> {
    const rows = await this.#db.creativeGenerationJob.findMany({
      where: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        requestedByUserId: input.userId,
        ...(input.contentVariantIds
          ? { contentVariantId: { in: [...input.contentVariantIds] } }
          : {}),
        ...(input.unfinishedOnly ? { status: { in: ['QUEUED', 'RUNNING'] } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(input.limit ?? 10, 50),
    });
    return rows.map(viewOf);
  }

  /**
   * CLAIM. QUEUED -> RUNNING, or a RUNNING job silent since `staleBefore`
   * taken over, in one compare-and-set: two runners never both win. A job
   * already claimed `CREATIVE_JOB_MAX_ATTEMPTS` times is not claimed again.
   */
  async claim(jobId: string, staleBefore?: Date): Promise<JobRow | null> {
    const now = this.#clock.now();
    const claimed = await this.#db.creativeGenerationJob.updateMany({
      where: {
        id: jobId,
        workspaceId: this.#workspaceId,
        attempts: { lt: CREATIVE_JOB_MAX_ATTEMPTS },
        OR: [
          { status: 'QUEUED' },
          ...(staleBefore ? [{ status: 'RUNNING', startedAt: { lt: staleBefore } }] : []),
        ],
      },
      data: { status: 'RUNNING', startedAt: now, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    return this.#db.creativeGenerationJob.findFirst({
      where: { id: jobId, workspaceId: this.#workspaceId },
    });
  }

  /**
   * THE MADE IMAGE, RECORDED ON THE RUNNING JOB — which stays RUNNING until
   * the image has passed its check. Only this attempt's RUNNING row is
   * written. A re-run (the recovery sweep) that finds the image already
   * recorded keeps the first record, charge included: the replay was free.
   */
  async recordGenerated(
    job: { readonly id: string; readonly attempts: number },
    result: {
      readonly assetId: string;
      readonly aiRequestId: string;
      readonly creditsChargedMilli: bigint;
    },
  ): Promise<boolean> {
    const mine = {
      id: job.id,
      workspaceId: this.#workspaceId,
      status: 'RUNNING',
      attempts: job.attempts,
    };
    const recorded = await this.#db.creativeGenerationJob.updateMany({
      where: { ...mine, assetId: null },
      data: {
        assetId: result.assetId,
        ...(result.aiRequestId ? { aiRequestId: result.aiRequestId } : {}),
        creditsChargedMilli: result.creditsChargedMilli,
      },
    });
    if (recorded.count === 1) return true;
    const row = await this.#db.creativeGenerationJob.findFirst({
      where: mine,
      select: { assetId: true },
    });
    return row !== null && row.assetId === result.assetId;
  }

  /** Where the made image stands. A missing or deleted image is refused. */
  async imageCheck(assetId: string): Promise<CreativeImageCheck> {
    const asset = await this.#db.asset.findFirst({
      where: { id: assetId, workspaceId: this.#workspaceId, deletedAt: null },
      select: { status: true, scanStatus: true },
    });
    if (!asset) return 'refused';
    if (asset.status === 'READY' && asset.scanStatus === 'CLEAN') return 'clean';
    if (
      asset.status === 'QUARANTINED' ||
      asset.status === 'PROCESSING_FAILED' ||
      asset.status === 'ARCHIVED' ||
      asset.scanStatus === 'INFECTED'
    ) {
      return 'refused';
    }
    return 'pending';
  }

  /**
   * SUCCEEDED, and — for a job asked for from a post — the image added to the
   * variant's media, once, audited. Only the RUNNING row on this attempt is
   * finished: a stale runner that lost its claim writes nothing.
   *
   * THE CHECK IS READ AGAIN HERE, in this transaction, before anything is
   * written: an image that is not READY + CLEAN finishes nothing and is
   * attached nowhere.
   */
  async succeed(job: {
    readonly id: string;
    readonly attempts: number;
  }): Promise<CreativeJobFinish> {
    const mine = {
      id: job.id,
      workspaceId: this.#workspaceId,
      status: 'RUNNING',
      attempts: job.attempts,
    };
    const running = await this.#db.creativeGenerationJob.findFirst({
      where: mine,
      select: { assetId: true },
    });
    if (!running?.assetId) return { kind: 'lost' };
    const usable = await this.#db.asset.findFirst({
      where: {
        id: running.assetId,
        workspaceId: this.#workspaceId,
        deletedAt: null,
        status: 'READY',
        scanStatus: 'CLEAN',
      },
      select: { id: true },
    });
    if (!usable) return { kind: 'not_clean' };
    const assetId = usable.id;

    const now = this.#clock.now();
    const finished = await this.#db.creativeGenerationJob.updateMany({
      where: { ...mine, assetId },
      data: { status: 'SUCCEEDED', completedAt: now, failureReason: null },
    });
    if (finished.count !== 1) return { kind: 'lost' };
    const row = await this.#db.creativeGenerationJob.findFirstOrThrow({
      where: { id: job.id, workspaceId: this.#workspaceId },
    });

    let attachedAt: Date | null = null;
    if (row.contentVariantId) {
      const variant = await this.#db.contentVariant.findFirst({
        where: { id: row.contentVariantId, workspaceId: this.#workspaceId, brandId: row.brandId },
        select: { id: true, assetIds: true, contentItemId: true },
      });
      if (variant && !variant.assetIds.includes(assetId)) {
        await this.#db.contentVariant.update({
          where: { id: variant.id },
          data: { assetIds: [...variant.assetIds, assetId] },
        });
        attachedAt = now;
        await writeAuditEvent(this.#db, this.#workspaceId, {
          action: 'content.media.attached_by_generation',
          actorType: 'SYSTEM',
          resourceType: 'ContentVariant',
          resourceId: variant.id,
          brandId: row.brandId,
          after: {
            assetId,
            creativeGenerationJobId: row.id,
            contentItemId: variant.contentItemId,
            ...(row.requestedByUserId ? { requestedByUserId: row.requestedByUserId } : {}),
          },
        });
      }
    }
    const done = attachedAt
      ? await this.#db.creativeGenerationJob.update({
          where: { id: row.id },
          data: { attachedAt },
        })
      : row;
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'creative.generation.succeeded',
      actorType: 'SYSTEM',
      resourceType: 'CreativeGenerationJob',
      resourceId: row.id,
      brandId: row.brandId,
      after: {
        assetId,
        attached: attachedAt !== null,
        creditsChargedMilli: (row.creditsChargedMilli ?? 0n).toString(),
      },
    });
    return { kind: 'done', view: viewOf(done) };
  }

  /** FAILED with a reason key. Only a job not already finished. */
  async fail(
    job: { readonly id: string; readonly attempts?: number },
    reason: CreativeJobFailure,
  ): Promise<boolean> {
    const finished = await this.#db.creativeGenerationJob.updateMany({
      where: {
        id: job.id,
        workspaceId: this.#workspaceId,
        status: { in: ['QUEUED', 'RUNNING'] },
        ...(job.attempts === undefined ? {} : { attempts: job.attempts }),
      },
      data: { status: 'FAILED', completedAt: this.#clock.now(), failureReason: reason },
    });
    if (finished.count !== 1) return false;
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'creative.generation.failed',
      actorType: 'SYSTEM',
      resourceType: 'CreativeGenerationJob',
      resourceId: job.id,
      after: { failureReason: reason },
    });
    return true;
  }

  /**
   * RETENTION (owner, 2026-11-04): a finished job holds the brief, customer
   * content, so it is deleted on the same schedule as the workspace's other
   * AI content — `expiryFrom(completedAt)` is `resolveContentExpiry` evaluated
   * from when the job finished. Null keeps it. Unfinished jobs are never
   * touched; the image and the AI request outlive the job.
   */
  async purgeExpired(input: {
    readonly expiryFrom: (finishedAt: Date) => Date | null;
    readonly limit: number;
  }): Promise<number> {
    const now = this.#clock.now();
    const finished = await this.#db.creativeGenerationJob.findMany({
      where: { workspaceId: this.#workspaceId, status: { in: ['SUCCEEDED', 'FAILED'] } },
      select: { id: true, completedAt: true },
      orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
    });
    const due = finished
      .filter((row) => {
        const expiry = row.completedAt ? input.expiryFrom(row.completedAt) : null;
        return expiry !== null && expiry <= now;
      })
      .map((row) => row.id);
    if (due.length === 0) return 0;
    const deleted = await this.#db.creativeGenerationJob.deleteMany({
      where: { workspaceId: this.#workspaceId, id: { in: due } },
    });
    return deleted.count;
  }
}

/**
 * Everything a run needs from its host, injected so the api and the tests
 * hand in their own: a short tenant transaction, the studio, the brand's
 * identity, and the requester's LIVE authorization (a person removed since
 * asking does not get an image made in their name).
 */
export interface CreativeJobRunHost {
  readonly workspaceId: string;
  readonly inWorkspace: <T>(fn: (db: TenantScopedClient) => Promise<T>) => Promise<T>;
  readonly studioFor: (db: TenantScopedClient) => Promise<CreativeStudioService>;
  readonly identityFor: (
    db: TenantScopedClient,
    brandId: string,
  ) => Promise<BrandIdentityInput | null>;
  readonly authorize: (
    db: TenantScopedClient,
    userId: string,
    brandId: string,
  ) => Promise<AssetActor | null>;
  readonly planKey: string | null;
  readonly clock?: Clock;
  /**
   * Waits between looks at the made image's check. The api waits on a timer;
   * a test hands in its own, to decide the check's outcome between looks.
   */
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long one run waits for the check (default `CREATIVE_JOB_CHECK_WAIT_MS`). */
  readonly checkWaitMs?: number;
}

export type CreativeJobOutcome = 'succeeded' | 'failed' | 'skipped';

/**
 * RUN ONE JOB. Claim (short transaction), prepare and authorize (short
 * transaction), generate (the studio's own short transactions, the provider
 * called with none open), finish (short transaction). Never throws: every
 * failure becomes the job's FAILED state with a reason key.
 */
export async function runCreativeGenerationJob(
  host: CreativeJobRunHost,
  jobId: string,
  options: { readonly staleBefore?: Date } = {},
): Promise<CreativeJobOutcome> {
  const jobs = (db: TenantScopedClient) =>
    new CreativeGenerationJobs({
      db,
      workspaceId: host.workspaceId,
      ...(host.clock ? { clock: host.clock } : {}),
    });

  const claimed = await host.inWorkspace((db) => jobs(db).claim(jobId, options.staleBefore));
  if (!claimed) return 'skipped';

  const failWith = async (reason: CreativeJobFailure): Promise<CreativeJobOutcome> => {
    await host.inWorkspace((db) => jobs(db).fail(claimed, reason));
    return 'failed';
  };

  if (!claimed.requestedByUserId) return failWith('access_revoked');
  const userId = claimed.requestedByUserId;

  const prepared = await host
    .inWorkspace(async (db) => ({
      actor: await host.authorize(db, userId, claimed.brandId),
      identity: await host.identityFor(db, claimed.brandId),
    }))
    .catch(() => null);
  if (!prepared) return failWith('generation_failed');
  if (!prepared.actor) return failWith('access_revoked');
  if (!prepared.identity) return failWith('not_found');
  const actor = prepared.actor;
  const identity = prepared.identity;

  try {
    const run: CreativeRun = (fn) => host.inWorkspace(async (db) => fn(await host.studioFor(db)));
    const result = await CreativeStudioService.generateWith(run, {
      brandId: claimed.brandId,
      brief: claimed.brief,
      formatKey: claimed.formatKey,
      ...(claimed.quality ? { quality: claimed.quality as ImageQuality } : {}),
      identity,
      // PR B — exactly what the person chose when they asked.
      composition: { addLogo: claimed.addLogo, headline: claimed.headline },
      // THE JOB'S KEY IS THE STUDIO'S: a second run never charges twice.
      idempotencyKey: claimed.idempotencyKey,
      actorUserId: userId,
      planKey: host.planKey,
      actor,
    });
    const recorded = await host.inWorkspace((db) =>
      jobs(db).recordGenerated(claimed, {
        assetId: result.assetId,
        aiRequestId: result.aiRequestId,
        creditsChargedMilli: result.creditsChargedMilli,
      }),
    );
    if (!recorded) return 'skipped';

    /*
     * WAIT FOR THE CHECK, with no transaction open. The job stays RUNNING;
     * the editor and the Copilot keep showing "making the image".
     */
    const sleep = host.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + (host.checkWaitMs ?? CREATIVE_JOB_CHECK_WAIT_MS);
    for (;;) {
      const check = await host.inWorkspace((db) => jobs(db).imageCheck(result.assetId));
      if (check === 'refused') return failWith('image_not_checked');
      if (check === 'clean') {
        const finish = await host.inWorkspace((db) => jobs(db).succeed(claimed));
        if (finish.kind === 'done') return 'succeeded';
        if (finish.kind === 'lost') return 'skipped';
        // Not clean any more between the two reads: look again.
      }
      // Still undecided: left RUNNING for the recovery sweep's re-run.
      if (Date.now() >= deadline) return 'skipped';
      await sleep(CREATIVE_JOB_CHECK_POLL_MS);
    }
  } catch (error: unknown) {
    return failWith(failureReasonOf(error));
  }
}

/** One unfinished job the recovery sweep found, across workspaces. */
export interface StaleCreativeJob {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly attempts: number;
}

/**
 * RECOVERY (owner, 2026-11-04): jobs a restart or a lost in-process start left
 * behind — QUEUED and never claimed since `queuedBefore`, or RUNNING and
 * silent since `runningBefore`. Read on the PLATFORM identity (the
 * `platform_access` policy); each one is then finished or failed inside its
 * own workspace's context by `runCreativeGenerationJob` / `fail`, by
 * compare-and-set, so two replicas sweeping at once act on a job once.
 */
export async function findStaleCreativeJobs(
  platform: {
    readonly creativeGenerationJob: {
      findMany(args: unknown): Promise<StaleCreativeJob[]>;
    };
  },
  input: { readonly queuedBefore: Date; readonly runningBefore: Date; readonly limit: number },
): Promise<readonly StaleCreativeJob[]> {
  return platform.creativeGenerationJob.findMany({
    where: {
      OR: [
        { status: 'QUEUED', createdAt: { lt: input.queuedBefore } },
        { status: 'RUNNING', startedAt: { lt: input.runningBefore } },
      ],
    },
    select: { id: true, workspaceId: true, status: true, attempts: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: input.limit,
  });
}
