import {
  writeAuditEvent,
  type Campaign,
  type CampaignObjective,
  type CampaignStatus,
  type Prisma,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  AppError,
  assertBrandInScope,
  brandIdQueryFilter,
  systemClock,
  type Clock,
} from '@brandspace/shared';
import { contentItemNotFound } from './errors';

/**
 * THE CAMPAIGN DOMAIN — Phase 7, and the smallest honest version of
 * docs/DATABASE.md §4.3.
 *
 * WHY IT LIVES IN `@brandspace/content` RATHER THAN IN A PACKAGE OF ITS OWN.
 * docs/DATABASE.md §4.4b already settled the ownership question when it recorded
 * `campaignId` as deliberately uncreated: "campaigns belong to the Social
 * Calendar". A campaign in this product is a way of grouping content and reading
 * its performance together; it has no lifecycle of its own that content does not
 * drive. A separate package would have been a package whose only job is to write
 * one column on a table this one owns.
 *
 * WHAT IT DELIBERATELY DOES NOT HAVE, and why each absence is the honest choice:
 *
 *   - NO BUDGET, NO CURRENCY, NO SPEND. §4.3 sketched `budgetMinor` and
 *     `currency`. BrandSpace buys no media and receives no spend data, so a
 *     budget column would be a number nobody can reconcile against anything —
 *     and a "campaign budget" field in a marketing tool is read as tracked spend.
 *   - NO KPIs AND NO ATTRIBUTION. §4.3 sketched `kpis jsonb`. A target nothing
 *     measures is a promise the product does not keep; worse, paid-media
 *     attribution is precisely the claim this platform has no data to support.
 *   - NO AD ACCOUNTS. Out of scope for the product entirely
 *     (docs/PRODUCT.md §2: "not an ads-buying platform").
 *
 * The rule §4.4b applied to `campaignId` applies to all three: a column with no
 * writer is a column whose meaning nobody has settled.
 *
 * `version` IS THE UNDO PRIMITIVE. Every mutation increments it, and the
 * Copilot's compensation contract restores a previous value only when the version
 * it acted on is still current — so a person who edited the campaign after the
 * Copilot touched it is never silently overwritten.
 */

export interface CampaignServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly clock?: Clock;
}

export interface CampaignActor {
  readonly userId: string;
  readonly brandScope: readonly string[];
}

export interface CreateCampaignInput {
  readonly brandId: string;
  readonly name: string;
  readonly objective: CampaignObjective;
  readonly brief?: { ar: string; en: string } | undefined;
  readonly description?: string | undefined;
  readonly startDate?: Date | undefined;
  readonly endDate?: Date | undefined;
  readonly channels?: readonly string[] | undefined;
  /** The accepted strategy this came out of, when it came out of one. */
  readonly strategyInsightId?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly actor: CampaignActor;
}

export function campaignNotFound(): AppError {
  return new AppError('NOT_FOUND', 'Campaign not found.');
}

/** The resource changed under the caller. Undo and concurrent edits both use it. */
export function campaignVersionConflict(): AppError {
  return new AppError('CONFLICT', 'This campaign has changed since you last saw it.');
}

const NAME_MAX = 120;

