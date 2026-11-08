import { CONFIG_DOMAINS } from './domains';
import type { ValidationIssue } from './validation';

/**
 * PR 3 (F-113) — THE D-15 MARGIN CHECK, AT ACTIVATION.
 *
 * `assessMargin` in `@brandspace/ai-gateway` answers the question for one
 * charge, and nothing asked it: activating a credit price or a model rate never
 * compared the two. This package may not import the gateway (the dependency
 * runs the other way), so the comparison is made here, with the same
 * arithmetic, and reported as a WARNING (owner, 2026-11-08): a price below the
 * target, or below cost, is shown before activation and does not block it.
 *
 * WORST CASE, STATED. Each credit row names the input it assumes
 * (`marginInputTokens`, or `marginImagePixels` for an image model priced per
 * quality); the output is the route's own `maxOutputTokens`, the most the
 * gateway will ever ask a model for. Nothing is assumed in code: a row whose
 * worst case is not stated is reported as unchecked.
 */

type Quality = 'low' | 'medium' | 'high';
const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];
/** The provider's reference image: per-quality rates are per 1024×1024. */
const REFERENCE_IMAGE_PIXELS = 1024 * 1024;

interface CostRow {
  readonly taskKey: string;
  readonly modelKey: string;
  readonly baseMilliCredits: number;
  readonly perUnitMilliCredits: number;
  readonly unit: string;
  readonly imageQuality: Quality | null;
  readonly marginInputTokens: number | null;
  readonly marginImagePixels: number | null;
}

interface CreditRules {
  readonly costs: readonly CostRow[];
  readonly targetGrossMarginPercent: number | null;
  readonly minimumGrossMarginPercent: number;
  readonly creditValueMicroMinor: number | null;
  readonly referenceCurrency: string;
}

interface Model {
  readonly key: string;
  readonly modality: string;
  readonly costUnit: string;
  readonly costCurrency: string;
  readonly inputCostPerUnitMicroMinor: number | null;
  readonly outputCostPerUnitMicroMinor: number | null;
  readonly imageCostByQualityMicroMinor: Readonly<Record<Quality, number>> | null;
}

interface RoutingRule {
  readonly taskKey: string;
  readonly parameters: { readonly maxOutputTokens: number };
}

function parsed<T>(domain: 'ai.credit-rules' | 'ai.models' | 'ai.routing', payload: unknown) {
  if (payload === undefined) return null;
  const result = CONFIG_DOMAINS[domain].schema.safeParse(payload);
  return result.success ? (result.data as T) : null;
}

/** The output ceiling the gateway sends for a task: the largest of its rules. */
function outputTokensFor(taskKey: string, rules: readonly RoutingRule[]): number {
  const own = rules.filter((r) => r.taskKey === taskKey).map((r) => r.parameters.maxOutputTokens);
  if (own.length > 0) return Math.max(...own);
  // No rule for the task: the schema's own default, never a number typed here.
  const fallback = CONFIG_DOMAINS['ai.routing'].schema.parse({
    rules: [{ taskKey, primaryModelKey: '-' }],
  }) as { rules: RoutingRule[] };
  return fallback.rules[0]!.parameters.maxOutputTokens;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Money for a message, in the reference currency's major unit. */
function money(microMinor: bigint, currency: string): string {
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    // An unknown code keeps two decimals; the schema already checked its length.
  }
  const major = Number(microMinor) / 1_000_000 / 10 ** digits;
  return `${major.toFixed(4)} ${currency}`;
}

interface WorstCase {
  readonly costMicroMinor: bigint;
  readonly assumed: string;
}

