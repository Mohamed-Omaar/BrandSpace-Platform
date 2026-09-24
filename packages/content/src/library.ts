import { randomUUID } from 'node:crypto';
import type { Prisma } from '@brandspace/database';
import {
  writeAuditEvent,
  type ContentItem,
  type ContentVariant,
  type TenantScopedClient,
} from '@brandspace/database';
import { AppError, brandIdQueryFilter } from '@brandspace/shared';
import {
  contentItemNotFound,
  draftLimitReached,
  transitionNotAllowed,
  unsupportedPlatform,
} from './errors';
import { findPlatform, resolveDialect, type ContentDialect, type ContentPolicy } from './policy';
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
     * SEVERAL STATUSES, when one is not the question being asked.
     *
     * The Calendar's picker needs "everything a slot could be created from",
     * which the scheduling service defines as DRAFT or APPROVED — a single
     * status cannot express it, and filtering a page AFTER the database
     * truncated it would filter a list that had already lost rows.
     *
     * Ignored when `status` is given: one predicate, never two.
     */
    statuses?: readonly ContentItem['status'][] | undefined;
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
    /**
     * PHASE 6 FINAL (D-277 §15) — the library's format, platform and language
     * filters. In the query, for the same reason as every filter above: a page
     * the database already truncated cannot be filtered honestly afterwards.
     */
    contentType?: ContentItem['contentType'] | undefined;
    /** Items with at least one variant for this platform. */
    platformKey?: string | undefined;
    locale?: ContentItem['primaryLocale'] | undefined;
    search?: string | undefined;
    limit?: number | undefined;
  }): Promise<(ContentItem & { variants: ContentVariant[] })[]> {
    return this.db.contentItem.findMany({
      where: {
        deletedAt: null,
        // INTERSECTS rather than overwrites — see `brandIdQueryFilter`.
        ...brandIdQueryFilter({ brandId: input.brandId, brandScope: input.brandScope }),
        ...(input.status
          ? { status: input.status }
          : input.statuses && input.statuses.length > 0
            ? { status: { in: [...input.statuses] } }
            : {}),
        ...(input.campaignId ? { campaignId: input.campaignId } : {}),
        ...(input.contentType ? { contentType: input.contentType } : {}),
        ...(input.locale ? { primaryLocale: input.locale } : {}),
        ...(input.platformKey ? { variants: { some: { platformKey: input.platformKey } } } : {}),
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
  /**
   * CREATE A POST BY WRITING IT — the path that does not involve a model.
   *
   * WHY THIS EXISTS. Until now `ContentStudioService.generate()` was the ONLY
   * writer of a `ContentItem` anywhere in the product: one `contentItem.create`
   * in the whole repository, inside the generation path, behind an AI provider.
   * A customer with no AI provider configured — or one who simply wants to type
   * their own caption — could not create a single piece of content, and every
   * module downstream of a content item (the calendar, approvals, publishing,
   * campaign performance) was therefore unreachable too. A product whose only
   * way in is a model is not a social media tool with AI in it; it is an AI demo.
   *
   * IT LIVES HERE, IN THE CLASS WITH NO GATEWAY, and that is the whole point of
   * the split described at the top of this file. The dashboard cannot construct
   * a gateway (F-07), so a manual authoring path that lived on the studio class
   * would be a path the dashboard could not call. Being unable to reach a model
   * from here is what makes "this charges no credits" a fact about the type
   * rather than a promise in a comment.
   *
   * EVERYTHING ELSE IS THE SAME CONTENT. Same item, same variants, same
   * validation against the activated platform policy, same draft ceiling, same
   * retention resolution, same brand scope. `origin` is HUMAN and `aiRequestId`
   * is null, so provenance stays honest in both directions (D-65) — a customer
   * is entitled to know whether a model wrote the words, and that answer must be
   * "no" here without anyone having to check a flag.
   */
  /*
   * THE GUARDS THE AUTHORING PATHS SHARE.
   *
   * `protected` and on the base class, not duplicated on the subclass, for the
   * reason the class comment gives about the constructor fields: two copies of
   * one rule is how the two copies end up disagreeing. Manual authoring and
   * generation must answer "is this platform supported?" and "has this brand
   * room for another draft?" identically, or the ceiling becomes a function of
   * which button the customer pressed.
   */
  protected assertPlatforms(keys: readonly string[]) {
    if (keys.length === 0 || keys.length > this.policy.generation.maxVariantsPerRequest) {
      throw unsupportedPlatform();
    }
    return keys.map((key) => {
      const platform = findPlatform(this.policy, key);
      if (!platform) throw unsupportedPlatform();
      return platform;
    });
  }

  protected async assertDraftHeadroom(brandId: string): Promise<void> {
    const live = await this.db.contentItem.count({
      where: { brandId, deletedAt: null, status: { notIn: ['ARCHIVED'] } },
    });
    if (live >= this.policy.generation.maxDraftsPerBrand) throw draftLimitReached();
  }

  /**
   * D-115, resolved per authored item.
   *
   * Reads the brand and its workspace rather than trusting a caller-supplied
   * dialect: a dialect that arrived in a request body would be a customer
   * choosing per-request what their brand sounds like, which is not what the
   * decision approved.
   */
  protected async resolveDialectFor(brandId: string): Promise<ContentDialect> {
    const brand = await this.db.brand.findUnique({
      where: { id: brandId },
      select: { arabicDialect: true, workspace: { select: { arabicDialect: true } } },
    });
    return resolveDialect(this.policy, {
      brandDialect: brand?.arabicDialect ?? null,
      workspaceDialect: brand?.workspace.arabicDialect ?? null,
    });
  }

  /**
   * The brand must be inside the member's scope before anything is written.
   *
   * NOT `brandIdQueryFilter`, because that helper narrows a `brandId` COLUMN and
   * the brand table's own key is `id`. Written out rather than bent: an empty
   * scope is unrestricted (D-132), and the refusal is the same not-found a
   * genuine miss gives, so a scoped member cannot learn which brands exist by
   * the shape of the error.
   */
  protected async requireItemForBrandScope(
    brandId: string,
    brandScope: readonly string[],
  ): Promise<void> {
    const brand = await this.db.brand.findFirst({
      where: {
        id: brandId,
        deletedAt: null,
        // AND, NOT A SPREAD. Spreading a second `id` key would REPLACE the one
        // above, so a scoped member would have been checked against the scope
        // and not against the brand they actually named — which is the
        // opposite of the intended narrowing.
        ...(brandScope.length > 0 ? { AND: [{ id: { in: [...brandScope] } }] } : {}),
      },
      select: { id: true },
    });
    if (!brand) throw contentItemNotFound();
  }

  async createManualItem(input: {
    readonly brandId: string;
    readonly title: string;
    readonly contentType?: ContentItem['contentType'];
    readonly locale: ContentItem['primaryLocale'];
    /** One variant per platform key. Each must be in the activated policy. */
    readonly variants: readonly {
      readonly platformKey: string;
      readonly body: string;
      readonly hashtags?: readonly string[];
      readonly firstComment?: string | null;
      readonly linkUrl?: string | null;
      readonly assetIds?: readonly string[];
    }[];
    readonly campaignId?: string | null;
    readonly pillar?: string | null;
    readonly tags?: readonly string[];
    readonly actorUserId: string;
    readonly actorBrandScope: readonly string[];
    readonly expiresAt: Date | null;
    /**
     * Client idempotency key. A retried submit returns the first draft rather
     * than making a second, exactly as a replayed generation does — the unique
     * index on (workspaceId, brandId, createdByUserId, idempotencyKey) is the
     * arbiter, not a check-then-act in this method.
     */
    readonly idempotencyKey: string;
  }): Promise<{ item: ContentItem; variants: ContentVariant[]; replayed: boolean }> {
    await this.requireItemForBrandScope(input.brandId, input.actorBrandScope);

    const platforms = this.assertPlatforms(input.variants.map((variant) => variant.platformKey));
    if (new Set(input.variants.map((v) => v.platformKey)).size !== input.variants.length) {
      // One variant per platform per locale is a unique index; refusing here
      // names the mistake instead of surfacing a constraint violation.
      throw unsupportedPlatform();
    }

    const existing = await this.db.contentItem.findFirst({
      where: {
        brandId: input.brandId,
        createdByUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
      },
    });
    if (existing) {
      return {
        item: existing,
        variants: await this.db.contentVariant.findMany({
          where: { contentItemId: existing.id },
          orderBy: { createdAt: 'asc' },
        }),
        replayed: true,
      };
    }

    await this.assertDraftHeadroom(input.brandId);
    const dialect = await this.resolveDialectFor(input.brandId);

    /*
     * MEDIA IS RESOLVED BEFORE ANYTHING IS WRITTEN, for the reason `editVariant`
     * gives: an inadmissible asset must refuse the whole creation rather than
     * save the captions and drop the pictures. The resolver is also what proves
     * the asset ids belong to this workspace and this brand — `assetIds` is a
     * uuid array with no foreign key, so the service IS the tenant boundary.
     */
    const resolver = new ContentMediaResolver({ db: this.db, workspaceId: this.workspaceId });
    const resolvedMedia = new Map<string, string[]>();
    for (const variant of input.variants) {
      if (!variant.assetIds || variant.assetIds.length === 0) continue;
      const media = await resolver.resolveForPlatform({
        assetIds: variant.assetIds,
        brandId: input.brandId,
        brandScope: input.actorBrandScope,
        platformKey: variant.platformKey,
        policy: this.policy,
      });
      resolvedMedia.set(
        variant.platformKey,
        media.map((asset) => asset.id),
      );
    }

    const campaignId = await this.#resolveCampaign(input.campaignId ?? null, input.brandId);

    /*
     * THE DATABASE DECIDES WHO WON, AND IT NEVER RAISES TO DO IT.
     *
     * The read above closes a SEQUENTIAL retry and nothing more: two requests
     * carrying one idempotency key can both find no row, and then both insert.
     * `create` compiles to a plain `INSERT`, so the loser takes a P2002 — and
     * that is not a recoverable error HERE, because `withWorkspace` runs this
     * whole callback inside ONE PostgreSQL transaction. A constraint violation
     * aborts that transaction, so the obvious repair — catch the P2002, read
     * the winner's row, return it as a replay — issues its read on a
     * transaction PostgreSQL has already poisoned and fails with
     * `current transaction is aborted`. Catch-and-re-read is correct only
     * across transactions, which is not where this code runs.
     *
     * `createMany({ skipDuplicates: true })` compiles to
     * `INSERT ... ON CONFLICT DO NOTHING`, which does not raise and does not
     * abort anything. The loser's statement BLOCKS on the winner's speculative
     * insertion lock, waits for that transaction to commit, and then reports
     * zero rows — so `count === 0` is PROOF that somebody else created this
     * item, decided by PostgreSQL rather than by timing. If the winner rolls
     * back instead, the insert simply succeeds, so a crash mid-flight does not
     * leave the key unusable. The same reasoning and the same arbiter as
     * `recordAutomationEvent` in `@brandspace/database`.
     *
     * The id is generated HERE rather than by the default, so the winner knows
     * its own row without a second read — and the loser re-reads by the unique
     * key, which is the only handle it has.
     */
    const candidateId = randomUUID();
    const created = await this.db.contentItem.createMany({
      data: [
        {
          id: candidateId,
          workspaceId: this.workspaceId,
          brandId: input.brandId,
          title:
            input.title.trim().slice(0, 200) || input.variants[0]?.body.slice(0, 120) || 'Untitled',
          contentType: input.contentType ?? 'POST',
          primaryLocale: input.locale,
          status: 'DRAFT',
          // HUMAN, and no `aiRequestId`. Nothing on this path can set either
          // differently, which is what makes the zero-credit claim checkable.
          origin: 'HUMAN',
          createdByUserId: input.actorUserId,
          ...(campaignId ? { campaignId } : {}),
          ...(input.pillar ? { pillar: input.pillar } : {}),
          ...(input.tags && input.tags.length > 0 ? { tags: [...input.tags] } : {}),
          arabicDialect: input.locale === 'AR' ? dialect.key : null,
          idempotencyKey: input.idempotencyKey,
          expiresAt: input.expiresAt,
        },
      ],
      skipDuplicates: true,
    });

    if (created.count === 0) {
      /*
       * WE LOST, AND THE WINNER HAS COMMITTED — the insert above waited for it.
       * So its variants are visible too: `withWorkspace` commits the item and
       * its variants together, and there is no window in which one is readable
       * without the other. This caller writes NOTHING: no variant, no audit
       * event, no second row. It is a replay, and it says so.
       */
      const winner = await this.db.contentItem.findFirst({
        where: {
          brandId: input.brandId,
          createdByUserId: input.actorUserId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      /* c8 ignore next -- the conflict we lost to is the row we just looked up. */
      if (!winner) throw contentItemNotFound();
      return {
        item: winner,
        variants: await this.db.contentVariant.findMany({
          where: { contentItemId: winner.id },
          orderBy: { createdAt: 'asc' },
        }),
        replayed: true,
      };
    }

    const item = await this.db.contentItem.findUniqueOrThrow({ where: { id: candidateId } });

    const written: ContentVariant[] = [];
    for (const [index, variant] of input.variants.entries()) {
      const platform = platforms[index];
      /* c8 ignore next -- assertPlatforms threw for anything unresolvable. */
      if (!platform) continue;
      const validation = validateVariant(platform, {
        body: variant.body,
        ...(variant.hashtags ? { hashtags: variant.hashtags } : {}),
        firstComment: variant.firstComment ?? null,
      });
      written.push(
        await this.db.contentVariant.create({
          data: {
            workspaceId: this.workspaceId,
            brandId: input.brandId,
            contentItemId: item.id,
            platformKey: variant.platformKey,
            locale: input.locale,
            body: variant.body,
            hashtags: variant.hashtags ? [...variant.hashtags] : [],
            firstComment: variant.firstComment ?? null,
            linkUrl: variant.linkUrl ?? null,
            assetIds: resolvedMedia.get(variant.platformKey) ?? [],
            characterCount: validation.characterCount,
            validationState: validation.state,
            ...(validation.errors.length > 0
              ? { validationErrors: validation.errors as unknown as Prisma.InputJsonValue }
              : {}),
            origin: 'HUMAN',
            arabicDialect: input.locale === 'AR' ? dialect.key : null,
            expiresAt: input.expiresAt,
          },
        }),
      );
    }

    await writeAuditEvent(this.db, this.workspaceId, {
      action: 'content.item.authored',
      actorType: 'USER',
      actorId: input.actorUserId,
      resourceType: 'ContentItem',
      resourceId: item.id,
      brandId: item.brandId,
      after: {
        origin: 'HUMAN',
        variants: written.length,
        platformKeys: input.variants.map((v) => v.platformKey),
      },
    });

    return { item, variants: written, replayed: false };
  }

  /**
   * Resolve a campaign id through the tenant-scoped client, or refuse it.
   *
   * `campaignId` reaches this service from a form, so it is exactly the field a
   * hand-built post would put another workspace's id in. Reading it back under
   * RLS is what makes a foreign id a not-found rather than a link.
   */
  async #resolveCampaign(campaignId: string | null, brandId: string): Promise<string | null> {
    if (!campaignId) return null;
    const campaign = await this.db.campaign.findFirst({
      where: { id: campaignId, brandId },
      select: { id: true },
    });
    if (!campaign) throw contentItemNotFound();
    return campaign.id;
  }

  async editVariant(input: {
    variantId: string;
    body: string;
    hashtags?: readonly string[];
    firstComment?: string | null;
    assetIds?: readonly string[] | undefined;
    /**
     * PHASE 6 FINAL (D-285) — the cover image. Undefined leaves it; null clears
     * it; an id must be an IMAGE this variant's brand may use, READY and CLEAN.
     */
    coverAssetId?: string | null | undefined;
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

    /*
     * ABSENT MEANS "LEAVE IT" (Phase 6 final, D-284). A form that has no first
     * comment field — every platform that does not take one — used to save
     * `null` over whatever was stored. Only an explicit value, empty included,
     * changes it now.
     */
    const firstComment =
      input.firstComment === undefined ? variant.firstComment : input.firstComment || null;
    const validation = validateVariant(platform, {
      body: input.body,
      ...(input.hashtags ? { hashtags: input.hashtags } : {}),
      firstComment,
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

    let cover: string | null | undefined;
    if (input.coverAssetId === undefined || input.coverAssetId === null) {
      cover = input.coverAssetId;
    } else {
      const [resolved] = await new ContentMediaResolver({
        db: this.db,
        workspaceId: this.workspaceId,
      }).resolve({
        assetIds: [input.coverAssetId],
        brandId: variant.brandId,
        brandScope: input.actorBrandScope,
      });
      if (!resolved || resolved.kind !== 'IMAGE') {
        throw new AppError('VALIDATION_FAILED', 'A cover must be an image.');
      }
      cover = resolved.id;
    }

    const updated = await this.db.contentVariant.update({
      where: { id: variant.id },
      data: {
        body: input.body,
        ...(cover === undefined ? {} : { coverAssetId: cover }),
        ...(media === undefined ? {} : { assetIds: media.map((asset) => asset.id) }),
        ...(input.hashtags ? { hashtags: [...input.hashtags] } : {}),
        firstComment,
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
        ...(cover === undefined ? {} : { cover: cover === null ? 'cleared' : 'set' }),
      },
    });

    /*
     * PHASE 5B-3 — AN EDIT REVOKES AN APPROVAL.
     *
     * An approval is a judgement about a particular post. Once that post
     * changes, the record still says "approved" while nobody has read what it
     * now approves — and with the calendar gate on, that difference is the
     * whole control. So an edit to an APPROVED item returns it to DRAFT,
     * audibly.
     *
     * PHASE 8 MADE THAT SENTENCE WIDER WITHOUT CHANGING A LINE OF IT. A post
     * is now words AND pictures, and this runs on every edit — so swapping the
     * image on an approved post revokes the approval exactly as rewriting the
     * caption does. A reviewer who approved one photograph must not find a
     * different one published under their verdict.
     *
     * A SCHEDULED item is not touched here, and cannot be: `transition()`
     * refuses to move it and the calendar owns that edge. Editing the caption of
     * something already planned is a Phase 6 question — there is a slot pointing
     * at it — and this phase does not answer it by silently unscheduling.
     */
    await this.revokeApprovalOnEdit(input.actorUserId, variant.contentItemId, variant.brandId);
    return updated;
  }

  /**
   * See `editVariant`. Separate so the reason has somewhere to live, and
   * PROTECTED so the studio's AI edits obey the same rule (D-284): a caption an
   * inline tool rewrote is as changed as one a person retyped.
   */
  protected async revokeApprovalOnEdit(
    actorUserId: string,
    contentItemId: string,
    brandId: string,
  ): Promise<void> {
    const item = await this.db.contentItem.findUnique({
      where: { id: contentItemId },
      select: { id: true, status: true },
    });
    if (!item) return;

    /*
     * A SCHEDULED ITEM IS RECORDED, NOT MOVED (D-223).
     *
     * The comment above says why this handler does not unschedule: the calendar
     * owns that edge, and silently cancelling somebody's plan from inside an
     * edit is a worse surprise than the one being prevented. What was missing
     * is that it also said nothing — so a caption edited after scheduling left
     * no trace, and the mismatch surfaced only when the publish failed.
     *
     * The fingerprint on the approval is what actually stops the send. This
     * event is what makes it legible beforehand, at WARNING rather than NOTICE
     * because a scheduled post that will now refuse to publish is something
     * somebody has to act on.
     */
    if (item.status === 'SCHEDULED') {
      await writeAuditEvent(this.db, this.workspaceId, {
        action: 'content.scheduled_item_edited',
        actorType: 'USER',
        actorId: actorUserId,
        resourceType: 'ContentItem',
        resourceId: item.id,
        brandId,
        severity: 'WARNING',
        reason: 'edited_after_scheduling',
        after: { status: 'SCHEDULED', approvalStillCovers: false },
      });
      return;
    }

    if (item.status !== 'APPROVED') return;
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
