import type { PrismaClient } from '@brandspace/database';
import { AppError, systemClock, type Clock } from '@brandspace/shared';

import type { AiFailureClass } from './errors';

/**
 * The AI usage explorer and request inspector — docs/AI-GATEWAY.md §12,
 * docs/ADMIN-CONTROL-CENTER.md §7.1.
 *
 * PAGED, WITH A TRUTHFUL TOTAL — the F-53 / A-11 contract, applied here before
 * the defect rather than after it. Every listing in this file:
 *
 *   - runs exactly two bounded queries, a count and a page;
 *   - orders totally, with an `id` tie-break, so a row cannot appear on two
 *     pages or on none when two share a timestamp;
 *   - clamps an out-of-range page to the last one rather than showing nothing;
 *   - caps the size of ONE REQUEST, never what an operator may ultimately see.
 *
 * A silent cap here would be worse than in most places: an operator reading
 * "47 failures" would act on it, and the number would be a lie about a
 * financial record.
 */

export const AI_PAGE_SIZES = [25, 50, 100, 200] as const;
export const DEFAULT_AI_PAGE_SIZE = 50;
/** A bound on ONE REQUEST, not on what an operator may see. */
export const MAX_AI_PAGE_SIZE = 200;

function normalisePageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_AI_PAGE_SIZE;
  const size = Math.trunc(requested);
  if (size < 1) return DEFAULT_AI_PAGE_SIZE;
  return Math.min(size, MAX_AI_PAGE_SIZE);
}

export interface AiPage<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageSize: number;
  /** Total MATCHING rows, not the number on this page. */
  readonly total: number;
  readonly totalPages: number;
  readonly from: number;
  readonly to: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
}

export interface AiRequestListItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly taskKey: string;
  readonly status: string;
  readonly modelKey: string | null;
  readonly attemptedModelKeys: readonly string[];
  readonly failureClass: AiFailureClass | null;
  readonly creditsChargedMilli: bigint;
  readonly providerCostMicroMinor: bigint;
  readonly latencyMs: number | null;
  readonly retryCount: number;
  readonly createdAt: Date;
}

export interface AiRequestDetail extends AiRequestListItem {
  readonly userId: string | null;
  readonly idempotencyKey: string;
  readonly failureMessage: string | null;
  readonly creditsReservedMilli: bigint;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly imageCount: number | null;
  readonly durationSeconds: number | null;
  readonly currency: string;
  readonly byok: boolean;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly deadlineAt: Date;
  /** Audit-safe metadata about the input. Never the prompt itself (§11). */
  readonly inputSummary: unknown;
  readonly ledger: readonly AiLedgerEntry[];
}

export interface AiLedgerEntry {
  readonly id: string;
  readonly occurredAt: Date;
  readonly modelKey: string;
  readonly providerKey: string;
  readonly creditsChargedMilli: bigint;
  readonly providerCostMicroMinor: bigint;
  readonly currency: string;
  readonly byok: boolean;
}

export interface AiRequestFilter {
  readonly workspaceId?: string;
  readonly taskKey?: string;
  readonly status?: string;
  readonly failureClass?: string;
  readonly modelKey?: string;
  readonly since?: Date;
  readonly page?: number;
  readonly pageSize?: number;
}

/** One row of the usage rollup — §12's cost and credit reporting. */
export interface AiUsageRollupRow {
  readonly key: string;
  readonly requests: number;
  readonly creditsChargedMilli: bigint;
  readonly providerCostMicroMinor: bigint;
}

export interface AiUsageExplorerOptions {
  readonly prisma: PrismaClient;
  /** Permission keys the caller holds. Checked, never assumed. */
  readonly requiredPermission?: string;
  readonly clock?: Clock;
}

export const AI_USAGE_READ_PERMISSION = 'platform.ai.usage.read';

export interface AiExplorerActor {
  readonly platformUserId: string;
  readonly permissionKeys: readonly string[];
}

export class AiUsageExplorer {
  readonly #prisma: PrismaClient;
  readonly #permission: string;
  readonly #clock: Clock;

  constructor(options: AiUsageExplorerOptions) {
    this.#prisma = options.prisma;
    this.#permission = options.requiredPermission ?? AI_USAGE_READ_PERMISSION;
    this.#clock = options.clock ?? systemClock;
  }

  #authorize(actor: AiExplorerActor): void {
    if (!actor.permissionKeys.includes(this.#permission)) {
      throw new AppError('FORBIDDEN', 'This operation requires the AI usage read permission.');
    }
  }

