'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import {
  acceptConfidentSchema,
  checksumOf,
  createKnowledgeItemSchema,
  parseValidUntil,
  rollbackSchema,
  updateKnowledgeItemSchema,
  type LocalizedText,
} from '@brandspace/brand-brain';
import {
  INGEST_SOURCE_DOCUMENT,
  enqueue,
  type IngestSourceDocumentPayload,
} from '@brandspace/jobs';
import {
  type WorkspaceSession,
  holdsPermission,
  requireWorkspaceAction,
} from '../../../server/customer-context';
import { actionErrorCode } from '../../../server/denial';
import { inBrandBrain } from '../../../server/brand-brain-context';
import { brandLocaleAtCreation } from '../../../server/brand-ai-language';
import { createBrandFor } from '../../../server/brand-creation';
import { applyCandidateReview, reviewCandidateInputFrom } from '../../../server/candidate-review';

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

/**
 * WHERE AN ACTION RETURNS — a CLOSED SET, never a caller-supplied URL.
 *
 * The first-run Setup Wizard (D-277 §6) uploads brand documents and reviews
 * extracted knowledge through THESE actions rather than copies of them; the
 * form says it came from the wizard and which step, and anything else returns
 * to Brand Brain.
 */
const WIZARD_STEPS = new Set(['learn', 'review']);

function backTo(formData: FormData): { readonly path: string; readonly step?: string } {
  if (String(formData.get('returnTo') ?? '') !== '/onboarding') return { path: '/brand-brain' };
  const step = String(formData.get('step') ?? '');
  return { path: '/onboarding', ...(WIZARD_STEPS.has(step) ? { step } : {}) };
}

/**
 * D1 (Phase 2C) — the Brand Brain tab a form was posted from, so the redirect
 * lands the person back where they were. A closed set; anything else is the
 * default tab.
 */
const TABS = new Set(['knowledge', 'look', 'sources', 'chat']);

function tabParam(formData: FormData): Record<string, string> {
  const tab = String(formData.get('tab') ?? '');
  return TABS.has(tab) && tab !== 'knowledge' ? { tab } : {};
}

function pageUrl(
  locale: string,
  params: Record<string, string> = {},
  back: { readonly path: string; readonly step?: string } = { path: '/brand-brain' },
): string {
  const search = new URLSearchParams({ ...(back.step ? { step: back.step } : {}), ...params });
  const query = search.toString();
  return `/${locale}${back.path}${query ? `?${query}` : ''}`;
}

function failure(
  locale: string,
  error: unknown,
  action: string,
  extra: Record<string, string> = {},
  back: { readonly path: string; readonly step?: string } = { path: '/brand-brain' },
) {
  const correlationId = randomUUID();
  // The correlation id is the ONLY thing joining this screen to the server log,
  // and the log is redacted. No customer content is written either side.
  log.warn('brand brain action failed', { correlationId, action, ...internalErrorFields(error) });
  return pageUrl(locale, { ...extra, error: actionErrorCode(error), ref: correlationId }, back);
}

function localized(formData: FormData, prefix: string): LocalizedText {
  const en = String(formData.get(`${prefix}En`) ?? '').trim();
  const ar = String(formData.get(`${prefix}Ar`) ?? '').trim();
  return {
    ...(en.length > 0 ? { en } : {}),
    ...(ar.length > 0 ? { ar } : {}),
  };
}

/**
 * The fact's title. The Voice card's one-line rules (decision 2.b) send no
 * title and ask for one made from the rule itself (`titleFromBody`), cut to
 * the title's length; everywhere else a title is typed.
 */
function titleOf(formData: FormData): LocalizedText {
  const typed = localized(formData, 'title');
  if (typed.en || typed.ar || formData.get('titleFromBody') !== '1') return typed;
  const body = localized(formData, 'body');
  const cut = (text: string | undefined) => text?.slice(0, 120);
  return {
    ...(body.en ? { en: cut(body.en) } : {}),
    ...(body.ar ? { ar: cut(body.ar) } : {}),
  };
}

/**
 * The new fact's key. Typed in the area drawer; for the Voice card's rules
 * (decision 2.b) the form sends only the rule's PREFIX — `tone.`, `do.` or
 * `dont.` — and the key is that prefix plus a short random suffix, so two
 * rules never collide and the prefix is what files the rule. Any other prefix
 * is refused by the key schema's own shape.
 */
