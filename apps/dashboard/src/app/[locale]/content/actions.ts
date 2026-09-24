'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { writeAuditEvent } from '@brandspace/database';
import { AppError, createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { readRetentionFacts, resolveContentExpiry } from '@brandspace/content';
import { systemClock } from '@brandspace/shared';
import { parseContentType } from './content-types';
import { requireWorkspace, type WorkspaceSession } from '../../../server/customer-context';
import { inContentStudio } from '../../../server/content-context';
import { inNotes } from '../../../server/notes-context';
import { resolveContentLanguage } from '../../../server/content-language';
import { uploadIntoLibrary } from '../../../server/asset-upload';
import { translator } from '../../../i18n/messages';

const log = createLogger({ context: { component: 'dashboard.content' } });

/**
 * Content Studio actions — the half that never calls a model.
 *
 * THE WORKSPACE IS NEVER TAKEN FROM THE FORM. `requireWorkspace()` reads it from
 * the session and re-verifies membership, so a crafted POST carrying another
 * tenant's ids operates on the caller's own workspace. The draft and variant ids
 * ARE taken from the form — the customer chooses them — and RLS, the composite
 * foreign keys and the service's own brand-scope check are what make a foreign
 * one fail rather than succeed quietly.
 *
 * EACH ACTION NAMES THE PERMISSION IT NEEDS, TWICE: `requireWorkspace` refuses
 * the request and the service refuses the call. The page also hides the control,
 * and hiding is a courtesy — a server action is a public HTTP endpoint.
 *
 * GENERATION IS NOT HERE. It needs the AI Gateway, the gateway needs the
 * platform database identity, and F-07 keeps that out of this app. The browser
 * posts to `/api/content/generate`, which proxies to `apps/api`.
 */

function pageUrl(locale: string, path: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/content${path}${search ? `?${search}` : ''}`;
}

function failure(
  locale: string,
  error: unknown,
  action: string,
  path: string,
  extra: Record<string, string> = {},
): string {
  const correlationId = randomUUID();
  // The correlation id is the ONLY thing joining this screen to the server log,
  // and the log is redacted. NO CAPTION TEXT and no brief is written either
  // side — a draft caption is routinely the most commercially sensitive string
  // in the record (docs/SECURITY.md §11).
  log.warn('content action failed', { correlationId, action, ...internalErrorFields(error) });
  return pageUrl(locale, path, { ...extra, error: toPublicErrorCode(error), ref: correlationId });
}

function actorOf(session: WorkspaceSession) {
  return {
    actorUserId: session.customer.userId,
    actorBrandScope: session.workspace.brandScope,
  };
}

/**
 * The approvals actor, built from the SESSION and nothing else.
 *
 * The permission keys travel with it because the service decides authority
 * from them, never from the form. The role key travels too: it no longer
 * affects approval authority (D-62 removed that channel), but the actor is the
 * session's identity and the audit trail records who acted as what.
 */
function approvalActorOf(session: WorkspaceSession) {
  return {
    userId: session.customer.userId,
    roleKey: session.workspace.roleKey,
    permissionKeys: session.workspace.permissionKeys,
    brandScope: session.workspace.brandScope,
  };
}

/**
 * THE PERMISSION THAT LETS CONTENT BE FILED UNDER A CAMPAIGN.
 *
 * `setContentCampaignAction` has required `campaigns.manage` since Phase 8, so
 * that is the EXISTING contract for associating a content item with a campaign
 * and manual creation aligns with it rather than inventing a second rule. The
 * alternative reading — that `campaigns.read` should be enough, because filing
 * a post does not edit the campaign — is a real product question, and changing
 * it here would silently widen RBAC for a path nobody reviewed: `campaigns.read`
 * is held by three more roles than `campaigns.manage`, so it would hand
 * `content_creator`, `approver` and `analyst` an authority the screen that
 * already does this refuses them.
 *
 * A NAMED CONSTANT, so the UI gate, the create path and the option list cannot
 * drift apart — the defect this correction exists for was exactly that kind of
 * gap between a control and its server check.
 */
const CAMPAIGN_ASSOCIATION_PERMISSION = 'campaigns.manage';

/**
 * The campaigns a NEW post could be filed under, for one brand.
 *
 * WHY A SERVER ACTION AND NOT A PROP. The compose page renders the options for
 * the brand the rail has selected — and with the rail on "All brands" there is
 * no such brand, so the composer shows its own brand selector instead. Choosing
 * a brand there is client state, and the server had already decided what the
 * campaign list was: the customer picked Brand A and Brand A's campaigns were
 * still unavailable, which made the feature true only for the narrower half of
 * the workflow.
 *
 * ONE BRAND'S CAMPAIGNS, ASKED FOR WHEN THAT BRAND IS CHOSEN. The alternative —
 * shipping every brand's campaigns to the browser and filtering there — would
 * put another brand's campaign names in the page for the sake of a dropdown,
 * which is the thing the existing draft path is careful never to do.
 *
 * IT IS A READ AND IT IS STILL GUARDED. Campaign names are tenant data, and the
 * permission asked for here is the same one that authorizes the association
 * itself, so a caller who could not use an option is never shown one.
 * `assertBrandInScope` inside `list` refuses a brand outside the member's
 * BrandScope, and `brandIdQueryFilter` makes that a predicate rather than a
 * filter applied afterwards (D-132).
 */
export async function listCampaignOptionsAction(
  locale: string,
  brandId: string,
): Promise<readonly { id: string; name: string }[]> {
  if (brandId.trim() === '') return [];
  const session = await requireWorkspace(locale, CAMPAIGN_ASSOCIATION_PERMISSION);
  const campaigns = await inContentStudio(session.workspace.workspaceId, async (services) =>
    services.campaigns().list({
      brandId,
      brandScope: session.workspace.brandScope,
      take: 100,
    }),
  );
  return campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name }));
}

/**
 * WRITE A POST YOURSELF — the authoring path that never involves a model.
 *
 * WHY THIS ACTION EXISTS AT ALL. `ContentStudioService.generate()` was the only
 * writer of a content item anywhere in the product, and it lives behind the AI
 * Gateway in `apps/api` because F-07 keeps the platform database identity out of
 * this app. So a workspace with no AI provider configured could not create a
 * single piece of content — and with no content item there is no calendar slot,
 * no approval, no publish job and no campaign performance. The whole customer
 * product was downstream of one `contentItem.create` behind a provider.
 *
 * IT IS A SERVER ACTION RATHER THAN A PROXY TO `apps/api`, and that is the
 * point: nothing here needs a gateway, so nothing here should have to reach the
 * service that has one. `ContentLibraryService` is the class the dashboard can
 * construct, and it is the class that cannot charge a credit — the zero-credit
 * property of manual authoring is enforced by the type, not by a promise.
 *
 * `content.create` RATHER THAN `content.edit`. Creating a draft and editing an
 * existing one are different authorities; a member who may revise a caption is
 * not thereby a member who may add to the brand's library.
 */
export async function createManualDraftAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'content.create');
    const brandId = String(formData.get('brandId') ?? '');
    const title = String(formData.get('title') ?? '');
    const explicitLanguage = formData.get('contentLocale');
    /*
     * THE TYPE THE COMPOSER ALREADY ASKED FOR (PHASE 2 correction).
     *
     * The selector has been on the screen since Phase 5B-2 and the service has
     * always taken a `contentType`, but this action did not read one — so a
     * person who chose REEL and wrote the caption themselves got a POST, and
     * every ceiling derived from the type was the wrong ceiling. Parsed against
     * the list the selector was rendered from rather than trusted; a value that
     * list does not carry is not passed on and the service's own default stands.
     */
    const contentType = parseContentType(formData.get('contentType'));
    const body = String(formData.get('body') ?? '');
    const platformKeys = formData.getAll('platformKeys').map((value) => String(value));
    const campaignId = String(formData.get('campaignId') ?? '') || null;
    /*
     * FILING A NEW POST UNDER A CAMPAIGN NEEDS THE SAME AUTHORITY AS REFILING
     * AN EXISTING ONE.
     *
     * `content.create` alone reached this action, and it accepted a
     * `campaignId` — so a member who may write a draft but not manage campaigns
     * could establish an association that `setContentCampaignAction` would then
     * refuse to CHANGE. A right to create a link that cannot be edited is a
     * worse grant than either half of it, and it was reachable by a crafted
     * POST whether or not the selector was on the screen.
     *
     * CHECKED ONLY WHEN THERE IS A CAMPAIGN. A member without the permission
     * keeps the whole authoring path; they simply cannot file the post, which
     * is exactly the authority they hold elsewhere.
     *
     * SHAPED LIKE A MISS, AND THROWN AS A TYPED ERROR rather than `notFound()`.
     * An unauthorized association must not announce that a campaign by that id
     * exists, which is why the code is `NOT_FOUND` — the same refusal
     * `#resolveCampaign` gives for a campaign in another brand. It is thrown as
     * an `AppError` because this action's `catch` maps a typed error to a public
     * code the screen can name; `notFound()` throws a framework control-flow
     * error that the same `catch` would swallow into "something went wrong",
     * which tells the customer nothing and tells a reader of the log less.
     */
    if (
      campaignId !== null &&
      !session.workspace.permissionKeys.includes(CAMPAIGN_ASSOCIATION_PERMISSION)
    ) {
      throw new AppError('NOT_FOUND', 'Campaign not found.');
    }
    const hashtags = String(formData.get('hashtags') ?? '')
      .split(/[\s,]+/)
      .map((tag) => tag.replace(/^#/, '').trim())
      .filter((tag) => tag.length > 0);
    const assetIds = formData.getAll('assetIds').map((value) => String(value));
    /*
     * THE KEY COMES FROM THE FORM, exactly as the generation path's does. A
     * double submit — the browser's, or a customer's impatient second click —
     * must return the first draft rather than make a second, and the unique
     * index is what decides that rather than a check in this handler.
     */
    const idempotencyKey = String(formData.get('idempotencyKey') ?? '') || randomUUID();

    const itemId = await inContentStudio(session.workspace.workspaceId, async (services) => {
      const [library, policy] = await Promise.all([services.library(), services.policy()]);
      const facts = await readRetentionFacts(services.db, session.workspace.workspaceId);
      // Explicit choice, then the brand's own preference, then English (D-277).
      const brand = await services.db.brand.findFirst({
        where: { id: brandId, workspaceId: session.workspace.workspaceId },
        select: { defaultLocale: true },
      });
      const created = await library.createManualItem({
        brandId,
        title,
        locale: resolveContentLanguage(explicitLanguage, brand?.defaultLocale),
        ...(contentType ? { contentType } : {}),
        variants: platformKeys.map((platformKey) => ({
          platformKey,
          body,
          hashtags,
          ...(assetIds.length > 0 ? { assetIds } : {}),
        })),
        campaignId,
        idempotencyKey,
        expiresAt: resolveContentExpiry(policy, facts, systemClock),
        ...actorOf(session),
      });
      return created.item.id;
    });

    destination = pageUrl(locale, '/compose', {
      item: itemId,
      ok: 'SAVED',
      ...attachParam(formData),
    });
  } catch (error: unknown) {
    destination = failure(locale, error, 'createManualDraft', '/compose');
  }
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}

/**
 * PHASE 6 FINAL (D-285) — AN IMAGE CARRIED FROM THE CREATIVE STUDIO.
 *
 * Only ever an id to OFFER on the new draft: the draft editor puts it on the
 * slides, unsaved, and the ordinary save resolves it against the brand and the
 * platform like any other media. Nothing is attached by this parameter alone.
 */
function attachParam(formData: FormData): { attach?: string } {
  const value = String(formData.get('attach') ?? '');
  return /^[0-9a-f-]{36}$/i.test(value) ? { attach: value } : {};
}

/** Save a person's own edit to a caption. No gateway, no credits. */
export async function saveVariantAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const itemId = String(formData.get('itemId') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'content.edit');
    const variantId = String(formData.get('variantId') ?? '');
    const body = String(formData.get('body') ?? '');
    const hashtags = String(formData.get('hashtags') ?? '')
      .split(/[\s,]+/)
      .map((tag) => tag.replace(/^#/, '').trim())
      .filter((tag) => tag.length > 0);

    /*
     * PHASE 8 — MEDIA, AND THE DIFFERENCE BETWEEN "leave it" AND "remove it".
     *
     * `mediaPresent` is a hidden field the picker always submits. WITHOUT it
     * this submission is not about media and the variant's media is untouched;
     * WITH it, whatever `assetIds` arrived is the new list — including none,
     * which is how an author removes the last picture. Reading `getAll` alone
     * would make "I unchecked everything" and "this form has no picker"
     * indistinguishable, and the second would silently win (D-184).
     */
    const mediaPresent = formData.get('mediaPresent') !== null;
    const assetIds = mediaPresent
      ? formData.getAll('assetIds').map((value) => String(value))
      : undefined;

    const rawCover = formData.get('coverAssetId');
    const coverAssetId =
      rawCover === null
        ? undefined
        : String(rawCover).trim() === ''
          ? null
          : String(rawCover).trim();
    // Present only where the platform takes one; absent leaves it untouched.
    const rawComment = formData.get('firstComment');
    const firstComment =
      rawComment === null ? undefined : String(rawComment).trim().slice(0, 2_200);

    await inContentStudio(session.workspace.workspaceId, async ({ library }) =>
      (await library()).editVariant({
        variantId,
        body,
        hashtags,
        ...(firstComment === undefined ? {} : { firstComment }),
        // PHASE 6 FINAL (D-285) — present only where a cover can be chosen.
        ...(coverAssetId === undefined ? {} : { coverAssetId }),
        ...(assetIds === undefined ? {} : { assetIds }),
        ...actorOf(session),
      }),
    );
    destination = pageUrl(locale, '/compose', { item: itemId, ok: 'SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'saveVariant', '/compose', { item: itemId });
  }
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}

/**
 * PHASE 8 — FILE A DRAFT UNDER A CAMPAIGN, OR TAKE IT OUT OF ONE (AC-26.3).
 *
 * A SEPARATE ACTION FROM SAVING A VARIANT, because it is a different fact about
 * a different row: a campaign belongs to the ITEM, a caption to the variant, and
 * one form writing both would make "save this caption" quietly re-file the post.
 *
 * `campaigns.manage` RATHER THAN `content.edit`. Linking content to a campaign
 * changes what that campaign reports, so it is a campaign decision made from the
 * content screen — not a content decision. `CampaignService.setContentCampaign`
 * re-checks the member's BrandScope against BOTH the item and the campaign, so
 * neither half can be borrowed from another brand, and writes the audit event.
 *
 * AN EMPTY VALUE MEANS "no campaign", which is a real instruction and not a
 * missing field — the control always submits, and `''` unlinks.
 */
export async function setContentCampaignAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const itemId = String(formData.get('itemId') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'campaigns.manage');
    const raw = formData.get('campaignId');
    if (raw === null) notFound();
    const campaignId = String(raw).trim();

    await inContentStudio(session.workspace.workspaceId, async (services) =>
      services.campaigns().setContentCampaign({
        contentItemId: itemId,
        campaignId: campaignId === '' ? null : campaignId,
        actor: {
          userId: session.customer.userId,
          brandScope: session.workspace.brandScope,
        },
      }),
    );
    destination = pageUrl(locale, '/compose', {
      item: itemId,
      ok: 'CAMPAIGN_LINKED',
      ...attachParam(formData),
    });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    destination = failure(locale, error, 'setContentCampaign', '/compose', { item: itemId });
  }
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}

/**
 * UPLOADING A PICTURE WITHOUT LEAVING THE DRAFT — Phase 8 (AC-27.1).
 *
 * WHY IT IS HERE RATHER THAN A LINK TO THE ASSET LIBRARY. The composer offered
 * one, and a link is a different product: an author part-way through a caption
 * had to navigate away, find the upload control, choose a brand and a folder,
 * and come back to a page that had forgotten what they were doing. "Media can
 * be uploaded during content creation" is not satisfied by a way to leave.
 *
 * IT IS THE SAME LIBRARY, THROUGH THE SAME PATH. `uploadIntoLibrary` is the one
 * implementation the Asset Library screen uses — the same `assets.upload`
 * permission, the same actor carrying this member's BrandScope, the same
 * signature check, checksum key, quota and quarantine, and the same background
 * dispatch. NO SECOND LIBRARY AND NO SHORTCUT: the file lands as an ordinary
 * asset, PENDING its scan, and becomes selectable when the scanner clears it.
 *
 * THE BRAND IS THE DRAFT'S OWN, not a field on the form. A picture uploaded
 * while writing for one brand belongs to that brand, and letting a form name a
 * different one would be a brand chosen by a POST body.
 */
export async function uploadComposerMediaAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const itemId = String(formData.get('itemId') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'assets.upload');
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0)
      throw new AppError('VALIDATION_FAILED', 'No file.');

    /*
     * THE DRAFT SAYS WHICH BRAND. Read through the tenant-scoped client and the
     * member's own scope, so an item id from another brand is a miss rather
     * than a brand this upload would be filed under.
     */
    const item = await inContentStudio(session.workspace.workspaceId, async (services) => {
      const library = await services.library();
      return library.getItem(itemId, session.workspace.brandScope);
    });

    await uploadIntoLibrary({
      workspaceId: session.workspace.workspaceId,
      actor: {
        userId: session.customer.userId,
        permissionKeys: session.workspace.permissionKeys,
        brandScope: session.workspace.brandScope,
      },
      file,
      bytes: new Uint8Array(await file.arrayBuffer()),
      brandId: item.brandId,
      // The library's root. A composer that also asked for a folder would be
      // asking an author mid-sentence to file something.
      folderId: null,
    });

    destination = pageUrl(locale, '/compose', { item: itemId, ok: 'ASSET_UPLOADED' });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    destination = failure(locale, error, 'uploadComposerMedia', '/compose', { item: itemId });
  }
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}

