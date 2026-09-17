import { writeAuditEvent, type Insight, type TenantScopedClient } from '@brandspace/database';
import type { BrandKnowledgeService } from '@brandspace/brand-brain';
import {
  detectAnomalies,
  findMetric,
  type AnalyticsPeriod,
  type AnalyticsPolicy,
  type AnalyticsQueryService,
  type Anomaly,
} from '@brandspace/analytics';
import {
  assertBrandInScope,
  brandIdQueryFilter,
  systemClock,
  type Clock,
} from '@brandspace/shared';

/**
 * PERFORMANCE / LEARNING MEMORY WRITE-BACK — the path Phase 5A left unfinished.
 *
 * `docs/ROADMAP.md` recorded it plainly: "Write-back of inferred learnings —
 * D-64's return path needs analytics, which is Phase 7. The schema carries it —
 * memory layer, origin, confidence, evidence — so it is not a retrofit." This is
 * the return path.
 *
 * WHAT IT WRITES, AND WHAT IT CANNOT WRITE. It writes CANDIDATES, through
 * `BrandKnowledgeService.proposeLearning`, into the same PENDING queue a document
 * candidate lands in. It cannot write a knowledge item — there is no such call in
 * this file — and it cannot accept its own proposal, because `reviewCandidate`
 * takes an actor and a permission and this service has neither. An AI silently
 * correcting the brand is the failure D-65 exists to prevent, and the way it is
 * prevented here is that the capability does not exist.
 *
 * WHAT A LEARNING CARRIES, because D-65 requires all of it:
 *   - PROVENANCE — the insight it came from, and through it the AI request.
 *   - EVIDENCE — the metric, the value, the window, copied onto the candidate.
 *   - CONFIDENCE — per mille, derived from how strong and how repeated the signal
 *     is. Never a number a model chose.
 *   - SOURCE METRIC AND WINDOW — on the evidence, so the inference is retraceable.
 *   - INFERENCE VERSION — this file's own rule version, so a learning drawn under
 *     an older rule is identifiable rather than silently reinterpreted.
 *   - CREATED TIMESTAMP and an APPROVAL STATE — the candidate row carries both.
 *   - REPRODUCIBILITY — the same observations and the same policy produce the
 *     same learnings, because this is arithmetic and not a model call.
 *
 * IT SPENDS NO CREDITS. Not one path here reaches the gateway: a learning is
 * derived from stored numbers by the rules below. That matters beyond cost — it
 * makes the inference DETERMINISTIC, which is what lets a customer who disagrees
 * with a learning see exactly why it was proposed.
 *
 * RETENTION: the candidate is Brand Brain's, under Brand Brain's windows; the
 * insight it points at is pruned under the analytics insight window, and the
 * composite key nulls the link rather than orphaning the row (D-114).
 */

/**
 * The version of the RULES below.
 *
 * Bumped whenever a threshold or a derivation changes, and recorded on every
 * learning, so a candidate proposed last quarter can be told apart from one the
 * current rules would propose. D-65 calls this reproducibility; without a version
 * the word means nothing, because the rules that produced the claim are gone.
 */
export const LEARNING_INFERENCE_VERSION = 'learning-rules-1';

export interface LearningServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: AnalyticsPolicy;
  readonly queries: AnalyticsQueryService;
  readonly knowledge: BrandKnowledgeService;
  readonly clock?: Clock;
}

export interface ProposedLearning {
  readonly itemKey: string;
  readonly title: { ar: string; en: string };
  readonly body: { ar: string; en: string };
  readonly confidenceMilli: number;
  readonly evidence: {
    readonly inferenceVersion: string;
    readonly metricKey: string;
    readonly observedValue: string;
    readonly baselineValue: string;
    readonly deviationMilli: number;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly baselineStart: string;
    readonly baselineEnd: string;
    readonly insightId: string;
  };
}

export interface WriteBackResult {
  readonly proposed: readonly { itemKey: string; candidateId: string; created: boolean }[];
  /** Learnings the rules declined to propose, and why. Machine codes. */
  readonly skipped: readonly { itemKey: string; reason: string }[];
}

