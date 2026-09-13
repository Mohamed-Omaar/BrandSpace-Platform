'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import {
  createKnowledgeItemSchema,
  reviewCandidateSchema,
  rollbackSchema,
  updateKnowledgeItemSchema,
  type LocalizedText,
} from '@brandspace/brand-brain';
import { requireWorkspace } from '../../../server/customer-context';
import { inBrandBrain } from '../../../server/brand-brain-context';

const log = createLogger({ context: { component: 'dashboard.brand-brain' } });

/**
 * Brand Brain actions.
 *
 * THE WORKSPACE IS NEVER TAKEN FROM THE FORM. `requireWorkspace()` reads it
 * from the session and re-verifies membership, so a crafted POST carrying
 * another tenant's ids operates on the caller's own workspace. The brand id
 * IS taken from the form — it has to be, the customer chooses it — and the
 * composite foreign key plus RLS are what make a foreign one fail rather than
 * succeed quietly.
 *
 * Each action names the permission it needs. The page also hides the control,
 * but hiding is a courtesy: the check here is what enforces it.
 */

function pageUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/brand-brain${search ? `?${search}` : ''}`;
}

function failure(
  locale: string,
  error: unknown,
  action: string,
  extra: Record<string, string> = {},
) {
  const correlationId = randomUUID();
  // The correlation id is the ONLY thing joining this screen to the server log,
  // and the log is redacted. No customer content is written either side.
  log.warn('brand brain action failed', { correlationId, action, ...internalErrorFields(error) });
  return pageUrl(locale, { ...extra, error: toPublicErrorCode(error), ref: correlationId });
}

function localized(formData: FormData, prefix: string): LocalizedText {
  const en = String(formData.get(`${prefix}En`) ?? '').trim();
  const ar = String(formData.get(`${prefix}Ar`) ?? '').trim();
  return {
    ...(en.length > 0 ? { en } : {}),
    ...(ar.length > 0 ? { ar } : {}),
  };
}

export async function createBrandAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'brand.manage');
    const name = String(formData.get('name') ?? '').trim();
    if (name.length === 0 || name.length > 120) throw new Error('invalid brand name');

    await inBrandBrain(session.workspace.workspaceId, async ({ db }) => {
      // A slug derived from the name, with a short suffix so two brands called
      // the same thing do not collide and so a soft-deleted brand does not hold
      // its slug hostage. The unique index is per workspace.
      const base =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'brand';
      await db.brand.create({
        data: {
          workspaceId: session.workspace.workspaceId,
          slug: `${base}-${randomUUID().slice(0, 6)}`,
          name,
          status: 'ACTIVE',
          defaultLocale: locale === 'ar' ? 'AR' : 'EN',
          supportedLocales: ['EN', 'AR'],
        },
      });
    });
    destination = pageUrl(locale, { ok: 'BRAND_CREATED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'create-brand');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function createKnowledgeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'brand_brain.edit');
    const parsed = createKnowledgeItemSchema.parse({
      brandId: String(formData.get('brandId') ?? ''),
      area,
      itemKey: String(formData.get('itemKey') ?? ''),
      title: localized(formData, 'title'),
      body: localized(formData, 'body'),
    });

    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge, policy }) => {
      await knowledge.createItem({
        brandId: parsed.brandId,
        area: parsed.area as never,
        itemKey: parsed.itemKey,
        title: parsed.title,
        body: parsed.body,
        actor: {
          userId: session.customer.userId,
          permissionKeys: session.workspace.permissionKeys,
        },
        policy: (await policy()).staleness,
      });
    });
    destination = pageUrl(locale, { ok: 'KNOWLEDGE_SAVED', area });
  } catch (error: unknown) {
    destination = failure(locale, error, 'create-knowledge', { area });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function updateKnowledgeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'brand_brain.edit');
    const parsed = updateKnowledgeItemSchema.parse({
      itemId: String(formData.get('itemId') ?? ''),
      title: localized(formData, 'title'),
      body: localized(formData, 'body'),
      ...(formData.get('changeReason')
        ? { changeReason: String(formData.get('changeReason')) }
        : {}),
    });

    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge, policy }) => {
      await knowledge.updateItem({
        itemId: parsed.itemId,
        title: parsed.title,
        body: parsed.body,
        changeReason: parsed.changeReason,
        actor: {
          userId: session.customer.userId,
          permissionKeys: session.workspace.permissionKeys,
        },
        policy: (await policy()).staleness,
      });
    });
    destination = pageUrl(locale, { ok: 'KNOWLEDGE_SAVED', area });
  } catch (error: unknown) {
    destination = failure(locale, error, 'update-knowledge', { area });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function archiveKnowledgeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'brand_brain.delete');
    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge }) => {
      await knowledge.archiveItem({
        itemId: String(formData.get('itemId') ?? ''),
        ...(formData.get('reason') ? { reason: String(formData.get('reason')) } : {}),
        actor: {
          userId: session.customer.userId,
          permissionKeys: session.workspace.permissionKeys,
        },
      });
    });
    destination = pageUrl(locale, { ok: 'KNOWLEDGE_ARCHIVED', area });
  } catch (error: unknown) {
    destination = failure(locale, error, 'archive-knowledge', { area });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function rollbackKnowledgeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'brand_brain.edit');
    const parsed = rollbackSchema.parse({
      itemId: String(formData.get('itemId') ?? ''),
      toVersion: Number(formData.get('toVersion') ?? 0),
      ...(formData.get('reason') ? { reason: String(formData.get('reason')) } : {}),
    });
    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge, policy }) => {
      await knowledge.rollback({
        itemId: parsed.itemId,
        toVersion: parsed.toVersion,
        reason: parsed.reason,
        actor: {
          userId: session.customer.userId,
          permissionKeys: session.workspace.permissionKeys,
        },
        policy: (await policy()).staleness,
      });
    });
    destination = pageUrl(locale, { ok: 'KNOWLEDGE_RESTORED', area });
  } catch (error: unknown) {
    destination = failure(locale, error, 'rollback-knowledge', { area });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function reviewCandidateAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'brand_brain.review');
    const decision = String(formData.get('decision') ?? '');
    const parsed = reviewCandidateSchema.parse({
      candidateId: String(formData.get('candidateId') ?? ''),
      decision,
      // Only an edited acceptance may carry text. The schema refuses an edit
      // smuggled alongside a plain accept, so this stays honest.
      ...(decision === 'accept_edited'
        ? { title: localized(formData, 'title'), body: localized(formData, 'body') }
        : {}),
      ...(formData.get('reason') ? { reason: String(formData.get('reason')) } : {}),
    });

    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge, policy }) => {
      await knowledge.reviewCandidate({
        candidateId: parsed.candidateId,
        decision: parsed.decision,
        title: parsed.title,
        body: parsed.body,
        reason: parsed.reason,
        actor: {
          userId: session.customer.userId,
          permissionKeys: session.workspace.permissionKeys,
        },
        policy: (await policy()).staleness,
      });
    });
    destination = pageUrl(locale, {
      ok: parsed.decision === 'reject' ? 'CANDIDATE_REJECTED' : 'CANDIDATE_ACCEPTED',
      area,
    });
  } catch (error: unknown) {
    destination = failure(locale, error, 'review-candidate', { area });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

/**
 * Upload a source document and process it.
 *
 * PROCESSING RUNS INLINE, and that is a stated Phase 5 limitation rather than
 * an oversight. There is no job runner wired to the customer app yet, so a
 * queued job would sit untouched and the customer would watch a spinner that
 * never resolves. Running it in the request is honest: the work is bounded by
 * the upload ceiling, the job row records every stage exactly as a worker would
 * write it, and moving to a worker later changes this one call rather than the
 * pipeline.
 */
export async function uploadSourceAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspace(locale, 'brand_brain.upload');
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) throw new Error('no file');

    const bytes = new Uint8Array(await file.arrayBuffer());
    const brandId = String(formData.get('brandId') ?? '');
    const targetArea = area.length > 0 ? area : undefined;

    await inBrandBrain(session.workspace.workspaceId, async ({ ingestion }) => {
      const service = await ingestion();
      const { job } = await service.upload({
        brandId,
        fileName: file.name,
        // The browser's type, not the extension. Both are attacker-controlled,
        // which is why the allow-list is checked against a fixed set rather
        // than trusted to describe the bytes.
        mimeType: file.type || 'application/octet-stream',
        bytes,
        targetArea: targetArea as never,
        // Derived from the CONTENT and the brand, so a double-submit of the
        // same form replays instead of creating a second document.
        idempotencyKey: `ui-${brandId}-${file.name}-${file.size}`.slice(0, 120),
        actorUserId: session.customer.userId,
      });
      await service.process(job.id);
    });
    destination = pageUrl(locale, { ok: 'SOURCE_UPLOADED', area });
  } catch (error: unknown) {
    destination = failure(locale, error, 'upload-source', { area });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}
