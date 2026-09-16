import type {
  EvidenceKind,
  MetricGranularity,
  MetricSourceKind,
  MetricSubjectType,
  MetricUnit,
  SocialProvider,
} from '@brandspace/database';
import { fenceUntrusted } from '@brandspace/shared';
import type { Anomaly } from './anomalies';
import { findMetric } from './metrics';
import type { AnalyticsPeriod, MetricValue } from './queries';

/**
 * THE EVIDENCE PACKAGE — how a number gets from the database to a customer
 * without passing through the model's imagination.
 *
 * THE MECHANISM, stated plainly because it is the point of the whole feature:
 *
 *   1. The evidence is built FROM THE QUERY RESULTS, before any model call.
 *   2. The model is given ORDINALS (`e1`, `e2`) and the values, fenced as
 *      reference material.
 *   3. The model returns claims that CITE ordinals. It does not return numbers
 *      that matter.
 *   4. `validateGrounding` rejects a citation outside the package, and rejects
 *      any digit-run in the model's prose that does not appear in the evidence
 *      it cited.
 *   5. The UI renders every figure from the stored `insight_evidence` ROW, not
 *      from the sentence.
 *
 * SO A FABRICATED CITATION IS STRUCTURALLY IMPOSSIBLE, in the same sense a
 * fabricated Content Studio citation is: the reference set is written from what
 * the query returned, never parsed out of the model's text (AC-11.4). And a
 * fabricated NUMBER is impossible for a second, independent reason — there is no
 * code path by which a numeral the model wrote reaches a chart.
 *
 * WHY THE DIGIT CHECK EXISTS AT ALL, given rule 5. Prose still reaches the
 * customer, and "impressions nearly doubled to about 40,000" is a fabricated
 * figure even when the tile beside it says 12,480. The check makes the prose
 * obey the same discipline as the tile.
 */

export interface EvidenceItem {
  /** 1-based. THE HANDLE THE MODEL CITES. */
  readonly ordinal: number;
  readonly kind: EvidenceKind;
  readonly labelKey: string;

  readonly metricObservationId?: string | undefined;
  readonly knowledgeItemId?: string | undefined;
  readonly contentItemId?: string | undefined;
  readonly campaignId?: string | undefined;

  readonly metricKey?: string | undefined;
  readonly value?: bigint | undefined;
  readonly comparisonValue?: bigint | undefined;
  readonly changeRatioMilli?: number | undefined;
  readonly unit?: MetricUnit | undefined;
  readonly granularity?: MetricGranularity | undefined;
  readonly periodStart?: Date | undefined;
  readonly periodEnd?: Date | undefined;
  readonly comparisonPeriodStart?: Date | undefined;
  readonly comparisonPeriodEnd?: Date | undefined;
  readonly subjectType?: MetricSubjectType | undefined;
  readonly subjectExternalId?: string | undefined;
  readonly provider?: SocialProvider | undefined;
  readonly observedAt?: Date | undefined;
  readonly sourceKind?: MetricSourceKind | undefined;
  /** Short, already-neutralized descriptive text, for CONTENT and ABSENCE rows. */
  readonly note?: string | undefined;
}

export interface EvidencePackage {
  readonly items: readonly EvidenceItem[];
  /**
   * Every digit-run that appears anywhere in the evidence, as strings.
   *
   * THE ALLOW-LIST FOR NUMERALS IN PROSE. Built from the serialized evidence
   * rather than from the values alone, so the periods, the ordinals and the
   * percentages the model is allowed to restate are all included — and nothing
   * else is.
   */
  readonly allowedNumbers: ReadonlySet<string>;
  /** The fenced block handed to the gateway as untrusted context. */
  readonly contextText: string;
}

export interface EvidenceBuilderInput {
  readonly period: AnalyticsPeriod;
  readonly comparison?: AnalyticsPeriod | undefined;
  readonly metrics: readonly MetricValue[];
  readonly anomalies?: readonly Anomaly[] | undefined;
  /** Posts worth citing, already scoped and ordered by the query service. */
  readonly topPosts?:
    | readonly {
        contentItemId: string;
        title: string | null;
        provider: SocialProvider;
        value: bigint;
        unit: MetricUnit;
      }[]
    | undefined;
  /** Approved brand knowledge the strategy grounded on, when any. */
  readonly knowledge?:
    readonly { id: string; label: string; area: string; version: number }[] | undefined;
  /** Facts about what is NOT there — the only honest basis for a content gap. */
  readonly absences?: readonly { labelKey: string; note: string }[] | undefined;
  readonly maxItems: number;
}