/** The dearest action this row can price, or why it cannot be checked. */
function worstCase(
  row: CostRow,
  index: number,
  costs: readonly CostRow[],
  model: Model,
  rules: readonly RoutingRule[],
): WorstCase | { readonly unchecked: string } | null {
  if (model.imageCostByQualityMicroMinor && model.costUnit === 'image') {
    if (row.marginImagePixels === null) {
      return { unchecked: 'state "marginImagePixels", the largest image this row is sent at' };
    }
    // A row with no quality prices every quality no other row names.
    const qualities = row.imageQuality
      ? [row.imageQuality]
      : QUALITIES.filter(
          (q) =>
            !costs.some(
              (other, j) =>
                j !== index &&
                other.taskKey === row.taskKey &&
                other.modelKey === row.modelKey &&
                other.imageQuality === q,
            ),
        );
    if (qualities.length === 0) return null;
    const dearest = qualities.reduce((a, b) =>
      model.imageCostByQualityMicroMinor![b] > model.imageCostByQualityMicroMinor![a] ? b : a,
    );
    const rate = BigInt(model.imageCostByQualityMicroMinor[dearest]);
    return {
      costMicroMinor: ceilDiv(rate * BigInt(row.marginImagePixels), BigInt(REFERENCE_IMAGE_PIXELS)),
      assumed: `one ${dearest}-quality image at ${row.marginImagePixels.toLocaleString('en')} pixels`,
    };
  }
  if (model.inputCostPerUnitMicroMinor === null || model.outputCostPerUnitMicroMinor === null) {
    return null; // No cost basis: reported by the catalogue's own checks.
  }
  if (model.costUnit === '1k_tokens') {
    if (row.marginInputTokens === null) {
      return { unchecked: 'state "marginInputTokens", the largest input one request sends' };
    }
    const output = outputTokensFor(row.taskKey, rules);
    return {
      costMicroMinor: ceilDiv(
        BigInt(row.marginInputTokens) * BigInt(model.inputCostPerUnitMicroMinor) +
          BigInt(output) * BigInt(model.outputCostPerUnitMicroMinor),
        1000n,
      ),
      assumed: `${row.marginInputTokens.toLocaleString('en')} input and ${output.toLocaleString('en')} output tokens`,
    };
  }
  if (model.costUnit === 'image' || model.costUnit === 'request') {
    // One image, or one request, at the single per-unit rate.
    return {
      costMicroMinor: BigInt(model.outputCostPerUnitMicroMinor),
      assumed: `one ${model.costUnit}`,
    };
  }
  return null; // Per second or per character: no stated bound to check against.
}

/**
 * The D-15 warnings for a set of documents. `pathOf` names where a warning
 * points: the row itself when the credit rules are being activated, the row by
 * its address in the other domain's report otherwise.
 */
export function marginWarnings(
  creditRulesPayload: unknown,
  modelsPayload: unknown,
  routingPayload: unknown,
  pathOf: (rowIndex: number) => string,
): ValidationIssue[] {
  const rules = parsed<CreditRules>('ai.credit-rules', creditRulesPayload);
  const catalogue = parsed<{ models: Model[] }>('ai.models', modelsPayload);
  if (!rules || !catalogue || rules.costs.length === 0) return [];
  const routing = parsed<{ rules: RoutingRule[] }>('ai.routing', routingPayload)?.rules ?? [];

  if (rules.creditValueMicroMinor === null) {
    return [
      {
        severity: 'warning',
        path: pathOf(-1),
        message:
          'Margins are not checked: "creditValueMicroMinor" is not set, so a credit has no price to compare with a model’s cost (D-15).',
      },
    ];
  }
  const target = rules.targetGrossMarginPercent ?? rules.minimumGrossMarginPercent;
  const creditValue = BigInt(rules.creditValueMicroMinor);
  const currency = rules.referenceCurrency;
  const issues: ValidationIssue[] = [];

  for (const [i, row] of rules.costs.entries()) {
    const model = catalogue.models.find((m) => m.key === row.modelKey);
    if (!model || model.costCurrency !== currency) continue; // No conversion exists.
    // Only a flat price per action has a revenue to compare (F-109 warns otherwise).
    if (row.unit !== 'request' || row.perUnitMilliCredits !== 0) continue;
    const worst = worstCase(row, i, rules.costs, model, routing);
    if (worst === null) continue;
    const label = `${row.taskKey} on ${row.modelKey}${row.imageQuality ? ` (${row.imageQuality})` : ''}`;
    if ('unchecked' in worst) {
      issues.push({
        severity: 'warning',
        path: pathOf(i),
        message: `The margin of ${label} is not checked: ${worst.unchecked} (D-15).`,
      });
      continue;
    }
    const revenue = (BigInt(row.baseMilliCredits) * creditValue) / 1000n;
    const margin =
      revenue > 0n ? Number(((revenue - worst.costMicroMinor) * 10_000n) / revenue) / 100 : -100;
    if (margin >= target && margin >= 0) continue;
    const prices = `cost ${money(worst.costMicroMinor, currency)} against a price of ${money(revenue, currency)}, at ${worst.assumed}`;
    issues.push({
      severity: 'warning',
      path: pathOf(i),
      message:
        margin < 0
          ? `${label} SELLS BELOW COST at its worst case: ${prices}. Raise the price or lower the stated worst case.`
          : `${label} earns ${margin.toFixed(1)}% gross margin at its worst case, below the ${target}% target (D-15): ${prices}.`,
    });
  }
  return issues;
}
