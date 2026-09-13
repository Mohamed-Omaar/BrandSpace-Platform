import { z } from 'zod';
import { BRAND_KNOWLEDGE_AREAS } from './areas';

/**
 * The validation boundary — CLAUDE.md §5: "Parse, don't validate ad hoc."
 *
 * Everything that arrives from a browser, a form action or an ingestion payload
 * passes through here before it reaches a service. Two things in particular are
 * parsed rather than trusted:
 *
 *   - LOCALIZED TEXT. Stored as `{ ar, en }` JSON, so without a schema a caller
 *     could put anything in a Json column, including a nested object that later
 *     renders as "[object Object]" in a customer's brand guidelines.
 *   - LENGTHS. Brand Brain text ends up inside an AI context window. Unbounded
 *     input is a cost problem before it is a correctness one.
 */

/** Upper bounds. Generous for real brand copy, finite for a context window. */
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 8_000;
export const MAX_REASON_CHARS = 500;
export const MAX_CHAT_MESSAGE_CHARS = 2_000;

const trimmed = (max: number) => z.string().trim().max(max);

/**
 * Localized text. At least ONE locale must carry content — a row with neither
 * is not knowledge, and admitting it would let an empty item count toward
 * completion.
 */
export const localizedTextSchema = (max: number) =>
  z
    .object({
      en: trimmed(max).optional(),
      ar: trimmed(max).optional(),
    })
    .refine((v) => Boolean(v.en?.length) || Boolean(v.ar?.length), {
      message: 'At least one locale must be provided.',
    });

export type LocalizedText = { readonly en?: string | undefined; readonly ar?: string | undefined };

export const areaSchema = z.enum(BRAND_KNOWLEDGE_AREAS as unknown as [string, ...string[]]);

/**
 * An item key. Lowercase dotted segments, so it is stable, greppable and safe
 * to put in a URL. Deliberately NOT free text: the key is what makes an edit an
 * edit rather than a duplicate, and a key with a space in it would produce two
 * items nobody can reconcile.
 */
export const itemKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/,
    'An item key is lowercase alphanumeric segments separated by . _ or -',
  );

export const createKnowledgeItemSchema = z.object({
  brandId: z.string().uuid(),
  area: areaSchema,
  itemKey: itemKeySchema,
  title: localizedTextSchema(MAX_TITLE_CHARS),
  body: localizedTextSchema(MAX_BODY_CHARS),
});

export const updateKnowledgeItemSchema = z.object({
  itemId: z.string().uuid(),
  title: localizedTextSchema(MAX_TITLE_CHARS),
  body: localizedTextSchema(MAX_BODY_CHARS),
  changeReason: trimmed(MAX_REASON_CHARS).optional(),
});

export const reviewCandidateSchema = z
  .object({
    candidateId: z.string().uuid(),
    decision: z.enum(['accept', 'accept_edited', 'reject']),
    /** Present only for `accept_edited`; refused otherwise by the refinement. */
    title: localizedTextSchema(MAX_TITLE_CHARS).optional(),
    body: localizedTextSchema(MAX_BODY_CHARS).optional(),
    reason: trimmed(MAX_REASON_CHARS).optional(),
  })
  .refine((v) => (v.decision === 'accept_edited' ? Boolean(v.title && v.body) : true), {
    message: 'An edited acceptance must carry the edited title and body.',
  })
  .refine(
    // An edit smuggled in alongside a plain accept would be applied silently,
    // and the review record would then say "accepted as extracted" about text a
    // reviewer had changed. Refused rather than ignored.
    (v) => (v.decision !== 'accept_edited' ? !v.title && !v.body : true),
    { message: 'Only an edited acceptance may carry a title or body.' },
  );

export const rollbackSchema = z.object({
  itemId: z.string().uuid(),
  toVersion: z.number().int().min(1),
  reason: trimmed(MAX_REASON_CHARS).optional(),
});

export const chatMessageSchema = z.object({
  brandId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  area: areaSchema.optional(),
  message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS),
  /**
   * Client-supplied, so a retry of a send that timed out replays instead of
   * billing twice. Bounded and pattern-checked because it reaches a unique
   * index.
   */
  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(120)
    .regex(/^[A-Za-z0-9._:-]+$/),
});

export const paginationSchema = z.object({
  /** Opaque cursor — the id of the last row of the previous page. */
  cursor: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export type CreateKnowledgeItemInput = z.infer<typeof createKnowledgeItemSchema>;
export type UpdateKnowledgeItemInput = z.infer<typeof updateKnowledgeItemSchema>;
export type ReviewCandidateInput = z.infer<typeof reviewCandidateSchema>;
export type RollbackInput = z.infer<typeof rollbackSchema>;
export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