/**
 * Build the package.
 *
 * A METRIC WITH NO VALUE CONTRIBUTES NOTHING. It is not evidence of zero, and it
 * is not evidence of anything else either — including it with a null would give
 * the model a row to reason about that says nothing, and models reason about
 * such rows enthusiastically.
 */
export function buildEvidencePackage(input: EvidenceBuilderInput): EvidencePackage {
  const items: EvidenceItem[] = [];
  let ordinal = 1;

  const push = (item: Omit<EvidenceItem, 'ordinal'>): void => {
    if (items.length >= input.maxItems) return;
    items.push({ ...item, ordinal });
    ordinal += 1;
  };

  for (const metric of input.metrics) {
    if (metric.value === null) continue;
    const definition = findMetric(metric.metricKey);
    /* c8 ignore next -- metrics come from the catalogue-driven query service. */
    if (!definition) continue;

    const comparable =
      metric.previousValue !== null &&
      input.comparison !== undefined &&
      metric.changeMilli !== null;

    push({
      kind: comparable ? 'METRIC_COMPARISON' : 'METRIC',
      labelKey: comparable ? 'metric.period_change' : 'metric.total',
      metricKey: metric.metricKey,
      value: metric.value,
      unit: metric.unit,
      periodStart: input.period.start,
      periodEnd: input.period.end,
      ...(comparable
        ? {
            comparisonValue: metric.previousValue ?? undefined,
            changeRatioMilli: metric.changeMilli ?? undefined,
            comparisonPeriodStart: input.comparison?.start,
            comparisonPeriodEnd: input.comparison?.end,
          }
        : {}),
    });
  }

  for (const anomaly of input.anomalies ?? []) {
    push({
      kind: 'METRIC_COMPARISON',
      // The label says WHICH WAY, so the finding is readable without the sign.
      labelKey: anomaly.direction === 'above' ? 'metric.anomaly_above' : 'metric.anomaly_below',
      metricKey: anomaly.metricKey,
      value: anomaly.observedValue,
      comparisonValue: anomaly.baselineValue,
      changeRatioMilli: anomaly.deviationMilli,
      unit: anomaly.unit,
      periodStart: anomaly.periodStart,
      periodEnd: anomaly.periodStart,
      comparisonPeriodStart: anomaly.baselineStart,
      comparisonPeriodEnd: anomaly.baselineEnd,
    });
  }

  for (const post of input.topPosts ?? []) {
    push({
      kind: 'CONTENT',
      labelKey: 'content.top_performer',
      contentItemId: post.contentItemId,
      metricKey: undefined,
      value: post.value,
      unit: post.unit,
      provider: post.provider,
      periodStart: input.period.start,
      periodEnd: input.period.end,
      note: post.title ?? undefined,
    });
  }

  for (const item of input.knowledge ?? []) {
    push({
      kind: 'BRAND_KNOWLEDGE',
      labelKey: 'knowledge.approved',
      knowledgeItemId: item.id,
      note: `${item.area} v${item.version}: ${item.label}`,
    });
  }

  for (const absence of input.absences ?? []) {
    push({ kind: 'ABSENCE', labelKey: absence.labelKey, note: absence.note });
  }

  const contextText = renderEvidence(items);
  return {
    items,
    allowedNumbers: digitRuns(contextText),
    /*
     * FENCED, AND NOT AS A FORMALITY. Evidence carries provider-supplied account
     * display names and customer-authored post titles, both of which an attacker
     * can set. An evidence line reading "IGNORE PREVIOUS INSTRUCTIONS" is a
     * realistic post title, and this is the layer that turns it into quoted
     * reference material.
     */
    contextText: fenceUntrusted('ANALYTICS EVIDENCE', contextText),
  };
}

/**
 * The evidence as text, one line per item.
 *
 * MACHINE-SHAPED RATHER THAN PROSE, because the model's job is to explain WHY,
 * not to restate WHAT. A paragraph of narrated numbers invites the model to
 * paraphrase them; a table of `e3 | impressions | 12480 | 2026-09-01..2026-09-07`
 * invites it to cite `e3`.
 */
