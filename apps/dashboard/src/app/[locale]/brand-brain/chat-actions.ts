'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import type { BrandKnowledgeArea } from '@brandspace/database';
import {
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  areaSchema,
  itemKeySchema,
  isoDateOf,
  isExpired,
  workspaceKnowledgeAsOf,
  type LocalizedText,
} from '@brandspace/brand-brain';
import { requireWorkspaceAction, type WorkspaceSession } from '../../../server/customer-context';
import { actionErrorCode } from '../../../server/denial';
import { inBrandBrain } from '../../../server/brand-brain-context';

/**
 * BRAND BRAIN CHAT — Add, Edit and Remove (D7, Phase 2C-3).
 *
 * Ask is the existing AI chat (`/api/brand-brain/chat`). These three modes are
 * MANAGEMENT, not AI: no model is called, no credit moves, and nothing here
 * builds a prompt. The Edit and Remove lookups reuse the retriever's own local
 * lexical `score` (`BrandKnowledgeService.matchFacts`), and every write goes
 * through the ordinary knowledge service — its validation, version, audit
 * event, brand scope and RLS.
 *
 * EACH ACTION CHECKS ITS OWN PERMISSION ON THE SERVER; hiding a control is a
 * courtesy. The workspace is always the session's.
 *
 *   - Add & approve → `brand_brain.edit` AND `brand_brain.review`: an ACTIVE fact.
 *   - Send for review → `brand_brain.edit`: a PENDING MEMBER candidate in the
 *     one review inbox (migrations M4a/M4b). `brand_brain.review` alone adds
 *     nothing.
 *   - Edit, Remove, Undo → `brand_brain.edit`.
 *
 * They answer with a small result object rather than a redirect, so the chat
 * keeps its place; `revalidatePath` plus the client's `router.refresh()`
 * redraws the area cards, counts and "answered n of m" at once (D7).
 */

const log = createLogger({ context: { component: 'dashboard.brand-brain.chat-modes' } });

export type ChatActionResult<T extends object = object> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      /** A stable code the screen translates: VALIDATION_FAILED, CHANGED, FORBIDDEN:…, … */
      readonly code: string;
      /** For VALIDATION_FAILED, the first field that is missing or wrong. */
      readonly field?: string;
      /** For CHANGED, the fact as it is now. */
      readonly fresh?: ChatFact;
    };

/** A fact as the Edit and Remove modes show it. Both languages, for editing. */
export interface ChatFact {
  readonly id: string;
  readonly area: string;
  readonly itemKey: string;
  readonly version: number;
  readonly title: LocalizedText;
  readonly body: LocalizedText;
  readonly validUntil: string | null;
  readonly expired: boolean;
}

function actorOf(session: WorkspaceSession) {
  return {
    userId: session.customer.userId,
    permissionKeys: session.workspace.permissionKeys,
    brandScope: session.workspace.brandScope,
  };
}

function refused(error: unknown, action: string): { ok: false; code: string } {
  const code = actionErrorCode(error);
  if (code === 'INTERNAL') {
    log.warn('brand brain chat action failed', {
      correlationId: randomUUID(),
      action,
      ...internalErrorFields(error),
    });
  }
  // `CONCURRENT_EDIT` is the public code of a changed-since conflict.
  return { ok: false, code: toPublicErrorCode(error) === 'CONCURRENT_EDIT' ? 'CHANGED' : code };
}

function revalidate(locale: string): void {
  revalidatePath(`/${locale}/brand-brain`);
}

/*
 * BOUNDARY PARSING. Server actions are reachable by a crafted POST, so every
 * field is checked here — shape and length — before a service sees it; the
 * services and the knowledge schemas check again.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) return null;
  return value;
}

function localizedInput(value: unknown, max: number): LocalizedText | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const en = text(record['en'], max);
  const ar = text(record['ar'], max);
  if (en === null || ar === null) return null;
  return { ...(en ? { en } : {}), ...(ar ? { ar } : {}) };
}

function version(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min ? value : null;
}

function hasText(text: LocalizedText): boolean {
  return Boolean(text.en?.trim() || text.ar?.trim());
}

function clean(text: LocalizedText): LocalizedText {
  return {
    ...(text.en?.trim() ? { en: text.en.trim() } : {}),
    ...(text.ar?.trim() ? { ar: text.ar.trim() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

export interface ChatAddInput {
  readonly locale: string;
  readonly brandId: string;
  /** Add & approve, or Send for review. The server decides whether it is allowed. */
  readonly intent: 'approve' | 'review';
  readonly area: string;
  readonly title: LocalizedText;
  readonly body: LocalizedText;
  /** A key question's key, when the add came from a miss in Ask or a Copilot handoff. */
  readonly itemKey?: string | undefined;
}