/** Next.js signals `notFound()` and `redirect()` by throwing; this is that. */
function isRedirectError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string' &&
    ((error as { digest: string }).digest.startsWith('NEXT_REDIRECT') ||
      (error as { digest: string }).digest === 'NEXT_HTTP_ERROR_FALLBACK;404')
  );
}

/**
 * The direct moves: archive, and restore a draft.
 *
 * `IN_REVIEW` IS NO LONGER REACHABLE HERE (Phase 5B-3). Submitting for review
 * opens an `approval` row — a requester, a policy snapshot, a cycle — and a
 * status change with none of that behind it was an item in a queue nobody could
 * decide. `submitForReviewAction` below is the only way in, and
 * `cancelReviewAction` the only way back out.
 *
 * SCHEDULED and PUBLISHED belong to the Social Calendar and the publishing
 * pipeline; the service refuses them, and this action has no way to name one.
 */
export async function transitionItemAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const itemId = String(formData.get('itemId') ?? '');
  const raw = String(formData.get('to') ?? '');
  const to = raw === 'ARCHIVED' || raw === 'DRAFT' ? raw : null;

  let destination: string;
  try {
    if (!to) throw new Error('unsupported transition');
    const permission = to === 'ARCHIVED' ? 'content.archive' : 'content.edit';
    const session = await requireWorkspace(locale, permission);

    await inContentStudio(session.workspace.workspaceId, async ({ library }) =>
      (await library()).transition({ itemId, to, ...actorOf(session) }),
    );
    destination =
      to === 'ARCHIVED'
        ? pageUrl(locale, '', { ok: 'SAVED' })
        : pageUrl(locale, '/compose', { item: itemId, ok: 'SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'transitionItem', '/compose', { item: itemId });
  }
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}

/**
 * Phase 5B-3 — send content for review.
 *
 * The permission is checked TWICE, as everywhere in this file: once by
 * `requireWorkspace` before the work starts, and once by the service, which
 * re-reads the item and its brand scope. A server action is a public HTTP
 * endpoint, and the hidden button is a courtesy.
 */
export async function submitForReviewAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const itemId = String(formData.get('itemId') ?? '');
  const note = String(formData.get('note') ?? '');
  const assignedTo = String(formData.get('assignedToUserId') ?? '');
  const fromLibrary = formData.get('returnTo') === '/content';

  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'content.submit');
    await inContentStudio(session.workspace.workspaceId, async ({ approvals }) =>
      (await approvals()).submit({
        itemId,
        actor: approvalActorOf(session),
        assignedToUserId: assignedTo.length > 0 ? assignedTo : null,
        note,
      }),
    );
    // The library's quick action returns to the library (a closed set, D-282).
    destination = fromLibrary
      ? pageUrl(locale, '', { ok: 'SUBMITTED' })
      : pageUrl(locale, '/compose', { item: itemId, ok: 'SUBMITTED' });
  } catch (error: unknown) {
    destination = fromLibrary
      ? failure(locale, error, 'submitForReview', '')
      : failure(locale, error, 'submitForReview', '/compose', { item: itemId });
  }
  revalidatePath(`/${locale}/content`);
  revalidatePath(`/${locale}/approvals`);
  redirect(destination);
}