const RULE_PREFIXES = new Set(['tone.', 'do.', 'dont.']);

function itemKeyFrom(formData: FormData): string {
  const typed = String(formData.get('itemKey') ?? '').trim();
  if (typed.length > 0) return typed;
  const prefix = String(formData.get('itemKeyPrefix') ?? '');
  return RULE_PREFIXES.has(prefix) ? `${prefix}${randomUUID().slice(0, 8)}` : '';
}

/** D6 — the "valid until" field, only when the form carries it. */
function validUntilField(formData: FormData): { validUntil?: string } {
  return formData.has('validUntil') ? { validUntil: String(formData.get('validUntil') ?? '') } : {};
}

export async function createBrandAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand.manage');
    const name = String(formData.get('name') ?? '').trim();
    if (name.length === 0 || name.length > 120) throw new Error('invalid brand name');

    /*
     * THE ONE CREATION PATH (`server/brand-creation.ts`), shared with the
     * first-run Setup Wizard: idempotent on the name, counted against the
     * plan's brand quota, and audited. The brand's AI writing language is the
     * form's explicit choice, else the language its creator is using the
     * interface in right now (D-331, amending D-277) — and it stays that until
     * changed in Settings → AI.
     */
    await createBrandFor(session, {
      name,
      defaultLocale: brandLocaleAtCreation(String(formData.get('defaultLocale') ?? ''), locale),
      supportedLocales: ['EN', 'AR'],
    });
    destination = pageUrl(locale, { ok: 'BRAND_CREATED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'create-brand');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function createKnowledgeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand_brain.edit');
    const parsed = createKnowledgeItemSchema.parse({
      brandId: String(formData.get('brandId') ?? ''),
      area,
      itemKey: itemKeyFrom(formData),
      title: titleOf(formData),
      body: localized(formData, 'body'),
      ...validUntilField(formData),
    });

    /*
     * D7 (Phase 2C-3, decision 4.b) — ONE ADD RULE, HERE AND IN THE CHAT.
     * Adding an APPROVED fact needs `brand_brain.edit` AND
     * `brand_brain.review`; a member with edit alone sends the fact for review
     * — a PENDING MEMBER candidate in the one inbox — and no ACTIVE fact is
     * created. (A candidate carries no end date; the reviewer sets one when
     * accepting, through Edit details.)
     */
    const approve = holdsPermission(session.workspace, 'brand_brain.review');
    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge, policy }) => {
      if (!approve) {
        await knowledge.proposeFact({
          brandId: parsed.brandId,
          area: parsed.area as never,
          itemKey: parsed.itemKey,
          title: parsed.title,
          body: parsed.body,
          actor: knowledgeActor(session),
        });
        return;
      }
      await knowledge.createItem({
        brandId: parsed.brandId,
        area: parsed.area as never,
        itemKey: parsed.itemKey,
        title: parsed.title,
        body: parsed.body,
        actor: knowledgeActor(session),
        policy: (await policy()).staleness,
        // D6 — a workspace-local calendar day, or none.
        validUntil: parseValidUntil(parsed.validUntil),
      });
    });
    destination = pageUrl(locale, {
      ok: approve ? 'KNOWLEDGE_SAVED' : 'KNOWLEDGE_SENT_FOR_REVIEW',
      area,
      ...tabParam(formData),
    });
  } catch (error: unknown) {
    destination = failure(locale, error, 'create-knowledge', { area, ...tabParam(formData) });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function updateKnowledgeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand_brain.edit');
    const parsed = updateKnowledgeItemSchema.parse({
      itemId: String(formData.get('itemId') ?? ''),
      title: titleOf(formData),
      body: localized(formData, 'body'),
      ...(formData.get('changeReason')
        ? { changeReason: String(formData.get('changeReason')) }
        : {}),
      ...validUntilField(formData),
    });

    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge, policy }) => {
      await knowledge.updateItem({
        itemId: parsed.itemId,
        title: parsed.title,
        body: parsed.body,
        changeReason: parsed.changeReason,
        actor: knowledgeActor(session),
        policy: (await policy()).staleness,
        // D6 — only a form that carries the field changes it; empty clears it.
        ...(parsed.validUntil !== undefined
          ? { validUntil: parseValidUntil(parsed.validUntil) }
          : {}),
      });
    });
    destination = pageUrl(locale, { ok: 'KNOWLEDGE_SAVED', area, ...tabParam(formData) });
  } catch (error: unknown) {
    destination = failure(locale, error, 'update-knowledge', { area, ...tabParam(formData) });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function archiveKnowledgeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    // E3 — archiving a fact is an edit of the brand's knowledge (`brand_brain.edit`).
    const session = await requireWorkspaceAction(locale, 'brand_brain.edit');
    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge }) => {
      await knowledge.archiveItem({
        itemId: String(formData.get('itemId') ?? ''),
        ...(formData.get('reason') ? { reason: String(formData.get('reason')) } : {}),
        actor: knowledgeActor(session),
      });
    });
    destination = pageUrl(locale, { ok: 'KNOWLEDGE_ARCHIVED', area, ...tabParam(formData) });
  } catch (error: unknown) {
    destination = failure(locale, error, 'archive-knowledge', { area, ...tabParam(formData) });
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function rollbackKnowledgeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const area = String(formData.get('area') ?? '');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand_brain.edit');
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
  const locale = String(formData.get('locale') ?? 'en');
  const area = String(formData.get('area') ?? '');
  const back = backTo(formData);
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand_brain.review');
    const parsed = reviewCandidateInputFrom(formData);

    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge, policy }) =>
      applyCandidateReview(
        knowledge,
        parsed,
        knowledgeActor(session),
        (await policy()).staleness,
        // Review item 15: Brand Brain's review is ALWAYS a document review. The
        // setup wizard has its own action, which decides SETUP on the server;
        // no field of this request can.
        false,
      ),
    );
    destination = pageUrl(
      locale,
      {
        ok: parsed.decision === 'reject' ? 'CANDIDATE_REJECTED' : 'CANDIDATE_ACCEPTED',
        area,
      },
      back,
    );
  } catch (error: unknown) {
    destination = failure(locale, error, 'review-candidate', { area }, back);
  }
  revalidatePath(`/${locale}/brand-brain`);
  revalidatePath(`/${locale}/onboarding`);
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
 * AND NOT OUTSIDE PRODUCTION EITHER (Phase 2C-4). A missing `REDIS_URL` used
 * to fall back to running the pipeline here in development; untrusted document
 * bytes are now parsed only by the media-processing worker, in every
 * environment, and an undispatched upload waits for the sweep.
 */
