import { z } from 'zod';
import { CONTENT_TOOLS } from './studio';

/**
 * The wire contract between the dashboard and `apps/api`.
 *
 * CLAUDE.md §5: every external input is parsed at the boundary. These bodies
 * arrive from a browser, so nothing in them is trusted — and in particular
 * there is NO `workspaceId` field on any of them. The workspace is resolved
 * from the caller's session; a body that named another tenant would simply have
 * no field to name it in.
 *
 * The bounds here are shape bounds, not policy: how long a brief may be and how
 * many channels a generation may fan out to are the ACTIVATED CONFIGURATION's
 * to decide, and the service enforces them. These limits exist so a
 * ten-megabyte body is refused before it reaches a database round trip.
 */

const uuid = z.string().uuid();

/** A generous shape ceiling. The real limit is `content.generation.maxBriefChars`. */
const BRIEF_SHAPE_LIMIT = 20_000;

export const contentQuoteRequestSchema = z.object({
  brandId: uuid,
  brief: z.string().min(1).max(BRIEF_SHAPE_LIMIT),
  platformKeys: z.array(z.string().min(1).max(64)).min(1).max(16),
});

export const contentGenerateRequestSchema = contentQuoteRequestSchema.extend({
  locale: z.enum(['AR', 'EN']),
  /*
   * The SAME closed set the database enum declares. Spelt out rather than
   * derived from Prisma's generated type so an enum value added to the schema
   * does not silently become accepted on the wire before anything renders it.
   */
  contentType: z
    .enum(['POST', 'CAROUSEL', 'STORY', 'REEL', 'VIDEO', 'ARTICLE', 'THREAD'])
    .optional(),
  idempotencyKey: z.string().min(8).max(200),
});

export const contentToolRequestSchema = z.object({
  variantId: uuid,
  tool: z.enum(CONTENT_TOOLS),
  /** For `tone`, the requested tone. Free text the customer typed, bounded. */
  argument: z.string().min(1).max(120).optional(),
  targetLocale: z.enum(['AR', 'EN']).optional(),
  idempotencyKey: z.string().min(8).max(200),
});

export type ContentQuoteRequest = z.infer<typeof contentQuoteRequestSchema>;
export type ContentGenerateRequest = z.infer<typeof contentGenerateRequestSchema>;
export type ContentToolRequest = z.infer<typeof contentToolRequestSchema>;
