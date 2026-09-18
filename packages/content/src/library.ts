import type { Prisma } from '@brandspace/database';
import {
  writeAuditEvent,
  type ContentItem,
  type ContentVariant,
  type TenantScopedClient,
} from '@brandspace/database';
import { brandIdQueryFilter } from '@brandspace/shared';
import { contentItemNotFound, transitionNotAllowed, unsupportedPlatform } from './errors';
import { findPlatform, type ContentPolicy } from './policy';
import { ContentMediaResolver } from './media';
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
    /**
     * PHASE 8 — the campaign this content is filed under (AC-26.3).
     *
     * IN THE QUERY, for the same reason the brand scope is: a caller filtering
     * after this returned would be filtering a page the database had already
     * truncated, and a campaign whose content is older than the most recent
     * fifty drafts would read as empty. The campaign id itself is NOT trusted
     * here — it is a filter, not an authorization — and the brand scope above
     * still decides which rows exist at all, so naming another workspace's
     * campaign returns nothing rather than anything.
     */
    campaignId?: string | undefined;
    search?: string | undefined;
    limit?: number | undefined;
  }): Promise<(ContentItem & { variants: ContentVariant[] })[]> {
    return this.db.contentItem.findMany({
      where: {
        deletedAt: null,
        // INTERSECTS rather than overwrites — see `brandIdQueryFilter`.
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
        ...(input.status ? { status: input.status } : {}),
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
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
  async countsByStatus(input?: {
    brandId?: string | undefined;
    /**
     * The caller's membership BrandScope. Empty or absent is UNRESTRICTED.
     *
     * A COUNT IS A DISCLOSURE. Without this, the library's status tabs told a
     * member scoped to one brand how many drafts, approved items and archived
     * items the workspace's OTHER brands hold — a number they could watch move.
     */
    brandScope?: readonly string[] | null | undefined;
  }): Promise<Record<ContentItem['status'], number>> {
    const rows = await this.db.contentItem.groupBy({
      by: ['status'],
      where: {
        deletedAt: null,
        ...brandIdQueryFilter({ brandId: input?.brandId, brandScope: input?.brandScope }),
      },
      _count: { _all: true },
    });
    const counts = {} as Record<ContentItem['status'], number>;
    for (const row of rows) counts[row.status] = row._count._all;
    return counts;
  }

  async getItem(
    itemId: string,
    /**
     * The caller's membership BrandScope. Empty or absent is UNRESTRICTED.
     *
     * A PREDICATE, NOT AN AFTERTHOUGHT (D-132). The composer used to fetch the
     * item and then compare `item.brandId` against the scope in JavaScript.
     * The outcome was the same — a 404 either way — but the row was read
     * first, so the check lived in a caller that could forget it, and every
     * future caller had to remember. Refusing in the `where` means a draft
     * outside the member's brands is NOT FOUND to the database, which is the
     * same answer a draft that never existed gives.
     */
    brandScope?: readonly string[] | null | undefined,
  ): Promise<ContentItem & { variants: ContentVariant[] }> {
    const item = await this.db.contentItem.findFirst({
      where: {
        id: itemId,
        ...brandIdQueryFilter({ brandScope }),
      },
      include: { variants: { orderBy: { platformKey: 'asc' } } },
    });
    if (!item || item.deletedAt) throw contentItemNotFound();
    return item;
  }

  /**
   * Save a customer's own edit. No gateway, no credits — they wrote it.
   *
   * PHASE 8 — MEDIA TRAVELS WITH THE EDIT (AC-27.3). `assetIds` is OPTIONAL and
   * the distinction matters: ABSENT leaves the variant's media exactly as it
   * was, and an EMPTY ARRAY clears it. A caller that meant "do not touch the
   * media" and a caller that meant "remove the media" are different callers,
   * and a single `?? []` would have silently turned the first into the second
   * every time a caption was saved (D-184).
   *
   * Every id goes through `ContentMediaResolver`, which is the only place the
   * tenant boundary for `assetIds` exists — the column is a uuid array and
   * cannot carry a composite foreign key.
   */
  async editVariant(input: {
    variantId: string;
    body: string;
    hashtags?: readonly string[];
    firstComment?: string | null;
    assetIds?: readonly string[] | undefined;
    actorUserId: string;
    actorBrandScope: readonly string[];
  }): Promise<ContentVariant> {
    // D-132: the scope is a predicate, so an out-of-scope variant is never
    // retrieved. Empty scope remains unrestricted; the refusal is the same
    // not-found a genuine miss gives.
    const variant = await this.db.contentVariant.findFirst({
      where: { id: input.variantId, ...brandIdQueryFilter({ brandScope: input.actorBrandScope }) },
    });
    if (!variant) throw contentItemNotFound();

    const platform = findPlatform(this.policy, variant.platformKey);
    if (!platform) throw unsupportedPlatform();

    const validation = validateVariant(platform, {
      body: input.body,
      ...(input.hashtags ? { hashtags: input.hashtags } : {}),
      firstComment: input.firstComment ?? null,
    });

    /*
     * RESOLVED BEFORE THE WRITE, so an inadmissible asset refuses the whole
     * edit rather than saving the caption and dropping the picture. A partial
     * save is the shape of bug that makes somebody publish a post they did not
     * review.
     */
    const media =
      input.assetIds === undefined
        ? undefined
        : await new ContentMediaResolver({
            db: this.db,
            workspaceId: this.workspaceId,
          }).resolveForPlatform({
            assetIds: input.assetIds,
            brandId: variant.brandId,
            brandScope: input.actorBrandScope,
            platformKey: variant.platformKey,
            policy: this.policy,
          });

    const updated = await this.db.contentVariant.update({
      where: { id: variant.id },
      data: {
        body: input.body,
        ...(media === undefined ? {} : { assetIds: media.map((asset) => asset.id) }),
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
      after: {
        characterCount: validation.characterCount,
        validationState: validation.state,
        ...(media === undefined ? {} : { mediaCount: media.length }),
      },
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
    // D-132, as in `editVariant` above.
    const item = await this.db.contentItem.findFirst({
      where: { id: input.itemId, ...brandIdQueryFilter({ brandScope: input.actorBrandScope }) },
    });
    if (!item || item.deletedAt) throw contentItemNotFound();

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

  /**
   * THE CONTENT ITEM AN EXTERNAL ACTION MAY ACT ON — or a 404 (P7-R3).
   *
   * WHAT IT REPLACES. Both publish ports — the Copilot's and the confirmed
   * automation's — built a calendar with `actorBrandScope: []` under a comment
   * saying the caller had already been authorized. Empty means UNRESTRICTED on
   * this platform, so that literal did not "re-check anyway": it turned the
   * calendar's own brand check OFF, on the single action in the product that
   * leaves the platform and cannot be undone.
   *
   * AND NOTHING BOUND THE TWO IDS. A confirmed step carried a `brandId` the
   * caller was allowed and a `contentItemId` that could belong to a different
   * brand, and no code anywhere compared them. Here both are predicates:
   *
   *   - the item's own `brandId` must equal the brand the step named, and
   *   - that brand must be inside the caller's LIVE BrandScope,
   *
   * intersected by `brandIdQueryFilter` so neither can replace the other.
   *
   * IT IS MEANT TO BE CALLED FIRST. A refusal here happens before a slot, a
   * publish job, a queue entry or a provider request exists — there is nothing
   * half-done to unwind, which is the only acceptable shape for a fail-closed
   * check on an irreversible action.
   */
  async requireItemForBrand(input: {
    contentItemId: string;
    brandId: string;
    /** The caller's LIVE BrandScope. Empty is unrestricted (Phase 2B rule). */
    brandScope: readonly string[];
  }): Promise<ContentItem> {
    const item = await this.db.contentItem.findFirst({
      where: {
        id: input.contentItemId,
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
      },
    });
    // OUT OF SCOPE, ANOTHER BRAND'S, AND NEVER EXISTED ARE ONE ANSWER.
    if (!item) throw contentItemNotFound();
    return item;
  }

  /**
   * ARCHIVE A DRAFT AS A COMPENSATION — the content domain's own answer to
   * "put that back", rather than each caller writing its own UPDATE.
   *
   * IT EXISTS BECAUSE THE COPILOT'S UNDO WAS WRITING RAW PRISMA (P7-R4). It read
   * `{ id, workspaceId }` and updated `{ id }`, with no BrandScope anywhere —
   * so a member whose scope was narrowed AFTER the plan ran could still reach
   * back through the undo button and archive content they were no longer
   * allowed to see. An undo is a mutation and is authorized like one; putting
   * the mutation here is what stops the next compensation forgetting.
   *
   * THE SCOPE IS A PREDICATE ON BOTH STATEMENTS (D-132). The read finds nothing
   * out of scope, and the write is a CONDITIONAL `updateMany` carrying the same
   * predicate plus the required status — so even if the row changed between the
   * two, the update affects zero rows rather than archiving something that had
   * meanwhile been approved.
   *
   * IT RETURNS AN OUTCOME RATHER THAN THROWING. A compensation that cannot be
   * applied is a refusal with a reason the customer is shown, not an error that
   * abandons the other steps of the same undo.
   */
  async archiveItem(input: {
    contentItemId: string;
    /** The brand the plan ran against, when it had one. Binds item to plan. */
    brandId?: string | null | undefined;
    /** The caller's LIVE BrandScope. Empty is unrestricted (Phase 2B rule). */
    brandScope?: readonly string[] | null | undefined;
    actorUserId: string;
    /** Statuses from which archiving is still an undo rather than a change. */
    requireStatusIn: readonly string[];
    reason: string;
    now: Date;
  }): Promise<{ outcome: 'ARCHIVED' | 'ALREADY_ARCHIVED' | 'NOT_FOUND' | 'STATUS_CHANGED' }> {
    const scoped = brandIdQueryFilter({
      brandId: input.brandId ?? undefined,
      brandScope: input.brandScope,
    });

    const item = await this.db.contentItem.findFirst({
      where: { id: input.contentItemId, ...scoped },
      select: { id: true, status: true, brandId: true, deletedAt: true },
    });
    // OUT OF SCOPE AND NEVER EXISTED ARE THE SAME ANSWER, as everywhere else.
    if (!item) return { outcome: 'NOT_FOUND' };
    if (item.deletedAt) return { outcome: 'ALREADY_ARCHIVED' };
    if (!input.requireStatusIn.includes(item.status)) return { outcome: 'STATUS_CHANGED' };

    /*
     * THE EXACT STATUS THAT WAS OBSERVED, not the allowed set — a tighter
     * precondition than the one that was asked for, and free. If anything moved
     * the row between the read and this write, the update affects zero rows.
     */
    const affected = await this.db.contentItem.updateMany({
      where: { id: input.contentItemId, deletedAt: null, status: item.status, ...scoped },
      data: { status: 'ARCHIVED', deletedAt: input.now },
    });
    // SOMEBODY MOVED IT BETWEEN THE READ AND THE WRITE.
    if (affected.count === 0) return { outcome: 'STATUS_CHANGED' };

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'content.archived',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'ContentItem',
      resourceId: input.contentItemId,
      brandId: item.brandId,
      reason: input.reason,
      before: { status: item.status },
      after: { status: 'ARCHIVED' },
    });
    return { outcome: 'ARCHIVED' };
  }
}