/**
 * D4 + C1 — "ACCEPT THE CONFIDENT ONES", after the person saw the preview and
 * confirmed. `brand_brain.review`, like every accept. The ids they confirmed go
 * through `reviewCandidates` — the one bulk path, one transaction, every
 * candidate through `reviewCandidate` — which re-checks each against the
 * CONFIGURED threshold (never a number from the form) and skips conflicts and
 * anything decided since the preview.
 */
export async function acceptConfidentCandidatesAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand_brain.review');
    const parsed = acceptConfidentSchema.parse({
      brandId: String(formData.get('brandId') ?? ''),
      candidateIds: formData.getAll('candidateId').map(String),
    });
    const outcome = await inBrandBrain(
      session.workspace.workspaceId,
      async ({ knowledge, policy }) => {
        const resolved = await policy();
        return knowledge.reviewCandidates({
          brandId: parsed.brandId,
          candidateIds: parsed.candidateIds,
          minimumConfidenceMilli: resolved.review.confidentAcceptMilli,
          actor: knowledgeActor(session),
          policy: resolved.staleness,
        });
      },
    );
    destination = pageUrl(locale, {
      ok: 'CANDIDATES_ACCEPTED',
      accepted: String(outcome.accepted.length),
      skipped: String(outcome.skipped.length),
    });
  } catch (error: unknown) {
    destination = failure(locale, error, 'accept-confident');
  }
  revalidatePath(`/${locale}/brand-brain`);
  redirect(destination);
}