/**
 * PHASE 6 FINAL (D-277 §29, D-288) — "I MADE THE CHANGES": ONE FLOW.
 *
 * After a reviewer requests changes, the author answers the reviewer's thread
 * (optionally), marks it resolved and sends the post for review again — one
 * button instead of three screens. Nothing here is a second workflow: the
 * reply and the resolve are the ordinary notes calls, and the resubmission is
 * the SAME `approvals.submit` the Send for review button uses, with the same
 * permission, policy, audit and cycle numbering. The note text travels as the
 * request note so the reviewer sees what changed.
 *
 * A THREAD THAT CANNOT BE RESOLVED DOES NOT BLOCK THE RESUBMISSION: the
 * approval is the source of truth, the conversation is its companion.
 */
export async function resubmitAfterChangesAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const itemId = String(formData.get('itemId') ?? '');
  const reply = String(formData.get('reply') ?? '').trim();
  const threadIds = formData
    .getAll('threadId')
    .map(String)
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    .slice(0, 10);

  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'content.submit');
    try {
      await inNotes(locale, async ({ service, actor }) => {
        for (const threadId of threadIds) {
          if (reply !== '') await service.reply({ actor, threadId, body: reply });
          await service.resolve({ actor, threadId });
        }
      });
    } catch (noteFailure: unknown) {
      log.warn('changes-requested thread could not be closed', {
        itemId,
        ...internalErrorFields(noteFailure),
      });
    }
    await inContentStudio(session.workspace.workspaceId, async ({ approvals }) =>
      (await approvals()).submit({
        itemId,
        actor: approvalActorOf(session),
        assignedToUserId: null,
        note: reply,
      }),
    );
    destination = pageUrl(locale, '/compose', { item: itemId, ok: 'SUBMITTED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'resubmitAfterChanges', '/compose', { item: itemId });
  }
  revalidatePath(`/${locale}/content`);
  revalidatePath(`/${locale}/approvals`);
  revalidatePath(`/${locale}/notes`);
  redirect(destination);
}

