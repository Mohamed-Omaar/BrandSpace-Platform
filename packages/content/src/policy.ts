import { z } from 'zod';

/**
 * The Content Studio policy, as the service sees it.
 *
 * EVERY VALUE HERE ARRIVES FROM THE ACTIVATED `content` CONFIGURATION DOMAIN.
 * Nothing in this package may carry a dialect, a platform, a character limit or
 * a retention window of its own — CLAUDE.md §2.2 — and the shape below exists
 * so a caller that forgot to load configuration fails at the boundary rather
 * than silently generating against a developer's guess.
 *
 * The parser is deliberately separate from `packages/config`'s schema: that one
 * validates what an OPERATOR may save, this one validates what a SERVICE may
 * run on. They agree today because a test asserts they do, and keeping them
 * separate is what stops the service growing a dependency on the admin surface.
 */

export const dialectSchema = z.object({
  key: z.string().min(1),
  labelKey: z.string().min(1),
  bcp47: z.string().min(2),
});

export const platformSchema = z.object({
  key: z.string().min(1),
  labelKey: z.string().min(1),
  maxBodyChars: z.number().int().positive(),
  maxHashtags: z.number().int().min(0),
  allowsFirstComment: z.boolean(),
  /** PHASE 8 — media items this platform accepts on one post. Zero is legal. */
  maxMediaItems: z.number().int().min(0),
});

export const contentPolicySchema = z.object({
  dialects: z.object({
    defaultKey: z.string().min(1),
    supported: z.array(dialectSchema).min(1),
  }),
  platforms: z.array(platformSchema).min(1),
  generation: z.object({
    maxVariantsPerRequest: z.number().int().min(1),
    maxDraftsPerBrand: z.number().int().positive(),
    maxContextItems: z.number().int().min(1),
    maxContextChunks: z.number().int().min(0),
    maxContextChars: z.number().int().min(1),
    maxBriefChars: z.number().int().min(1),
  }),
  retention: z.object({
    cancellationGraceDays: z.number().int().min(1),
    minCustomerRetentionDays: z.number().int().min(1),
  }),
  calendar: z.object({
    weekStartsOn: z.number().int().min(0).max(6),
    maxDaysAhead: z.number().int().min(1),
    minLeadMinutes: z.number().int().min(0),
    maxSlotsPerDay: z.number().int().min(1),
    requireApprovalBeforeScheduling: z.boolean(),
  }),
  approvals: z.object({
    requireApprovalBeforeScheduling: z.boolean(),
    allowSelfApproval: z.boolean(),
    /** Reserved and inert — D-62 supersedes D-121. See `ResolvedApprovalPolicy`. */
    clientApprovalEnabled: z.literal(false),
    maxNoteLength: z.number().int().min(1),
    maxCyclesPerItem: z.number().int().min(1),
  }),
  /** D-295/D-296 — thresholds for noticed preferences and repeated workflows. */
  learning: z
    .object({
      preferenceMinObservations: z.number().int().min(2).default(4),
      preferenceMinPosts: z.number().int().min(2).default(3),
      workflowMinRepeats: z.number().int().min(2).default(4),
      windowDays: z.number().int().min(7).default(90),
      snoozeDays: z.number().int().min(1).default(30),
    })
    .default({
      preferenceMinObservations: 4,
      preferenceMinPosts: 3,
      workflowMinRepeats: 4,
      windowDays: 90,
      snoozeDays: 30,
    }),
});

export type ContentDialect = z.infer<typeof dialectSchema>;
export type ContentPlatform = z.infer<typeof platformSchema>;
export type ContentPolicy = z.infer<typeof contentPolicySchema>;

/**
 * Parse an activated `content` payload into a policy the service can run on.
 *
 * Throws rather than defaulting. A generation that silently ran against
 * fabricated limits would produce a caption nobody bounded and a retention
 * window nobody approved.
 */
export function parseContentPolicy(payload: unknown): ContentPolicy {
  return contentPolicySchema.parse(payload);
}

/**
 * D-115. Resolve the dialect a generation writes in: brand → workspace → the
 * activated default.
 *
 * THE ORDER IS THE DECISION, AND SO IS THE FALLBACK. A brand that has set a
 * dialect speaks it; a brand that has not inherits its workspace; a workspace
 * that has not configured one gets the activated default, which ships as MSA.
 * There is no branch in which a dialect appears that nobody chose, and in
 * particular there is no branch that reaches for Saudi because the platform
 * happens to be sold there — the owner's decision is explicit about that, and
 * this function is where it would otherwise have crept in.
 *
 * An unrecognised key — one an operator removed from `supported` after a
 * workspace had chosen it — falls back rather than throwing. A brand whose
 * dialect was retired should keep writing in readable Arabic, not stop writing.
 */
export function resolveDialect(
  policy: ContentPolicy,
  input: { brandDialect?: string | null; workspaceDialect?: string | null },
): ContentDialect {
  const supported = policy.dialects.supported;
  const byKey = (key: string | null | undefined): ContentDialect | undefined =>
    key ? supported.find((d) => d.key === key) : undefined;

  const chosen = byKey(input.brandDialect) ?? byKey(input.workspaceDialect);
  if (chosen) return chosen;

  const fallback = byKey(policy.dialects.defaultKey);
  /* c8 ignore next -- the config schema refines defaultKey into `supported`. */
  if (!fallback) throw new Error('The activated content policy has no usable default dialect.');
  return fallback;
}

/** Look a platform up, or undefined when it is not one the operator offers. */
export function findPlatform(
  policy: ContentPolicy,
  platformKey: string,
): ContentPlatform | undefined {
  return policy.platforms.find((p) => p.key === platformKey);
}
