/**
 * ANALYTICS AS A STORY, NOT A WALL OF CHARTS (Phase 6 final, D-277 §34, D-293).
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly.
 *
 * Two sources, never mixed up:
 *   - MEASURED: the period-over-period change of each headline metric, as the
 *     analytics queries computed it. No model is involved; the sentence is a
 *     template around numbers the reader can check on the cards below.
 *   - EXPLAINED: a stored ANALYTICS_EXPLANATION insight, whose every claim was
 *     checked against its cited evidence rows before it was saved
 *     (`packages/analytics/src/insights.ts`). Its `notableChanges`, `claims`
 *     and `recommendations` become What changed, Why it might matter and What
 *     can we try — each with the evidence ordinals it rests on.
 * Nothing here claims a CAUSE: the page says the explanation is a correlation
 * over the measured period.
 */

export interface Bilingual {
  readonly ar: string;
  readonly en: string;
}

export interface CitedLine {
  readonly text: Bilingual;
  readonly evidenceRefs: readonly number[];
}

export interface Explanation {
  readonly summary: Bilingual | null;
  readonly notableChanges: readonly CitedLine[];
  readonly claims: readonly CitedLine[];
  readonly recommendations: readonly CitedLine[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function bilingual(value: unknown): Bilingual | null {
  const row = record(value);
  if (!row) return null;
  const ar = typeof row['ar'] === 'string' ? row['ar'].trim() : '';
  const en = typeof row['en'] === 'string' ? row['en'].trim() : '';
  return ar === '' && en === '' ? null : { ar, en };
}

function cited(value: unknown): CitedLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    const text = bilingual(row?.['text']);
    if (!text) return [];
    const refs = Array.isArray(row?.['evidenceRefs'])
      ? (row['evidenceRefs'] as unknown[]).filter(
          (ref): ref is number => typeof ref === 'number' && Number.isInteger(ref) && ref > 0,
        )
      : [];
    return [{ text, evidenceRefs: refs }];
  });
}

/** A stored explanation body, narrowed; anything malformed is dropped. */
export function parseExplanation(body: unknown): Explanation {
  const row = record(body);
  return {
    summary: bilingual(row?.['summary']),
    notableChanges: cited(row?.['notableChanges']),
    claims: cited(row?.['claims']),
    recommendations: cited(row?.['recommendations']),
  };
}

export function pickText(value: Bilingual | null | undefined, locale: string): string {
  if (!value) return '';
  return locale === 'ar' ? value.ar || value.en : value.en || value.ar;
}

export interface MeasuredMetric {
  readonly metricKey: string;
  /** Change against the comparison period, in parts per mille; null when not comparable. */
  readonly changeMilli: number | null;
}

/**
 * The headline metrics that moved, largest movement first — only those that
 * moved by at least `minimumMilli` (default 5%), at most `limit`. A metric
 * that cannot be compared is not a change, and a sliver of noise is not news.
 */
export function measuredChanges(
  metrics: readonly MeasuredMetric[],
  options: { readonly minimumMilli?: number; readonly limit?: number } = {},
): { metricKey: string; changeMilli: number }[] {
  const minimum = options.minimumMilli ?? 50;
  return metrics
    .flatMap((metric) =>
      metric.changeMilli !== null && Math.abs(metric.changeMilli) >= minimum
        ? [{ metricKey: metric.metricKey, changeMilli: metric.changeMilli }]
        : [],
    )
    .sort((a, b) => Math.abs(b.changeMilli) - Math.abs(a.changeMilli))
    .slice(0, options.limit ?? 2);
}
