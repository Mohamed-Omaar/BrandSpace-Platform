'use server';

import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { writeAuditEvent } from '@brandspace/database';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { requireWorkspace, type WorkspaceSession } from '../../../server/customer-context';
import { inContentStudio } from '../../../server/content-context';

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

/** Save a person's own edit to a caption. No gateway, no credits. */
export async function saveVariantAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
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

    await inContentStudio(session.workspace.workspaceId, async ({ library }) =>
      (await library()).editVariant({
        variantId,
        body,
        hashtags,
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
  const locale = String(formData.get('locale') ?? 'ar');
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
    destination = pageUrl(locale, '/compose', { item: itemId, ok: 'CAMPAIGN_LINKED' });
  } catch (error: unknown) {
    if (isRedirectError(error)) throw error;
    destination = failure(locale, error, 'setContentCampaign', '/compose', { item: itemId });
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
  const locale = String(formData.get('locale') ?? 'ar');
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
  const locale = String(formData.get('locale') ?? 'ar');
  const itemId = String(formData.get('itemId') ?? '');
  const note = String(formData.get('note') ?? '');
  const assignedTo = String(formData.get('assignedToUserId') ?? '');

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
    destination = pageUrl(locale, '/compose', { item: itemId, ok: 'SUBMITTED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'submitForReview', '/compose', { item: itemId });
  }
  revalidatePath(`/${locale}/content`);
  revalidatePath(`/${locale}/approvals`);
  redirect(destination);
}

/** Withdraw an open review, returning the item to a draft. */
export async function cancelReviewAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
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
  const locale = String(formData.get('locale') ?? 'ar');
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