  /** A page of AI requests, newest first. */
  async requests(
    actor: AiExplorerActor,
    filter: AiRequestFilter = {},
  ): Promise<AiPage<AiRequestListItem>> {
    this.#authorize(actor);

    const pageSize = normalisePageSize(filter.pageSize);
    const where = {
      ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
      ...(filter.taskKey ? { taskKey: filter.taskKey } : {}),
      ...(filter.status ? { status: filter.status as never } : {}),
      ...(filter.failureClass ? { failureClass: filter.failureClass as never } : {}),
      ...(filter.modelKey ? { resolvedModelKey: filter.modelKey } : {}),
      ...(filter.since ? { createdAt: { gte: filter.since } } : {}),
    };

    const total = await this.#prisma.aiRequest.count({ where });
    const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
    const requested = Number.isFinite(filter.page) ? Math.trunc(filter.page ?? 1) : 1;
    // Clamped, not emptied: an operator who bookmarked page 9 and then filtered
    // down to three pages gets the last page, not a blank screen.
    const page = Math.min(Math.max(requested, 1), totalPages);

    const rows = await this.#prisma.aiRequest.findMany({
      where,
      // `id` makes the order total: two requests created in the same
      // millisecond cannot land on two pages or on none.
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    const items = rows.map((row): AiRequestListItem => ({
      id: row.id,
      workspaceId: row.workspaceId,
      taskKey: row.taskKey,
      status: row.status,
      modelKey: row.resolvedModelKey,
      attemptedModelKeys: row.attemptedModelKeys,
      failureClass: row.failureClass as AiFailureClass | null,
      creditsChargedMilli: row.creditsChargedMilli,
      providerCostMicroMinor: row.providerCostMicroMinor,
      latencyMs: row.latencyMs,
      retryCount: row.retryCount,
      createdAt: row.createdAt,
    }));

    return {
      items,
      page,
      pageSize,
      total,
      totalPages,
      from: total === 0 ? 0 : (page - 1) * pageSize + 1,
      to: total === 0 ? 0 : (page - 1) * pageSize + items.length,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    };
  }

  /** One request and its ledger rows — the inspector. */
  async request(actor: AiExplorerActor, requestId: string): Promise<AiRequestDetail> {
    this.#authorize(actor);

    const row = await this.#prisma.aiRequest.findUnique({
      where: { id: requestId },
      include: { ledger: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] } },
    });
    if (!row) throw new AppError('NOT_FOUND', 'AI request not found.');

    return {
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      idempotencyKey: row.idempotencyKey,
      taskKey: row.taskKey,
      status: row.status,
      modelKey: row.resolvedModelKey,
      attemptedModelKeys: row.attemptedModelKeys,
      failureClass: row.failureClass as AiFailureClass | null,
      failureMessage: row.failureMessage,
      creditsChargedMilli: row.creditsChargedMilli,
      creditsReservedMilli: row.creditsReservedMilli,
      providerCostMicroMinor: row.providerCostMicroMinor,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      imageCount: row.imageCount,
      durationSeconds: row.durationSeconds,
      currency: row.currency,
      byok: row.byok,
      latencyMs: row.latencyMs,
      retryCount: row.retryCount,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      deadlineAt: row.deadlineAt,
      // Metadata only. The output is deliberately NOT surfaced here even when
      // a rule persisted it: reading a customer's generated content is a
      // support-mode decision with its own audit trail, not a side effect of
      // opening an operations screen.
      inputSummary: row.inputSummary,
      ledger: row.ledger.map((entry) => ({
        id: entry.id,
        occurredAt: entry.occurredAt,
        modelKey: entry.modelKey,
        providerKey: entry.providerKey,
        creditsChargedMilli: entry.creditsChargedMilli,
        providerCostMicroMinor: entry.providerCostMicroMinor,
        currency: entry.currency,
        byok: entry.byok,
      })),
    };
  }

  /**
   * Credits and provider cost grouped by model or by task — §12's reporting.
   *
   * Read from the LEDGER, not from the request rows: the ledger is the
   * immutable financial record, and a correction row belongs in these totals
   * while the request row it corrects does not change.
   */
  async rollup(
    actor: AiExplorerActor,
    groupBy: 'modelKey' | 'taskKey',
    filter: { readonly workspaceId?: string; readonly since?: Date } = {},
  ): Promise<readonly AiUsageRollupRow[]> {
    this.#authorize(actor);

    const where = {
      ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
      ...(filter.since ? { occurredAt: { gte: filter.since } } : {}),
    };

    const groups = await this.#prisma.aiUsageLedger.groupBy({
      by: [groupBy],
      where,
      _count: { _all: true },
      _sum: { creditsChargedMilli: true, providerCostMicroMinor: true },
    });

    return (
      groups
        .map((group) => ({
          key: String(group[groupBy]),
          requests: group._count._all,
          creditsChargedMilli: group._sum.creditsChargedMilli ?? 0n,
          providerCostMicroMinor: group._sum.providerCostMicroMinor ?? 0n,
        }))
        // Ordered by spend so the expensive thing is the first thing read, with a
        // key tie-break so the table does not reshuffle between refreshes.
        .sort((a, b) =>
          b.creditsChargedMilli === a.creditsChargedMilli
            ? a.key.localeCompare(b.key)
            : Number(b.creditsChargedMilli - a.creditsChargedMilli),
        )
    );
  }

  /**
   * The reservation-leak count of §12, which must stay at zero.
   *
   * Counts requests that are past their deadline and still non-terminal — the
   * rows `sweepStuckRequests` exists to drain. A number above zero here is
   * either a sweep that is not running or one that cannot make progress.
   */
  async leakCount(actor: AiExplorerActor): Promise<number> {
    this.#authorize(actor);
    // The clock is the service's, not the caller's: a page that passed its own
    // `new Date()` would make the metric untestable and would be the one place
    // in the codebase reading the wall clock directly.
    return this.#prisma.aiRequest.count({
      where: {
        status: { in: ['PENDING', 'RESERVED', 'RUNNING'] },
        deadlineAt: { lt: this.#clock.now() },
      },
    });
  }
}