export async function chatAddFactAction(
  raw: ChatAddInput,
): Promise<ChatActionResult<{ readonly outcome: 'added' | 'sent' }>> {
  const title = localizedInput(raw?.title, MAX_TITLE_CHARS);
  const body = localizedInput(raw?.body, MAX_BODY_CHARS);
  if (
    !raw ||
    typeof raw.locale !== 'string' ||
    !UUID.test(String(raw.brandId)) ||
    (raw.intent !== 'approve' && raw.intent !== 'review') ||
    !title ||
    !body
  ) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  const input = { ...raw, title, body };
  try {
    const session = await requireWorkspaceAction(input.locale, 'brand_brain.edit');
    // Add & approve needs BOTH; review alone never adds (D7).
    if (input.intent === 'approve') {
      await requireWorkspaceAction(input.locale, 'brand_brain.review');
    }
    // A clear message for an ordinary mistake, never a generic failure.
    const area = areaSchema.safeParse(input.area) as
      { success: true; data: BrandKnowledgeArea } | { success: false };
    if (!area.success) return { ok: false, code: 'VALIDATION_FAILED', field: 'area' };
    if (!hasText(input.title)) return { ok: false, code: 'VALIDATION_FAILED', field: 'title' };
    if (!hasText(input.body)) return { ok: false, code: 'VALIDATION_FAILED', field: 'body' };
    const typedKey = input.itemKey ? itemKeySchema.safeParse(input.itemKey) : null;
    const itemKey = typedKey?.success === true ? typedKey.data : `chat.${randomUUID().slice(0, 8)}`;

    const outcome = await inBrandBrain(
      session.workspace.workspaceId,
      async ({ knowledge, policy }) => {
        if (input.intent === 'approve') {
          await knowledge.createItem({
            brandId: input.brandId,
            area: area.data,
            itemKey,
            title: clean(input.title),
            body: clean(input.body),
            actor: actorOf(session),
            policy: (await policy()).staleness,
          });
          return 'added' as const;
        }
        await knowledge.proposeFact({
          brandId: input.brandId,
          area: area.data,
          itemKey,
          title: clean(input.title),
          body: clean(input.body),
          actor: actorOf(session),
        });
        return 'sent' as const;
      },
    );
    revalidate(input.locale);
    return { ok: true, outcome };
  } catch (error: unknown) {
    return refused(error, 'chat-add');
  }
}

// ---------------------------------------------------------------------------
// Edit and Remove — the lookup
// ---------------------------------------------------------------------------

/** Up to three facts matching the words typed — local matching, no model, no credits. */
export async function chatFindFactsAction(raw: {
  readonly locale: string;
  readonly brandId: string;
  readonly query: string;
}): Promise<ChatActionResult<{ readonly facts: readonly ChatFact[] }>> {
  const query = typeof raw?.query === 'string' ? raw.query.trim() : '';
  if (query.length === 0 || query.length > 500) {
    return { ok: false, code: 'VALIDATION_FAILED', field: 'query' };
  }
  if (typeof raw.locale !== 'string' || !UUID.test(String(raw.brandId))) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  const parsed = { data: { locale: raw.locale, brandId: raw.brandId, query } };
  try {
    const session = await requireWorkspaceAction(parsed.data.locale, 'brand_brain.edit');
    const facts = await inBrandBrain(session.workspace.workspaceId, async ({ knowledge, db }) => {
      const asOf = await workspaceKnowledgeAsOf(db);
      const found = await knowledge.matchFacts({
        brandId: parsed.data.brandId,
        query: parsed.data.query,
        limit: 3,
        brandScope: session.workspace.brandScope,
      });
      return found.map((fact) => ({
        id: fact.id,
        area: fact.area,
        itemKey: fact.itemKey,
        version: fact.version,
        title: fact.title,
        body: fact.body,
        validUntil: fact.validUntil ? isoDateOf(fact.validUntil) : null,
        expired: isExpired(fact.validUntil, asOf),
      }));
    });
    return { ok: true, facts };
  } catch (error: unknown) {
    return refused(error, 'chat-find');
  }
}