export class LearningWriteBackService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: AnalyticsPolicy;
  readonly #queries: AnalyticsQueryService;
  readonly #knowledge: BrandKnowledgeService;
  readonly #clock: Clock;

  constructor(options: LearningServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#queries = options.queries;
    this.#knowledge = options.knowledge;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Derive learnings from an insight's own period and propose them for review.
   *
   * THE INSIGHT IS THE ANCHOR, not a convenience. A learning has to point at
   * evidence a reviewer can open, and an insight already carries its evidence
   * rows with their metrics, values and windows. Deriving learnings from a
   * free-floating query would produce claims with nothing behind them.
   */
  async proposeFromInsight(input: {
    insightId: string;
    actorBrandScope: readonly string[];
  }): Promise<WriteBackResult> {
    /*
     * THE SCOPE IS IN THE `WHERE`, NOT CHECKED AFTERWARDS — D-132 and D-134.
     *
     * Reading the row first and asserting on `insight.brandId` would mean a
     * member restricted to one brand had already FETCHED another brand's
     * insight by the time they were refused. That is the post-read filter the
     * decision exists to forbid, and the shape is identical whether the row is
     * then discarded or not: the read happened.
     *
     * With the predicate in the query, an out-of-scope insight is simply not
     * found — indistinguishable from an id that never existed, which is the
     * masking CLAUDE.md §2.1 asks for.
     */
    const insight = await this.#db.insight.findFirst({
      where: {
        id: input.insightId,
        workspaceId: this.#workspaceId,
        ...brandIdQueryFilter({ brandScope: input.actorBrandScope }),
      },
    });
    if (!insight) return { proposed: [], skipped: [{ itemKey: '', reason: 'insight_not_found' }] };

    const learnings = await this.derive({
      brandId: insight.brandId,
      period: { start: insight.periodStart, end: insight.periodEnd },
      insightId: insight.id,
      actorBrandScope: input.actorBrandScope,
    });

    const proposed: { itemKey: string; candidateId: string; created: boolean }[] = [];
    for (const learning of learnings) {
      const result = await this.#knowledge.proposeLearning({
        brandId: insight.brandId,
        itemKey: learning.itemKey,
        title: learning.title,
        body: learning.body,
        confidenceMilli: learning.confidenceMilli,
        insightId: insight.id,
        evidence: learning.evidence,
        actorBrandScope: input.actorBrandScope,
      });
      proposed.push({ itemKey: learning.itemKey, ...result });
    }

    if (proposed.length > 0) {
      await writeAuditEvent(this.#db, this.#workspaceId, {
        action: 'brand_brain.learning.write_back',
        actorType: 'AUTOMATION',
        resourceType: 'Insight',
        resourceId: insight.id,
        brandId: insight.brandId,
        after: {
          proposed: proposed.length,
          created: proposed.filter((p) => p.created).length,
          inferenceVersion: LEARNING_INFERENCE_VERSION,
        },
      });
    }

    return { proposed, skipped: [] };
  }

  /**
   * THE RULES. Deterministic, auditable, and deliberately few.
   *
   * ONE RULE PER KIND OF CLAIM A NUMBER CAN HONESTLY SUPPORT:
   *
   *  1. A SUSTAINED ANOMALY in a metric is a learning about that metric. One
   *     unusual day is weather; the same direction crossing the threshold more
   *     than once in a window is a pattern, and only the second is proposed.
   *
   *  2. A PLATFORM THAT OUT-PERFORMS THE BRAND'S OWN AVERAGE by more than the
   *     configured deviation is a learning about channel mix. Note the
   *     comparison: against THIS BRAND's other platforms, never against anything
   *     outside this workspace, because there is nothing outside this workspace
   *     to compare with.
   *
   * WHAT IS DELIBERATELY NOT A RULE: anything requiring a fact we do not have.
   * "Posts do better on Tuesdays" needs a posting-time distribution this product
   * does not yet ingest; "video outperforms images" needs a content-type
   * attribution it does not yet carry. Proposing either would be the platform
   * writing a plausible sentence into a customer's brand.
   */
  async derive(input: {
    brandId: string;
    period: AnalyticsPeriod;
    insightId: string;
    actorBrandScope: readonly string[];
  }): Promise<readonly ProposedLearning[]> {
    assertBrandInScope(input.actorBrandScope, input.brandId);
    const out: ProposedLearning[] = [];
    const scope = { brandId: input.brandId };

    // --- Rule 1: a sustained anomaly ---------------------------------------
    for (const metricKey of ['engagements', 'impressions', 'reach'] as const) {
      const series = await this.#queries.series({
        scope,
        period: input.period,
        metricKey,
        brandScope: input.actorBrandScope,
      });
      const definition = findMetric(metricKey);
      /* c8 ignore next -- the keys above are catalogue keys. */
      if (!definition) continue;

      const anomalies = detectAnomalies({
        metricKey,
        unit: definition.unit,
        points: series.points,
        policy: this.#policy,
      });
      const sustained = sustainedRun(anomalies);
      if (!sustained) continue;

      out.push(this.#anomalyLearning(metricKey, sustained, input.insightId, input.period));
    }

    // --- Rule 2: a platform that out-performs this brand's own average ------
    const byProvider = await this.#queries.byProvider({
      scope,
      period: input.period,
      metricKey: 'engagements',
      brandScope: input.actorBrandScope,
    });
    const measured = byProvider.flatMap((row) => (row.value === null ? [] : [row]));
    if (measured.length >= 2) {
      const total = measured.reduce((sum, row) => sum + (row.value ?? 0n), 0n);
      const mean = total / BigInt(measured.length);
      if (mean > 0n) {
        for (const row of measured) {
          const value = row.value ?? 0n;
          const deviationMilli = Number(((value - mean) * 1000n) / mean);
          if (deviationMilli < this.#policy.anomaly.deviationThresholdMilli) continue;
          out.push({
            itemKey: `learning.channel.${row.provider.toLowerCase()}`,
            title: {
              ar: `أداء ${row.provider} أعلى من متوسط المنصات`,
              en: `${row.provider} outperforms this brand's platform average`,
            },
            body: {
              ar: `في الفترة المقاسة، حقق حساب ${row.provider} تفاعلًا أعلى من متوسط منصات هذه العلامة. المقارنة داخلية بين منصات هذه العلامة فقط.`,
              en: `Over the measured period this brand's ${row.provider} account earned more engagements than the average across its own connected platforms. The comparison is internal to this brand only.`,
            },
            confidenceMilli: confidenceFor(deviationMilli, measured.length),
            evidence: {
              inferenceVersion: LEARNING_INFERENCE_VERSION,
              metricKey: 'engagements',
              observedValue: value.toString(),
              baselineValue: mean.toString(),
              deviationMilli,
              periodStart: input.period.start.toISOString(),
              periodEnd: input.period.end.toISOString(),
              baselineStart: input.period.start.toISOString(),
              baselineEnd: input.period.end.toISOString(),
              insightId: input.insightId,
            },
          });
        }
      }
    }

    return out;
  }

  #anomalyLearning(
    metricKey: string,
    run: { anomalies: readonly Anomaly[]; direction: 'above' | 'below' },
    insightId: string,
    period: AnalyticsPeriod,
  ): ProposedLearning {
    const first = run.anomalies[0] as Anomaly;
    const last = run.anomalies[run.anomalies.length - 1] as Anomaly;
    const up = run.direction === 'above';

    return {
      itemKey: `learning.metric.${metricKey}.${run.direction}`,
      title: {
        ar: up ? `ارتفاع مستمر في ${metricKey}` : `انخفاض مستمر في ${metricKey}`,
        en: up ? `Sustained rise in ${metricKey}` : `Sustained fall in ${metricKey}`,
      },
      body: {
        ar: up
          ? `تجاوز مؤشر ${metricKey} خط الأساس المحسوب من الفترات السابقة أكثر من مرة خلال الفترة المقاسة. هذا استنتاج من بيانات هذه العلامة وحدها، ويحتاج مراجعة بشرية قبل اعتماده.`
          : `انخفض مؤشر ${metricKey} عن خط الأساس المحسوب من الفترات السابقة أكثر من مرة خلال الفترة المقاسة. هذا استنتاج من بيانات هذه العلامة وحدها، ويحتاج مراجعة بشرية قبل اعتماده.`,
        en: up
          ? `The ${metricKey} figure sat above the baseline computed from the preceding periods more than once during the measured window. This is inferred from this brand's own data alone and needs human review before it is accepted.`
          : `The ${metricKey} figure sat below the baseline computed from the preceding periods more than once during the measured window. This is inferred from this brand's own data alone and needs human review before it is accepted.`,
      },
      confidenceMilli: confidenceFor(Math.abs(last.deviationMilli), run.anomalies.length),
      evidence: {
        inferenceVersion: LEARNING_INFERENCE_VERSION,
        metricKey,
        observedValue: last.observedValue.toString(),
        baselineValue: last.baselineValue.toString(),
        deviationMilli: last.deviationMilli,
        periodStart: period.start.toISOString(),
        periodEnd: period.end.toISOString(),
        baselineStart: first.baselineStart.toISOString(),
        baselineEnd: last.baselineEnd.toISOString(),
        insightId,
      },
    };
  }

  /** Exposed so a caller can state when a write-back last ran. */
  get clock(): Clock {
    return this.#clock;
  }
}

