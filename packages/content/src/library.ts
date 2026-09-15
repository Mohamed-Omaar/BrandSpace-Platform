import type { Prisma } from '@brandspace/database';
import {
  writeAuditEvent,
  type ContentItem,
  type ContentVariant,
  type TenantScopedClient,
} from '@brandspace/database';
import { assertBrandInScope, brandIdScopeFilter } from '@brandspace/shared';
import { contentItemNotFound, transitionNotAllowed, unsupportedPlatform } from './errors';
import { findPlatform, type ContentPolicy } from './policy';
import { validateVariant } from './validation';

/**
 * The half of the Content Studio that NEVER calls a model.
 *
 * WHY IT IS A SEPARATE CLASS, AND NOT A FLAG ON THE OTHER ONE.
 *
 * The AI Gateway reads platform-owned `ai.*` configuration and settles credits
 * in its own transactions, so it needs the PLATFORM database identity — and
 * F-07 forbids the customer dashboard from ever holding that identity. The
 * dashboard therefore CANNOT construct a gateway, which means it cannot
 * construct a service that requires one.
 *
 * The alternative was an optional `gateway` that three methods throw over at
 * runtime. That turns a boundary the compiler can enforce into a mistake a
 * reviewer has to notice: a new dashboard call site reaching `generate()` would
 * typecheck, lint, pass review and fail in production. Splitting the class
 * makes the same mistake a compile error, and costs one file.
 *
 * So: browsing, reading, saving a person's OWN edit and moving a draft through
 * its states live here and run in the dashboard under RLS. Generation, the
 * editing tools and the quote live in `ContentStudioService`, which extends
 * this one and runs only where a gateway legitimately exists (`apps/api`).
 */
export interface ContentLibraryOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: ContentPolicy;
}

export class ContentLibraryService {
  /*
   * `protected`, not `#private`, precisely because `ContentStudioService`
   * extends this. A `#` field is invisible to a subclass, and the alternative —
   * duplicating the three fields and the constructor — is how two copies of a
   * workspace id end up disagreeing.
   */
  protected readonly db: TenantScopedClient;
  protected readonly workspaceId: string;
  protected readonly policy: ContentPolicy;

  constructor(options: ContentLibraryOptions) {
    this.db = options.db;
    this.workspaceId = options.workspaceId;
    this.policy = options.policy;
  }

  async listItems(input: {
    brandId?: string | undefined;
    /**
     * The caller's membership BrandScope. Empty or absent is UNRESTRICTED —
     * the platform rule `brandInScope()` has carried since Phase 2B.
     *
     * APPLIED IN THE QUERY, AND THAT MATTERS HERE MORE THAN ANYWHERE. `limit`
     * is applied by the database, so a caller that filtered by brand AFTER
     * this returned would be filtering a page that had already been truncated:
     * a member scoped to one brand, in a workspace whose most recent 200
     * drafts belong to another, would be shown nothing at all and told it was
     * empty. The calendar's draft picker did exactly that.
     */
    brandScope?: readonly string[] | null | undefined;
    status?: ContentItem['status'] | undefined;
    search?: string | undefined;
    limit?: number | undefined;
  }): Promise<(ContentItem & { variants: ContentVariant[] })[]> {
    return this.db.contentItem.findMany({
      where: {
        deletedAt: null,
        ...(input.brandId ? { brandId: input.brandId } : {}),
        ...brandIdScopeFilter(input.brandScope),
        ...(input.status ? { status: input.status } : {}),
        /*
         * Search is over the TITLE only, and deliberately.
         *
         * Searching variant bodies would make the filter a way to ask whether a
         * given phrase appears anywhere in the workspace's drafts. RLS keeps
         * that inside one tenant, so it is not a leak — but it is still a
         * capability nobody asked for, and the composer already shows the body
         * of anything the member can open.
         */
        ...(input.search ? { title: { contains: input.search, mode: 'insensitive' } } : {}),
      },
      include: { variants: { orderBy: { platformKey: 'asc' } } },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(input.limit ?? 50, 200),
    });
  }

  /** Counts per status, for the library's tabs. One query, not six. */
  async countsByStatus(
    brandId?: string | undefined,
  ): Promise<Record<ContentItem['status'], number>> {
    const rows = await this.db.contentItem.groupBy({
      by: ['status'],
      where: { deletedAt: null, ...(brandId ? { brandId } : {}) },
      _count: { _all: true },
    });
    const counts = {} as Record<ContentItem['status'], number>;
    for (const row of rows) counts[row.status] = row._count._all;
    return counts;
  }

  async getItem(itemId: string): Promise<ContentItem & { variants: ContentVariant[] }> {
    const item = await this.db.contentItem.findUnique({
      where: { id: itemId },
      include: { variants: { orderBy: { platformKey: 'asc' } } },
    });
    if (!item || item.deletedAt) throw contentItemNotFound();
    return item;
  }