/** One fact by id, as it is now — the fresh version after a CHANGED answer. */
async function factById(session: WorkspaceSession, itemId: string): Promise<ChatFact | null> {
  return inBrandBrain(session.workspace.workspaceId, async ({ knowledge, db }) => {
    const asOf = await workspaceKnowledgeAsOf(db);
    const [found] = await knowledge.factsById({
      itemIds: [itemId],
      brandScope: session.workspace.brandScope,
    });
    if (!found) return null;
    return {
      id: found.id,
      area: found.area,
      itemKey: found.itemKey,
      version: found.version,
      title: found.title,
      body: found.body,
      validUntil: found.validUntil ? isoDateOf(found.validUntil) : null,
      expired: isExpired(found.validUntil, asOf),
    };
  });
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

/**
 * Save the person's edit — only over the version they were shown. A fact that
 * moved on meanwhile is NOT overwritten: the answer is CHANGED with the fresh
 * version, and the person decides again.
 */
export async function chatEditFactAction(raw: {
  readonly locale: string;
  readonly itemId: string;
  readonly expectedVersion: number;
  readonly title: LocalizedText;
  readonly body: LocalizedText;
}): Promise<ChatActionResult<{ readonly fact: ChatFact | null }>> {
  const title = localizedInput(raw?.title, MAX_TITLE_CHARS);
  const body = localizedInput(raw?.body, MAX_BODY_CHARS);
  const expectedVersion = version(raw?.expectedVersion, 1);
  if (
    typeof raw?.locale !== 'string' ||
    !UUID.test(String(raw.itemId)) ||
    expectedVersion === null ||
    !title ||
    !body
  ) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  const input = { locale: raw.locale, itemId: raw.itemId, expectedVersion, title, body };
  let session: WorkspaceSession | null = null;
  try {
    session = await requireWorkspaceAction(input.locale, 'brand_brain.edit');
    if (!hasText(input.title)) return { ok: false, code: 'VALIDATION_FAILED', field: 'title' };
    if (!hasText(input.body)) return { ok: false, code: 'VALIDATION_FAILED', field: 'body' };
    const active = session;
    await inBrandBrain(active.workspace.workspaceId, async ({ knowledge, policy }) => {
      await knowledge.updateItem({
        itemId: input.itemId,
        title: clean(input.title),
        body: clean(input.body),
        expectedVersion: input.expectedVersion,
        actor: actorOf(active),
        policy: (await policy()).staleness,
      });
    });
    revalidate(input.locale);
    return { ok: true, fact: await factById(active, input.itemId) };
  } catch (error: unknown) {
    const result = refused(error, 'chat-edit');
    if (result.code === 'CHANGED' && session) {
      const fresh = await factById(session, input.itemId).catch(() => null);
      return fresh ? { ...result, fresh } : result;
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Remove and Undo
// ---------------------------------------------------------------------------

/** Archive the chosen fact. The answer carries the version Undo may restore from. */
export async function chatRemoveFactAction(raw: {
  readonly locale: string;
  readonly itemId: string;
}): Promise<ChatActionResult<{ readonly archivedVersion: number }>> {
  if (typeof raw?.locale !== 'string' || !UUID.test(String(raw.itemId))) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  const parsed = { data: { locale: raw.locale, itemId: raw.itemId } };
  try {
    const session = await requireWorkspaceAction(parsed.data.locale, 'brand_brain.edit');
    const archived = await inBrandBrain(session.workspace.workspaceId, async ({ knowledge }) =>
      knowledge.archiveItem({
        itemId: parsed.data.itemId,
        reason: 'removed_in_chat',
        actor: actorOf(session),
      }),
    );
    revalidate(parsed.data.locale);
    return { ok: true, archivedVersion: archived.version };
  } catch (error: unknown) {
    return refused(error, 'chat-remove');
  }
}

/**
 * Undo exactly the remove just made — `undoArchive` restores the version before
 * it only while the fact is still ARCHIVED at that version, atomically; a
 * second Undo, or one after somebody else's change, writes nothing.
 */
export async function chatUndoRemoveAction(raw: {
  readonly locale: string;
  readonly itemId: string;
  readonly archivedVersion: number;
}): Promise<ChatActionResult> {
  const archivedVersion = version(raw?.archivedVersion, 2);
  if (typeof raw?.locale !== 'string' || !UUID.test(String(raw.itemId)) || !archivedVersion) {
    return { ok: false, code: 'VALIDATION_FAILED' };
  }
  const parsed = { data: { locale: raw.locale, itemId: raw.itemId, archivedVersion } };
  try {
    const session = await requireWorkspaceAction(parsed.data.locale, 'brand_brain.edit');
    await inBrandBrain(session.workspace.workspaceId, async ({ knowledge, policy }) =>
      knowledge.undoArchive({
        itemId: parsed.data.itemId,
        archivedVersion: parsed.data.archivedVersion,
        actor: actorOf(session),
        policy: (await policy()).staleness,
      }),
    );
    revalidate(parsed.data.locale);
    return { ok: true };
  } catch (error: unknown) {
    return refused(error, 'chat-undo');
  }
}
