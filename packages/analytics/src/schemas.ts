import { z } from 'zod';

/**
 * THE SHAPE A MODEL MUST ANSWER IN, and the parse that refuses anything else.
 *
 * PARSED BEFORE PERSISTED, exactly as the Content Studio parses a generation
 * (AC-11.9): a provider that returned prose instead of JSON is a retryable
 * failure, never a row. The gateway has already settled or released the credits
 * by the time this runs, so a parse failure costs the customer nothing.
 *
 * THE MODEL RETURNS CLAIMS AND CITATIONS. It does not return numbers that
 * matter: every figure a customer reads is rendered from the stored evidence
 * row, and `validateGrounding` refuses prose containing a numeral that is not in
 * the evidence. The schema is the first of those two gates.
 */

const localized = z.object({
  ar: z.string().min(1).max(1_200),
  en: z.string().min(1).max(1_200),
});

/**
 * One statement, and the evidence it rests on.
 *
 * `evidenceRefs` IS REQUIRED AND NON-EMPTY. A claim with no evidence is not a
 * claim this product makes — the schema refuses it before the grounding
 * validator even runs, so the failure is a clear parse error rather than a
 * puzzling violation.
 */
const claim = z.object({
  evidenceRefs: z.array(z.number().int().min(1).max(500)).min(1).max(12),
  text: localized,
});

export const explanationSchema = z.object({
  /** One or two sentences. The headline a customer reads first. */
  summary: localized,
  /** What the numbers show. Each rests on evidence. */
  claims: z.array(claim).min(1).max(8),
  /** Changes worth noticing, each tied to the comparison evidence behind it. */
  notableChanges: z.array(claim).max(8).default([]),
  /**
   * What to do about it. Also evidence-bound: a recommendation that cites
   * nothing is a generic marketing tip wearing this brand's name.
   */
  recommendations: z.array(claim).max(6).default([]),
});

export type ParsedExplanation = z.infer<typeof explanationSchema>;

export const strategySchema = z.object({
  summary: localized,
  /** The pillars the brand should publish around. */
  pillars: z
    .array(
      z.object({
        name: localized,
        rationale: claim,
        /** Share of output, in whole percent. Validated to sum sensibly below. */
        sharePercent: z.number().int().min(0).max(100),
      }),
    )
    .min(1)
    .max(8),
  /** Which platforms deserve which share of effort, and why. */
  channelMix: z
    .array(
      z.object({
        platformKey: z.string().min(1).max(40),
        sharePercent: z.number().int().min(0).max(100),
        rationale: claim,
      }),
    )
    .min(1)
    .max(10),
  /** Cadence and themes, week by week. */
  monthlyPlan: z
    .array(
      z.object({
        weekNumber: z.number().int().min(1).max(6),
        theme: localized,
        postsPlanned: z.number().int().min(0).max(50),
        rationale: claim,
      }),
    )
    .max(6)
    .default([]),
});

export type ParsedStrategy = z.infer<typeof strategySchema>;

export const contentGapSchema = z.object({
  summary: localized,
  gaps: z
    .array(
      z.object({
        title: localized,
        /** What is missing, resting on ABSENCE or CONTENT evidence. */
        rationale: claim,
        suggestedAction: localized,
      }),
    )
    .min(1)
    .max(8),
});

export type ParsedContentGap = z.infer<typeof contentGapSchema>;

/**
 * Parse a model response, or throw.
 *
 * STRIPS A CODE FENCE FIRST. Models wrap JSON in ``` far more often than they
 * emit anything else wrong, and failing a whole generation over three backticks
 * would charge a customer for a formatting habit.
 */
export function parseJsonResponse<S extends z.ZodTypeAny>(schema: S, raw: string): z.infer<S> {
  const trimmed = raw.trim();
  const unfenced = trimmed.startsWith('```')
    ? trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```$/, '')
        .trim()
    : trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    throw new Error('The model response was not valid JSON.');
  }
  return schema.parse(parsed) as z.infer<S>;
}

/** Every ordinal a parsed document cites, de-duplicated. */
export function citedOrdinals(claims: readonly { evidenceRefs: readonly number[] }[]): number[] {
  return [...new Set(claims.flatMap((c) => [...c.evidenceRefs]))];
}

/** Every piece of prose a parsed document contains, for the numeral check. */
export function proseOf(
  claims: readonly { text: { ar: string; en: string } }[],
  ...extra: readonly { ar: string; en: string }[]
): string {
  return [
    ...claims.map((c) => `${c.text.ar}\n${c.text.en}`),
    ...extra.map((e) => `${e.ar}\n${e.en}`),
  ].join('\n');
}
