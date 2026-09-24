import { contentGapSchema, explanationSchema } from '@brandspace/analytics';

/**
 * AN INSIGHT, AS THREE ANSWERS — "what happened", "why", "what next" (P6-11).
 *
 * Marketing Intelligence rendered an insight's title and its evidence rows and
 * never its body, so every explanation the product paid a provider to write was
 * stored and unseen. The body is exactly the three answers the brief asks the
 * experience to give — a summary, claims about what the numbers show, and
 * recommendations — each already tied to the evidence rows it rests on.
 *
 * A TYPED ADAPTER AT THE PROP BOUNDARY (CLAUDE.md §4.1). The stored body is
 * `Json`, written by a model and parsed once on the way in; it is parsed AGAIN
 * here, against the same schema, before a word of it reaches a screen. A row
 * that no longer parses — an older shape, a hand-edited value — yields `null`
 * and the page shows the evidence alone, rather than rendering a partial object
 * as though it were whole.
 *
 * A CITATION TO EVIDENCE THAT IS NOT THERE IS DROPPED, not rendered. The page
 * reads a bounded number of evidence rows, and `e7` beside a claim when the
 * reader can see only `e1`–`e6` would be a reference they cannot follow.
 * Grounding was validated at generation (`validateGrounding`); this is the
 * display-side half of the same promise.
 *
 * PURE, AND NOT `server-only` — a rule module the unit suite imports directly.
 */

export interface NarrativeLine {
  readonly text: string;
  /** The evidence ordinals this line rests on, filtered to the ones shown. */
  readonly evidence: readonly number[];
}

export interface InsightNarrative {
  /** Why — the headline interpretation, in one or two sentences. */
  readonly why: string;
  /** What happened — each claim a statement about the measured evidence. */
  readonly happened: readonly NarrativeLine[];
  /** What next — recommendations or suggested actions, each still cited. */
  readonly next: readonly NarrativeLine[];
}

type Localized = { readonly ar: string; readonly en: string };

function pick(text: Localized, locale: string): string {
  return locale === 'ar' ? text.ar : text.en;
}

/**
 * Parse an insight's stored body into its three answers, or return null.
 *
 * Only the two types whose body this product defines are narrated.
 * `STRATEGY` and `MONTHLY_PLAN` are plans rather than findings and belong to
 * `/strategy`; `ANOMALY`, `RECOMMENDATION` and `OPPORTUNITY` have no generator
 * today, so there is no body shape to trust and none is guessed.
 */
export function insightNarrative(input: {
  readonly type: string;
  readonly body: unknown;
  readonly locale: string;
  /** The ordinals of the evidence rows the reader can actually see. */
  readonly shownEvidence: readonly number[];
}): InsightNarrative | null {
  const shown = new Set(input.shownEvidence);
  const cite = (refs: readonly number[]): number[] =>
    [...new Set(refs)].filter((ref) => shown.has(ref)).sort((a, b) => a - b);

  if (input.type === 'ANALYTICS_EXPLANATION') {
    const parsed = explanationSchema.safeParse(input.body);
    if (!parsed.success) return null;
    const body = parsed.data;
    return {
      why: pick(body.summary, input.locale),
      happened: [...body.claims, ...body.notableChanges].map((claim) => ({
        text: pick(claim.text, input.locale),
        evidence: cite(claim.evidenceRefs),
      })),
      next: body.recommendations.map((claim) => ({
        text: pick(claim.text, input.locale),
        evidence: cite(claim.evidenceRefs),
      })),
    };
  }

  if (input.type === 'CONTENT_GAP') {
    const parsed = contentGapSchema.safeParse(input.body);
    if (!parsed.success) return null;
    const body = parsed.data;
    return {
      why: pick(body.summary, input.locale),
      // A gap's title and rationale are what the data shows is missing; the
      // suggested action is what to do about it. Both carry the rationale's
      // citations, because the action rests on the same absence.
      happened: body.gaps.map((gap) => ({
        text: `${pick(gap.title, input.locale)} — ${pick(gap.rationale.text, input.locale)}`,
        evidence: cite(gap.rationale.evidenceRefs),
      })),
      next: body.gaps.map((gap) => ({
        text: pick(gap.suggestedAction, input.locale),
        evidence: cite(gap.rationale.evidenceRefs),
      })),
    };
  }

  return null;
}