  /** Save a customer's own edit. No gateway, no credits — they wrote it. */
  async editVariant(input: {
    variantId: string;
    body: string;
    hashtags?: readonly string[];
    firstComment?: string | null;
    actorUserId: string;
    actorBrandScope: readonly string[];
  }): Promise<ContentVariant> {
    const variant = await this.db.contentVariant.findUnique({ where: { id: input.variantId } });
    if (!variant) throw contentItemNotFound();
    assertBrandInScope(input.actorBrandScope, variant.brandId);

    const platform = findPlatform(this.policy, variant.platformKey);
    if (!platform) throw unsupportedPlatform();

    const validation = validateVariant(platform, {
      body: input.body,
      ...(input.hashtags ? { hashtags: input.hashtags } : {}),
      firstComment: input.firstComment ?? null,
    });

    const updated = await this.db.contentVariant.update({
      where: { id: variant.id },
      data: {
        body: input.body,
        ...(input.hashtags ? { hashtags: [...input.hashtags] } : {}),
        firstComment: input.firstComment ?? null,
        origin: variant.origin === 'HUMAN' ? 'HUMAN' : 'AI_ASSISTED',
        characterCount: validation.characterCount,
        validationState: validation.state,
        ...(validation.errors.length > 0
          ? { validationErrors: validation.errors as unknown as Prisma.InputJsonValue }
          : {}),
        bodyPurgedAt: null,
      },
    });

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'content.variant.edited',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'ContentVariant',
      resourceId: variant.id,
      brandId: variant.brandId,
      after: { characterCount: validation.characterCount, validationState: validation.state },
    });

    /*
     * PHASE 5B-3 — AN EDIT REVOKES AN APPROVAL.
     *
     * An approval is a judgement about particular words. Once those words
     * change, the record still says "approved" while nobody has read what it now
     * approves — and with the calendar gate on, that difference is the whole
     * control. So an edit to an APPROVED item returns it to DRAFT, audibly.
     *
     * A SCHEDULED item is not touched here, and cannot be: `transition()`
     * refuses to move it and the calendar owns that edge. Editing the caption of
     * something already planned is a Phase 6 question — there is a slot pointing
     * at it — and this phase does not answer it by silently unscheduling.
     */
    await this.#revokeApprovalOnEdit(input.actorUserId, variant.contentItemId, variant.brandId);
    return updated;
  }

  /** See `editVariant`. Separate so the reason has somewhere to live. */
  async #revokeApprovalOnEdit(
    actorUserId: string,
    contentItemId: string,
    brandId: string,
  ): Promise<void> {
    const item = await this.db.contentItem.findUnique({
      where: { id: contentItemId },
      select: { id: true, status: true },
    });
    if (item?.status !== 'APPROVED') return;
    await this.db.contentItem.update({ where: { id: item.id }, data: { status: 'DRAFT' } });
    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'content.approval_revoked',
      actorType: 'USER',
      actorId: actorUserId,
      resourceType: 'ContentItem',
      resourceId: item.id,
      brandId,
      severity: 'NOTICE',
      reason: 'edited_after_approval',
      before: { status: 'APPROVED' },
      after: { status: 'DRAFT' },
    });
  }

  /**
   * The states a member may move content between DIRECTLY.
   *
   * SCHEDULED IS NOT REACHABLE FROM HERE, and an item that IS scheduled cannot
   * be moved from here either. The calendar owns that edge in both directions:
   * `ContentCalendarService.schedule()` sets it alongside creating the slot and
   * `cancel()` clears it alongside cancelling the slot, in the same transaction
   * each time. A second path into or out of `SCHEDULED` would let an item be
   * archived out from under a live calendar entry, which is a plan pointing at
   * content that is no longer planned.
   *
   * PHASE 5B-3 REMOVED `IN_REVIEW` FROM THIS TABLE, and that is the milestone's
   * central integrity change rather than a tightening. A direct DRAFT →
   * IN_REVIEW move produced an item in a queue with NO `approval` row behind it:
   * no requester, no policy snapshot, no cycle, nothing for a reviewer to
   * decide and nothing for the history to show. Review is entered through
   * `ContentApprovalService.submit()` and left through `decide()` or `cancel()`,
   * so there is one lifecycle with one writer per edge.
   *
   * `APPROVED` is likewise not a target here: it is a verdict, and a verdict
   * that could be self-assigned through the library would make the whole module
   * decorative.
   */
  async transition(input: {
    itemId: string;
    to: 'DRAFT' | 'ARCHIVED';
    actorUserId: string;
    actorBrandScope: readonly string[];
  }): Promise<ContentItem> {
    const item = await this.db.contentItem.findUnique({ where: { id: input.itemId } });
    if (!item || item.deletedAt) throw contentItemNotFound();
    assertBrandInScope(input.actorBrandScope, item.brandId);

    const allowed: Record<string, readonly string[]> = {
      DRAFT: ['ARCHIVED'],
      // Withdraw the review instead: `ContentApprovalService.cancel()` closes
      // the cycle AND returns the item, so the queue cannot be emptied by a
      // route that leaves a PENDING row pointing at a draft.
      IN_REVIEW: [],
      // A reviewer asked for changes. The item is editable and resubmittable;
      // archiving it is also a legitimate answer to "we are not doing this".
      CHANGES_REQUESTED: ['DRAFT', 'ARCHIVED'],
      // An approved item may be shelved. It may NOT be walked back to a draft
      // from here — editing it does that, audibly, and that path records why.
      APPROVED: ['ARCHIVED'],
      ARCHIVED: ['DRAFT'],
      // Deliberately empty: take it off the calendar first. See above.
      SCHEDULED: [],
    };
    if (!(allowed[item.status] ?? []).includes(input.to)) throw transitionNotAllowed();

    const updated = await this.db.contentItem.update({
      where: { id: item.id },
      data: { status: input.to },
    });
    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'content.item.transitioned',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'ContentItem',
      resourceId: item.id,
      brandId: item.brandId,
      before: { status: item.status },
      after: { status: input.to },
    });
    return updated;
  }
}
