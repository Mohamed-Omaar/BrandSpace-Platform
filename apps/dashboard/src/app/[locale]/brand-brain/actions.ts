'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import {
  checksumOf,
  createKnowledgeItemSchema,
  reviewCandidateSchema,
  rollbackSchema,
  updateKnowledgeItemSchema,
  type LocalizedText,
} from '@brandspace/brand-brain';
import {
  INGEST_SOURCE_DOCUMENT,
  enqueue,
  mayProcessInline,
  type IngestSourceDocumentPayload,
} from '@brandspace/jobs';
import { QUOTA_FEATURES, TOTAL_RESOURCE_DIMENSIONS } from '@brandspace/entitlements';
import { requireWorkspace, type WorkspaceSession } from '../../../server/customer-context';
import { inBrandBrain } from '../../../server/brand-brain-context';

const log = createLogger({ context: { component: 'dashboard.brand-brain' } });

/**
 * The actor every Brand Brain service call is made under, built in ONE place.
 *
 * Its brand scope is the whole point. Assembling the actor inline at five call
 * sites is how one of them ends up without it, and the field is required
 * precisely so that omission is a type error rather than a silent grant (F-74).
 */
function knowledgeActor(session: WorkspaceSession): {
  userId: string;
  permissionKeys: readonly string[];
  brandScope: readonly string[];
} {
  return {
    userId: session.customer.userId,
    permissionKeys: session.workspace.permissionKeys,
    brandScope: session.workspace.brandScope,
  };
}

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

    await inBrandBrain(session.workspace.workspaceId, async ({ db, entitlements, usage }) => {
      /*
       * CREATING A BRAND IS IDEMPOTENT ON ITS NAME (PHASE 2).
       *
       * This is the only path in the product that creates a brand, and it is
       * the step a new customer takes first. It had no replay guard at all: a
       * double submit, a browser retry, or somebody walking the onboarding
       * checklist a second time each made ANOTHER brand — same name, different
       * slug, and now a workspace with two identical-looking brands whose
       * content, knowledge and analytics are split between them. Nothing in the
       * product merges those afterwards.
       *
       * The name is the key a person would use, so it is the key this uses:
       * asking for a brand that already exists returns the one that exists.
       * Comparison is case-insensitive and trimmed because "Acme" and "acme "
       * are the same request typed twice, not two brands.
       */
      const existing = await db.brand.findFirst({
        where: {
          workspaceId: session.workspace.workspaceId,
          deletedAt: null,
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (existing) return;

      /*
       * THE PLAN'S BRAND CEILING (D-10, `limit.brands`), ENFORCED HERE BECAUSE
       * HERE IS WHERE A BRAND COMES INTO EXISTENCE.
       *
       * It was not enforced anywhere. `limit.brands` was in the plan catalogue,
       * in the quota projection, on the Control Center's plan editor and in the
       * downgrade impact check — and no code path consulted it, so every
       * workspace on every plan could create brands without end. A limit that
       * only appears in a form an operator fills in is not a limit.
       *
       * THE ENGINE ANSWERS, NOT THIS FILE. `entitlements.limit` resolves plan →
       * override → flag → default; `null` means unlimited and 0 means none, and
       * the two are not the same number. A second count written here would be a
       * second answer (the mistake `inAssetLibrary` records for storage).
       *
       * THE COUNTER AND THE BRAND MOVE TOGETHER. `inBrandBrain` runs this whole
       * callback inside ONE PostgreSQL transaction, and `UsageService` runs
       * inline on that same transaction rather than opening its own — so a
       * `brand.create` that fails takes the consumption with it, and there is no
       * window in which the plan is charged for a brand that does not exist.
       *
       * IDEMPOTENT ON THE BRAND THIS IS, not on the click. The key is the
       * workspace and the normalised name — the same identity the replay guard
       * above uses — so a retried submit that gets past the guard consumes the
       * same slot rather than a second one.
       */
      await usage.consume({
        workspaceId: session.workspace.workspaceId,
        featureKey: QUOTA_FEATURES.brands,
        limitValue: await entitlements.limit(session.workspace.workspaceId, QUOTA_FEATURES.brands),
        period: 'total',
        idempotencyKey: `brand:${session.workspace.workspaceId}:${name.toLowerCase()}`,
        /*
         * THE BRANDS THAT ALREADY EXIST.
         *
         * A `total` quota counts things, and the things predate the day the
         * dimension was wired up: every brand made before this call site
         * existed is in the table and not in the counter, and would have been
         * free. The count runs inside this transaction, behind the counter
         * row's own lock, so it is the population the new brand is joining and
         * not a number that could have moved since it was read.
         *
         * THE PREDICATE IS DECLARED ONCE, beside the dimension it belongs to,
         * so this action, the connected-account route and every suite agree
         * about what occupies a slot.
         */
        baselineCount: (scoped) =>
          TOTAL_RESOURCE_DIMENSIONS.brands.live(scoped, session.workspace.workspaceId),
      });

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
        actor: knowledgeActor(session),
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
        actor: knowledgeActor(session),
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
        actor: knowledgeActor(session),
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
        actor: knowledgeActor(session),
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
        actor: knowledgeActor(session),
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
 * Upload a source document and hand it to the worker.
 *
 * IT NO LONGER PROCESSES INLINE IN PRODUCTION. Phase 5A ran the whole pipeline
 * — read the object, parse it, chunk it, propose candidates — inside the server
 * action, because there was nowhere to dispatch to. Three things are wrong with
 * that and none of them show up as a failing test: the request holds a
 * connection for the length of a parse, one slow document delays every other
 * request on the instance, and a deploy mid-parse loses the work with nothing
 * anywhere recording that it was lost.
 *
 * The upload now WRITES THE ROW AND DISPATCHES. `brand_ingestion_job` is the
 * durable state and the queue message is a pointer to it, so a dispatch that
 * never arrives costs punctuality rather than correctness: the reconciliation
 * sweep in `apps/api` finds the unclaimed row and dispatches it again
 * (docs/ARCHITECTURE.md §9).
 *
 * OUTSIDE PRODUCTION, and only there, a missing `REDIS_URL` falls back to
 * running the pipeline here. A developer trying an upload should not need a
 * Redis container, and an end-to-end run should not need one either. In
 * production the fallback is refused outright — see `mayProcessInline` — so the
 * old behaviour cannot return by accident or by a missing environment variable.
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

    /*
     * THE IDEMPOTENCY KEY IS THE CONTENT, not the file's name and size.
     *
     * It used to be `ui-<brand>-<name>-<size>`, which answers a different
     * question than the one it was asked. Two DIFFERENT documents saved as
     * `brand.pdf` at the same byte count collide and the second is silently
     * discarded as a replay of the first; the same document renamed produces a
     * second upload rather than replaying. A checksum over the bytes, scoped to
     * the workspace, the brand and the area the customer chose, answers "is
     * this the same request?" correctly: the same file to the same place is a
     * replay, and anything else is a new upload.
     */
    const checksum = await checksumOf(bytes);
    const idempotencyKey = `ui:${session.workspace.workspaceId}:${brandId}:${
      targetArea ?? 'auto'
    }:${checksum}`;

    const queued = await inBrandBrain(session.workspace.workspaceId, async ({ ingestion }) => {
      const service = await ingestion();
      const { job } = await service.upload({
        brandId,
        fileName: file.name,
        // The browser's type, not the extension. Both are attacker-controlled,
        // which is why the allow-list is checked against a fixed set and the
        // file's own SIGNATURE has to agree before anything is stored.
        mimeType: file.type || 'application/octet-stream',
        bytes,
        targetArea: targetArea as never,
        idempotencyKey,
        actorUserId: session.customer.userId,
        actorBrandScope: session.workspace.brandScope,
      });
      return job;
    });

    const dispatch = await enqueue('media-processing', INGEST_SOURCE_DOCUMENT, {
      kind: INGEST_SOURCE_DOCUMENT,
      workspaceId: session.workspace.workspaceId,
      requestedByUserId: session.customer.userId,
      // The job row's id IS the natural key for this work. A second dispatch
      // of the same row is refused by BullMQ rather than parsed twice.
      idempotencyKey: `ingest-${queued.id}`,
      ingestionJobId: queued.id,
    } satisfies IngestSourceDocumentPayload);

    if (!dispatch.dispatched) {
      if (!mayProcessInline()) {
        /*
         * PRODUCTION DOES NOT PROCESS INLINE. The row is already durable, so
         * the reconciliation sweep will pick it up: the upload succeeded, the
         * document reads PROCESSING, and the outage is the operator's to fix
         * rather than the customer's to notice as a slow page.
         */
        log.error('could not dispatch ingestion; leaving it for the reconciliation sweep', {
          workspaceId: session.workspace.workspaceId,
          jobId: queued.id,
        });
      } else {
        log.warn('no queue configured; processing this upload inline (non-production only)', {
          jobId: queued.id,
        });
        await inBrandBrain(session.workspace.workspaceId, async ({ ingestion }) => {
          const service = await ingestion();
          await service.process(queued.id);
        });
      }
    }
    destination = pageUrl(locale, { ok: 'SOURCE_UPLOADED', area });
  } catch (error: unknown) {
    destination = failure(locale, error, 'upload-source', { area });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}
