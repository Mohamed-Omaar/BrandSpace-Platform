import type { PublishJob, SocialProvider, TenantScopedClient } from '@brandspace/database';
import { brandIdQueryFilter } from '@brandspace/shared';
import { FAILURE_BEHAVIOUR } from './errors';
import { publishJobNotFound } from './errors';

/**
 * Publishing history — what the customer sees about what went out.
 *
 * THE VIEW IS A PROJECTION, NOT THE ROW. `PublishJob` carries a provider error
 * code and a failure code; the screen gets a STATUS, a stable code it can
 * translate, and the two booleans that decide which buttons to render. Handing
 * a React tree the raw row is how a provider's own message ends up rendered to
 * a customer.
 *
 * ATTEMPTS ARE SUMMARISED, NEVER DUMPED. Each carries a redacted summary that
 * was bounded on the way in and is bounded again here.
 */

export interface PublishAttemptView {
  readonly attemptNumber: number;
  readonly outcome: string;
  readonly failureClass: string | null;
  readonly providerStatusCode: number | null;
  readonly safeSummary: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface PublishJobView {
  readonly id: string;
  readonly brandId: string;
  readonly provider: SocialProvider;
  readonly status: PublishJob['status'];
  readonly scheduledAtUtc: Date;
  readonly publishedAt: Date | null;
  readonly externalPostUrl: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date | null;
  readonly failureClass: PublishJob['failureClass'];
  /** Stable and ours. The dashboard maps it to a localized sentence. */
  readonly failureCode: string | null;
  readonly contentItemId: string;
  readonly calendarSlotId: string;
  /** D-291 — which post version and which account; ids only, never a credential. */
  readonly contentVariantId: string;
  readonly socialConnectionId: string;
  /** Derived, so every surface agrees which buttons exist. */
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  readonly needsReconnect: boolean;
}

export function toPublishJobView(job: PublishJob): PublishJobView {
  const behaviour = job.failureClass ? FAILURE_BEHAVIOUR[job.failureClass] : null;
  return {
    id: job.id,
    brandId: job.brandId,
    provider: job.provider,
    status: job.status,
    scheduledAtUtc: job.scheduledAtUtc,
    publishedAt: job.publishedAt,
    externalPostUrl: job.externalPostUrl,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt,
    failureClass: job.failureClass,
    failureCode: job.failureCode,
    contentItemId: job.contentItemId,
    calendarSlotId: job.calendarSlotId,
    contentVariantId: job.contentVariantId,
    socialConnectionId: job.socialConnectionId,
    canCancel: job.status === 'PENDING' || job.status === 'QUEUED',
    canRetry:
      (job.status === 'FAILED' || job.status === 'VERIFICATION_PENDING') &&
      (behaviour === null || behaviour.manualRetryUseful),
    needsReconnect: behaviour?.needsReconnect ?? false,
  };
}

export interface PublishHistoryOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
}

/** The ceiling on one page, whatever a caller asks for. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export class PublishHistoryService {
  readonly #db: TenantScopedClient;

  constructor(options: PublishHistoryOptions) {
    this.#db = options.db;
  }

  /**
   * The workspace's publishing history, newest first.
   *
   * BRANDSCOPE IS IN THE `where` (D-134). The limit is applied in the database
   * AFTER the predicate, which is the ordering F-10 got wrong the other way
   * round: filtering an already-truncated page shows a scoped member nothing
   * and tells them it is empty.
   */
  async list(input: {
    brandScope: readonly string[];
    brandId?: string | undefined;
    statuses?: readonly PublishJob['status'][] | undefined;
    limit?: number | undefined;
  }): Promise<readonly PublishJobView[]> {
    const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
    const rows = await this.#db.publishJob.findMany({
      where: {
        ...brandIdQueryFilter({
          ...(input.brandId ? { brandId: input.brandId } : {}),
          brandScope: input.brandScope,
        }),
        ...(input.statuses && input.statuses.length > 0
          ? { status: { in: [...input.statuses] } }
          : {}),
      },
      orderBy: [{ scheduledAtUtc: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toPublishJobView);
  }

  /** A count per status. A COUNT IS A DISCLOSURE, so it is scoped too (F-10). */
  async countsByStatus(input: {
    brandScope: readonly string[];
    brandId?: string | undefined;
  }): Promise<Record<string, number>> {
    const rows = await this.#db.publishJob.groupBy({
      by: ['status'],
      where: brandIdQueryFilter({
        ...(input.brandId ? { brandId: input.brandId } : {}),
        brandScope: input.brandScope,
      }),
      _count: { _all: true },
    });
    return Object.fromEntries(rows.map((row) => [row.status, row._count._all]));
  }

  /** One job and its attempts. Out-of-scope reads the same as never existed. */
  async detail(input: {
    jobId: string;
    brandScope: readonly string[];
  }): Promise<{ job: PublishJobView; attempts: readonly PublishAttemptView[] }> {
    const job = await this.#db.publishJob.findFirst({
      where: { id: input.jobId, ...brandIdQueryFilter({ brandScope: input.brandScope }) },
    });
    if (!job) throw publishJobNotFound();

    const attempts = await this.#db.publishAttempt.findMany({
      where: { publishJobId: job.id },
      orderBy: { attemptNumber: 'asc' },
    });
    return {
      job: toPublishJobView(job),
      attempts: attempts.map((attempt) => ({
        attemptNumber: attempt.attemptNumber,
        outcome: attempt.outcome,
        failureClass: attempt.failureClass,
        providerStatusCode: attempt.providerStatusCode,
        safeSummary: attempt.safeSummary === null ? null : attempt.safeSummary.slice(0, 500),
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
      })),
    };
  }

  /** Jobs for one content item — the publishing half of its detail view. */
  async forItem(input: {
    contentItemId: string;
    brandScope: readonly string[];
  }): Promise<readonly PublishJobView[]> {
    const rows = await this.#db.publishJob.findMany({
      where: {
        contentItemId: input.contentItemId,
        ...brandIdQueryFilter({ brandScope: input.brandScope }),
      },
      orderBy: [{ provider: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toPublishJobView);
  }
}