export class CampaignService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #clock: Clock;

  constructor(options: CampaignServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#clock = options.clock ?? systemClock;
  }

  async create(input: CreateCampaignInput): Promise<Campaign> {
    // D-132: the brand is named by the caller, so it is checked before anything
    // is written, and an out-of-scope brand is a 404 shaped like a genuine miss.
    assertBrandInScope(input.actor.brandScope, input.brandId);
    const name = input.name.trim();
    if (name.length === 0 || name.length > NAME_MAX) {
      throw new AppError('VALIDATION_FAILED', 'That campaign name is not valid.');
    }
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new AppError('VALIDATION_FAILED', 'A campaign cannot end before it starts.');
    }

    // Idempotency: a retried creation returns the first campaign rather than
    // making a second. Matters more here than usual, because the Copilot creates
    // campaigns and a retried tool call must not duplicate one.
    if (input.idempotencyKey) {
      const existing = await this.#db.campaign.findFirst({
        where: { workspaceId: this.#workspaceId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) return existing;
    }

    /*
     * A STRATEGY LINK IS VERIFIED, AND ONLY AN ACCEPTED ONE COUNTS.
     *
     * Read through the scope predicate, so a foreign or fabricated insight id is
     * a miss rather than a link. `ACCEPTED` because a generated strategy is a
     * proposal until a permitted human accepts it — a campaign claiming to come
     * out of a proposal nobody agreed to would make the acceptance step
     * decorative.
     */
    if (input.strategyInsightId) {
      const strategy = await this.#db.insight.findFirst({
        where: {
          id: input.strategyInsightId,
          workspaceId: this.#workspaceId,
          brandId: input.brandId,
          type: { in: ['STRATEGY', 'MONTHLY_PLAN'] },
          status: 'ACCEPTED',
          ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
        },
        select: { id: true },
      });
      if (!strategy) throw new AppError('VALIDATION_FAILED', 'That strategy cannot be used here.');
    }

    const campaign = await this.#db.campaign.create({
      data: {
        workspaceId: this.#workspaceId,
        brandId: input.brandId,
        name,
        objective: input.objective,
        ...(input.brief ? { brief: input.brief as Prisma.InputJsonValue } : {}),
        description: input.description ?? null,
        status: 'DRAFT',
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        channels: [...(input.channels ?? [])],
        strategyInsightId: input.strategyInsightId ?? null,
        ownerUserId: input.actor.userId,
        createdByUserId: input.actor.userId,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'campaign.created',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Campaign',
      resourceId: campaign.id,
      brandId: input.brandId,
      // Shape, never the brief — which is customer content and belongs on the row.
      after: {
        objective: campaign.objective,
        channels: campaign.channels.length,
        fromStrategy: input.strategyInsightId !== undefined,
      },
    });

    return campaign;
  }

  /**
   * Edit a campaign, with optimistic concurrency.
   *
   * `expectedVersion` IS OPTIONAL FOR A HUMAN AND REQUIRED FOR AN UNDO. A person
   * editing a screen they have open expects last-write-wins; a compensation that
   * blindly restored an old value would silently discard somebody else's work.
   * One method, one guard, and the caller decides which it is.
   */
  async update(input: {
    campaignId: string;
    expectedVersion?: number | undefined;
    name?: string | undefined;
    objective?: CampaignObjective | undefined;
    brief?: { ar: string; en: string } | undefined;
    description?: string | null | undefined;
    status?: CampaignStatus | undefined;
    startDate?: Date | null | undefined;
    endDate?: Date | null | undefined;
    channels?: readonly string[] | undefined;
    actor: CampaignActor;
    /** Recorded on the audit event. `undo` distinguishes a compensation. */
    reason?: string | undefined;
  }): Promise<Campaign> {
    const existing = await this.#require(input.campaignId, input.actor.brandScope);

    if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      throw campaignVersionConflict();
    }

    const start = input.startDate === undefined ? existing.startDate : input.startDate;
    const end = input.endDate === undefined ? existing.endDate : input.endDate;
    if (start && end && end < start) {
      throw new AppError('VALIDATION_FAILED', 'A campaign cannot end before it starts.');
    }

    const updated = await this.#db.campaign.update({
      where: { id: existing.id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name.trim().slice(0, NAME_MAX) }),
        ...(input.objective === undefined ? {} : { objective: input.objective }),
        ...(input.brief === undefined ? {} : { brief: input.brief as Prisma.InputJsonValue }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
        ...(input.endDate === undefined ? {} : { endDate: input.endDate }),
        ...(input.channels === undefined ? {} : { channels: [...input.channels] }),
        version: { increment: 1 },
      },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'campaign.updated',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Campaign',
      resourceId: updated.id,
      brandId: updated.brandId,
      ...(input.reason ? { reason: input.reason } : {}),
      before: { version: existing.version, status: existing.status },
      after: { version: updated.version, status: updated.status },
    });

    return updated;
  }

  /**
   * Attach content to a campaign, or detach it.
   *
   * BOTH SIDES ARE SCOPE-CHECKED AT THE QUERY. Attaching is the one operation
   * that names two tenant rows at once, and a caller that had checked only the
   * campaign could attach another brand's draft to it.
   */
  async setContentCampaign(input: {
    contentItemId: string;
    campaignId: string | null;
    actor: CampaignActor;
  }): Promise<void> {
    const item = await this.#db.contentItem.findFirst({
      where: {
        id: input.contentItemId,
        workspaceId: this.#workspaceId,
        deletedAt: null,
        ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
      },
      select: { id: true, brandId: true, campaignId: true },
    });
    if (!item) throw contentItemNotFound();

    if (input.campaignId) {
      const campaign = await this.#require(input.campaignId, input.actor.brandScope);
      /*
       * A CAMPAIGN AND ITS CONTENT MUST SHARE A BRAND. The composite foreign key
       * checks the WORKSPACE, not the brand; without this check a member with a
       * wide scope could file brand A's post under brand B's campaign, and every
       * campaign analytic afterwards would be quietly wrong.
       */
      if (campaign.brandId !== item.brandId) throw campaignNotFound();
    }

    await this.#db.contentItem.update({
      where: { id: item.id },
      data: { campaignId: input.campaignId },
    });

    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: input.campaignId ? 'campaign.content_attached' : 'campaign.content_detached',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'ContentItem',
      resourceId: item.id,
      brandId: item.brandId,
      before: { campaignId: item.campaignId },
      after: { campaignId: input.campaignId },
    });
  }

  /** Archive a campaign. Reversible, and never deletes the content in it. */
  async archive(input: { campaignId: string; actor: CampaignActor }): Promise<Campaign> {
    const existing = await this.#require(input.campaignId, input.actor.brandScope);
    const updated = await this.#db.campaign.update({
      where: { id: existing.id },
      data: { status: 'ARCHIVED', deletedAt: this.#clock.now(), version: { increment: 1 } },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'campaign.archived',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Campaign',
      resourceId: updated.id,
      brandId: updated.brandId,
      before: { status: existing.status },
      after: { status: updated.status },
    });
    return updated;
  }

  /** Bring an archived campaign back. The other half of `archive`. */
  async restore(input: {
    campaignId: string;
    status?: CampaignStatus | undefined;
    actor: CampaignActor;
  }): Promise<Campaign> {
    const existing = await this.#db.campaign.findFirst({
      where: {
        id: input.campaignId,
        workspaceId: this.#workspaceId,
        ...brandIdQueryFilter({ brandScope: input.actor.brandScope }),
      },
    });
    if (!existing) throw campaignNotFound();

    const updated = await this.#db.campaign.update({
      where: { id: existing.id },
      data: {
        status: input.status ?? 'DRAFT',
        deletedAt: null,
        version: { increment: 1 },
      },
    });
    await writeAuditEvent(this.#db, this.#workspaceId, {
      action: 'campaign.restored',
      actorType: 'USER',
      actorId: input.actor.userId,
      resourceType: 'Campaign',
      resourceId: updated.id,
      brandId: updated.brandId,
      after: { status: updated.status },
    });
    return updated;
  }

  async list(input: {
    brandId?: string | undefined;
    statuses?: readonly CampaignStatus[] | undefined;
    includeArchived?: boolean | undefined;
    brandScope: readonly string[];
    take?: number | undefined;
  }): Promise<readonly Campaign[]> {
    if (input.brandId) assertBrandInScope(input.brandScope, input.brandId);
    return this.#db.campaign.findMany({
      where: {
        workspaceId: this.#workspaceId,
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
        ...(input.includeArchived ? {} : { deletedAt: null }),
        ...(input.statuses?.length ? { status: { in: [...input.statuses] } } : {}),
      },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
      take: Math.max(1, Math.min(input.take ?? 50, 200)),
    });
  }

  async get(campaignId: string, brandScope: readonly string[]): Promise<Campaign> {
    return this.#require(campaignId, brandScope);
  }

  /** How many content items are filed under a campaign. Scope-filtered. */
  async contentCount(campaignId: string, brandScope: readonly string[]): Promise<number> {
    await this.#require(campaignId, brandScope);
    return this.#db.contentItem.count({
      where: {
        workspaceId: this.#workspaceId,
        campaignId,
        deletedAt: null,
        ...brandIdQueryFilter({ brandScope }),
      },
    });
  }

  /**
   * D-132: the scope is part of the WHERE, so an out-of-scope campaign is never
   * retrieved rather than retrieved and then rejected.
   */
  async #require(campaignId: string, brandScope: readonly string[]): Promise<Campaign> {
    const campaign = await this.#db.campaign.findFirst({
      where: {
        id: campaignId,
        workspaceId: this.#workspaceId,
        deletedAt: null,
        ...brandIdQueryFilter({ brandScope }),
      },
    });
    if (!campaign) throw campaignNotFound();
    return campaign;
  }
}
