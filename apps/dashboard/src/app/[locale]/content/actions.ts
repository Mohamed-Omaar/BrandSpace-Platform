'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
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
 * DRAFT → IN_REVIEW → ARCHIVED, and back. Nothing further.
 *
 * SCHEDULED and PUBLISHED belong to the Social Calendar and the publishing
 * pipeline; the service refuses them, and this action has no way to name one.
 */
export async function transitionItemAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const itemId = String(formData.get('itemId') ?? '');
  const raw = String(formData.get('to') ?? '');
  const to = raw === 'IN_REVIEW' || raw === 'ARCHIVED' || raw === 'DRAFT' ? raw : null;

  let destination: string;
  try {
    if (!to) throw new Error('unsupported transition');
    const permission = to === 'ARCHIVED' ? 'content.archive' : 'content.submit';
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