/** Withdraw an open review, returning the item to a draft. */
export async function cancelReviewAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const itemId = String(formData.get('itemId') ?? '');
  const approvalId = String(formData.get('approvalId') ?? '');

  let destination: string;
  try {
    // `content.submit` is what it takes to OPEN a review, so it is what it takes
    // to withdraw one. The service additionally requires the caller to be the
    // requester or somebody who could have decided it.
    const session = await requireWorkspace(locale, 'content.submit');
    await inContentStudio(session.workspace.workspaceId, async ({ approvals }) =>
      (await approvals()).cancel({ approvalId, actor: approvalActorOf(session) }),
    );
    destination = pageUrl(locale, '/compose', { item: itemId, ok: 'SAVED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'cancelReview', '/compose', { item: itemId });
  }
  revalidatePath(`/${locale}/content`);
  revalidatePath(`/${locale}/approvals`);
  redirect(destination);
}

/**
 * The D-117 workspace retention control.
 *
 * ENFORCED SERVER-SIDE, which is the whole point of the finding: the form is a
 * representation of the setting, and this is the setting. The floor and the
 * "shorten, never lengthen" rule are applied by `resolveContentExpiry` when
 * content is written, and by the `workspace_ai_content_retention_days_positive`
 * CHECK in the database — so a crafted POST carrying `0` or `-1` is refused by
 * PostgreSQL even if this function were bypassed entirely.
 */
export async function saveRetentionAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'workspace.update');
    const raw = String(formData.get('retentionDays') ?? '').trim();
    const days = raw === '' ? null : Number.parseInt(raw, 10);
    if (days !== null && (!Number.isInteger(days) || days < 1)) {
      throw new Error('invalid retention window');
    }

    await inContentStudio(session.workspace.workspaceId, async ({ db, policy }) => {
      const resolved = await policy();
      /*
       * FLOORED HERE TOO, not only at write time.
       *
       * Storing a value below the configured minimum and quietly ignoring it
       * later would leave a settings screen displaying a promise the platform
       * does not keep. The stored number is the one that will be honoured.
       */
      const floored =
        days === null ? null : Math.max(days, resolved.retention.minCustomerRetentionDays);
      await db.workspace.update({
        where: { id: session.workspace.workspaceId },
        data: { aiContentRetentionDays: floored },
      });
      // CLAUDE.md §5: every mutation that changes tenant state writes an
      // AuditEvent. `writeAuditEvent` runs the redaction layer, so this goes
      // through it rather than straight at the table.
      await writeAuditEvent(db, session.workspace.workspaceId, {
        action: 'workspace.ai_content_retention.updated',
        actorType: 'USER',
        actorId: session.customer.userId,
        resourceType: 'Workspace',
        resourceId: session.workspace.workspaceId,
        after: { aiContentRetentionDays: floored },
      });
    });
    destination = `/${locale}/settings?ok=SAVED`;
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.warn('retention action failed', {
      correlationId,
      action: 'saveRetention',
      ...internalErrorFields(error),
    });
    destination = `/${locale}/settings?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(`/${locale}/settings`);
  redirect(destination);
}

/**
 * DUPLICATE A POST (D-277 §15, D-282) — a NEW draft carrying the source's
 * words, media, format, language, campaign and tags, through the ordinary
 * manual-create path: the same platform checks, the same brand-scope check,
 * the same audit. The source is read under the member's BrandScope, so a post
 * they cannot open cannot be copied.
 *
 * NOTHING ABOUT THE SOURCE'S LIFECYCLE IS COPIED — no approval, no schedule,
 * no publication: a duplicate is a draft. A campaign is kept only for a member
 * who may file content under campaigns, the same rule the composer applies.
 * The form's per-render token is the idempotency key, so a double click makes
 * one copy.
 */
export async function duplicateContentAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const itemId = String(formData.get('itemId') ?? '');
  const token = String(formData.get('token') ?? '').slice(0, 120) || randomUUID();
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'content.create');
    const mayFile = session.workspace.permissionKeys.includes(CAMPAIGN_ASSOCIATION_PERMISSION);
    const copyId = await inContentStudio(session.workspace.workspaceId, async (services) => {
      const [library, policy] = await Promise.all([services.library(), services.policy()]);
      const source = await library.getItem(itemId, session.workspace.brandScope);
      const facts = await readRetentionFacts(services.db, session.workspace.workspaceId);
      const created = await library.createManualItem({
        brandId: source.brandId,
        title: translator(locale)('content.duplicateTitle').replace('{title}', source.title),
        contentType: source.contentType,
        locale: source.primaryLocale,
        variants: source.variants
          .filter((variant) => variant.locale === source.primaryLocale)
          .map((variant) => ({
            platformKey: variant.platformKey,
            body: variant.body ?? '',
            hashtags: variant.hashtags,
            // A first comment travels only to a platform that still takes one:
            // the operator may have switched it off since it was written.
            firstComment: policy.platforms.find((p) => p.key === variant.platformKey)
              ?.allowsFirstComment
              ? variant.firstComment
              : null,
            linkUrl: variant.linkUrl,
            assetIds: variant.assetIds,
          })),
        campaignId: mayFile ? source.campaignId : null,
        pillar: source.pillar,
        tags: source.tags,
        idempotencyKey: `duplicate:${token}`,
        expiresAt: resolveContentExpiry(policy, facts, systemClock),
        ...actorOf(session),
      });
      return created.item.id;
    });
    destination = pageUrl(locale, '/compose', { item: copyId, ok: 'DUPLICATED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'duplicate', '');
  }
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}