export async function uploadSourceAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const area = String(formData.get('area') ?? '');
  const back = backTo(formData);
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'brand_brain.upload');
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
     * replay, and anything else is a new upload. (A REMOVED source ends the
     * key's generation — the service records the next upload as `<key>#2`.)
     */
    const checksum = await checksumOf(bytes);
    const idempotencyKey = `ui:${session.workspace.workspaceId}:${brandId}:${
      targetArea ?? 'auto'
    }:${checksum}`;

    const input = {
      brandId,
      fileName: file.name,
      mimeType: declaredSourceType(file),
      bytes,
      targetArea: targetArea as never,
      idempotencyKey,
      actorUserId: session.customer.userId,
      actorBrandScope: session.workspace.brandScope,
    };
    const receive = () =>
      inBrandBrain(session.workspace.workspaceId, async ({ ingestion }) =>
        (await ingestion()).receive(input),
      );

    /*
     * A RACE IS ANSWERED BY THE DUPLICATE PATH, NEVER BY THE INDEX'S ERROR.
     * Two identical uploads at the same instant both pass the service's
     * look-up, and the loser's insert meets a unique index (M6's live checksum,
     * or the request key). That aborts its transaction, so it is run once more
     * in a fresh one — where the winner's row now exists and is returned or
     * refused exactly as a later upload would be.
     */
    let received: Awaited<ReturnType<typeof receive>>;
    try {
      received = await receive();
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;
      received = await receive();
    }

    const job = received.job;
    if (job && job.stage === 'QUEUED') {
      /*
       * WORKER ONLY (Phase 2C-4). Untrusted document bytes are parsed only by
       * the media-processing worker. The historical non-production fallback
       * that ran the parser HERE, inside the request, when no queue was
       * configured is gone: a missing dispatch now waits for the
       * reconciliation sweep in every environment, and the upload still
       * succeeded — the row is durable and reads Queued.
       */
      const dispatch = await enqueue('media-processing', INGEST_SOURCE_DOCUMENT, {
        kind: INGEST_SOURCE_DOCUMENT,
        workspaceId: session.workspace.workspaceId,
        requestedByUserId: session.customer.userId,
        // The job row's id IS the natural key for this work. A second dispatch
        // of the same row is refused by BullMQ rather than parsed twice.
        idempotencyKey: `ingest-${job.id}`,
        ingestionJobId: job.id,
      } satisfies IngestSourceDocumentPayload);
      if (!dispatch.dispatched) {
        log.error('could not dispatch ingestion; leaving it for the reconciliation sweep', {
          workspaceId: session.workspace.workspaceId,
          jobId: job.id,
        });
      }
    }

    const failed = received.document.status === 'FAILED';
    destination = pageUrl(
      locale,
      failed
        ? {
            // The row carries the reason, in the reader's language; the banner
            // says only that this file did not become a usable source.
            error: received.outcome === 'refused' ? 'SOURCE_REFUSED' : 'SOURCE_ALREADY_FAILED',
            source: received.document.id,
            area,
            ...tabParam(formData),
          }
        : { ok: 'SOURCE_UPLOADED', area, ...tabParam(formData) },
      back,
    );
  } catch (error: unknown) {
    destination = failure(locale, error, 'upload-source', { area, ...tabParam(formData) }, back);
  }
  revalidatePath(`/${locale}/brand-brain`);
  revalidatePath(`/${locale}/onboarding`);
  redirect(destination);
}

/**
 * THE TYPE THE UPLOAD IS DECLARED AS — which checks apply, never which pass.
 *
 * The browser's type when it gave one the configuration can name; otherwise the
 * type the extension names, because browsers disagree about `.md` and `.csv`
 * (an empty type, `text/x-markdown`, a spreadsheet type). Either way it only
 * CHOOSES the checks: the service decides from the bytes — the signature, the
 * OOXML main part, a strict UTF-8 decode — and refuses a file whose bytes
 * disagree. `.doc` and `.ppt` map to their own legacy types, which nothing
 * reads, so they are refused as unsupported.
 */
function declaredSourceType(file: File): string {
  const byExtension: Record<string, string> = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    md: 'text/markdown',
    markdown: 'text/markdown',
    doc: 'application/msword',
    ppt: 'application/vnd.ms-powerpoint',
  };
  const browser = file.type.trim().toLowerCase();
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
  const fromExtension = byExtension[extension];
  const known = new Set(Object.values(byExtension));
  if (known.has(browser)) return browser;
  return fromExtension ?? (browser || 'application/octet-stream');
}

/** A PostgreSQL unique violation, as Prisma reports it (P2002), from a racing twin. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