/**
 * Two or more anomalies in the SAME direction, or nothing.
 *
 * ONE UNUSUAL DAY IS WEATHER. Proposing a learning from a single outlier would
 * fill a customer's Brand Brain queue with claims that contradict each other a
 * week later, and the queue is the one place in this product where noise costs a
 * person's attention directly.
 */
function sustainedRun(
  anomalies: readonly Anomaly[],
): { anomalies: readonly Anomaly[]; direction: 'above' | 'below' } | null {
  for (const direction of ['above', 'below'] as const) {
    const matching = anomalies.filter((anomaly) => anomaly.direction === direction);
    if (matching.length >= 2) return { anomalies: matching, direction };
  }
  return null;
}

/**
 * Confidence, per mille, from the size and the repetition of the signal.
 *
 * DERIVED, NEVER CHOSEN BY A MODEL. A confidence a model wrote is a number with
 * the shape of evidence and none of the substance. This one is a function of two
 * things a reviewer can check: how far from the baseline the observation sat, and
 * how many times it did.
 *
 * CAPPED WELL BELOW CERTAINTY. The ceiling is 800 per mille, because this is an
 * inference from a fortnight of one brand's own numbers and there is no honest
 * reading of that which reaches certainty.
 */
export function confidenceFor(deviationMilli: number, occurrences: number): number {
  const fromSize = Math.min(400, Math.round(Math.abs(deviationMilli) / 5));
  const fromRepetition = Math.min(400, occurrences * 80);
  return Math.max(100, Math.min(800, fromSize + fromRepetition));
}

/** Re-exported so callers do not reach past this module for the insight type. */
export type { Insight };