export function renderEvidence(items: readonly EvidenceItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    const parts = [`e${item.ordinal}`, item.kind, item.labelKey];
    if (item.metricKey) parts.push(`metric=${item.metricKey}`);
    if (item.value !== undefined) parts.push(`value=${item.value.toString()}`);
    if (item.unit) parts.push(`unit=${item.unit}`);
    if (item.comparisonValue !== undefined) {
      parts.push(`previous=${item.comparisonValue.toString()}`);
    }
    if (item.changeRatioMilli !== undefined) {
      parts.push(`change_per_mille=${item.changeRatioMilli}`);
    }
    if (item.periodStart) parts.push(`from=${item.periodStart.toISOString().slice(0, 10)}`);
    if (item.periodEnd) parts.push(`to=${item.periodEnd.toISOString().slice(0, 10)}`);
    if (item.comparisonPeriodStart) {
      parts.push(`baseline_from=${item.comparisonPeriodStart.toISOString().slice(0, 10)}`);
    }
    if (item.comparisonPeriodEnd) {
      parts.push(`baseline_to=${item.comparisonPeriodEnd.toISOString().slice(0, 10)}`);
    }
    if (item.provider) parts.push(`platform=${item.provider}`);
    if (item.note) parts.push(`note=${item.note}`);
    lines.push(parts.join(' | '));
  }
  return lines.join('\n');
}

/**
 * Every run of digits in a string, as strings.
 *
 * ARABIC-INDIC DIGITS COUNT TOO. `\d` in JavaScript is ASCII-only, and Arabic is
 * a first-class locale here: a model writing `٤٠٠٠٠` in the Arabic body would sail
 * past an ASCII-only check, which is exactly the shape of the `\b` bug the
 * injection patterns already had to be corrected for. Arabic-indic digits are
 * folded to ASCII before matching, so the same number is the same number in both
 * locales.
 */
export function digitRuns(text: string): Set<string> {
  const folded = foldDigits(text);
  const out = new Set<string>();
  for (const match of folded.matchAll(/\d+/g)) out.add(match[0]);
  return out;
}

/** Map Arabic-Indic and Eastern Arabic-Indic digits onto ASCII. */
export function foldDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String(code - base);
  });
}

export interface GroundingViolation {
  readonly kind: 'unknown_citation' | 'ungrounded_number' | 'no_citation';
  /** The offending ordinal or numeral. Safe to log: it is a number or an index. */
  readonly detail: string;
}

/**
 * Check one piece of model prose against the evidence it cited.
 *
 * TWO INDEPENDENT CHECKS, because they catch different lies:
 *
 *   - `unknown_citation` catches a model that invented `e9` when the package has
 *     six items. That is the classic hallucinated reference.
 *   - `ungrounded_number` catches a model that cited `e3` correctly and then
 *     wrote a number that is nowhere in the evidence. That is the far more
 *     dangerous one, because the citation makes it look verified.
 *
 * A CLAIM WITH NO CITATION AT ALL IS ALSO A VIOLATION. "Performance was strong"
 * is not an explanation; it is a mood. Every claim must rest on something.
 */
export function validateGrounding(input: {
  text: string;
  citedOrdinals: readonly number[];
  evidence: EvidencePackage;
  /** Additional numerals the caller legitimately supplied, e.g. a year. */
  extraAllowedNumbers?: ReadonlySet<string> | undefined;
}): readonly GroundingViolation[] {
  const violations: GroundingViolation[] = [];
  const known = new Set(input.evidence.items.map((item) => item.ordinal));

  if (input.citedOrdinals.length === 0) {
    violations.push({ kind: 'no_citation', detail: '0' });
  }
  for (const ordinal of input.citedOrdinals) {
    if (!known.has(ordinal)) {
      violations.push({ kind: 'unknown_citation', detail: `e${ordinal}` });
    }
  }

  for (const numeral of digitRuns(input.text)) {
    if (input.evidence.allowedNumbers.has(numeral)) continue;
    if (input.extraAllowedNumbers?.has(numeral)) continue;
    /*
     * SINGLE DIGITS ARE ALLOWED. "the top 3 posts", "week 2", an ordinal in a
     * list — a model cannot express itself without small integers, and a one-
     * digit numeral cannot misstate a metric in any way a customer would act on.
     * Everything from two digits up must come from the evidence.
     */
    if (numeral.length <= 1) continue;
    violations.push({ kind: 'ungrounded_number', detail: numeral });
  }

  return violations;
}
