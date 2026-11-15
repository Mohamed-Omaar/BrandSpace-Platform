import {
  DEFAULT_IMAGE_SIZING,
  providerCostMicroMinor,
  resolveImageSize,
  type AdapterRegistry,
  type AiFailureClass,
  type ImageQuality,
  type ModelCostBasis,
  type UsageUnits,
} from '@brandspace/ai-gateway';
import { aiAdapterDescriptor } from '@brandspace/ai-gateway/adapters';
import { parseImageSize, type ImageSizing } from '@brandspace/ai-gateway';

/**
 * PR G (D-611) — THE SAME BRIEF ON TWO IMAGE MODELS, SIDE BY SIDE.
 *
 * An owner-only bench for choosing an image provider: one brief, one format,
 * one quality, sent to two image models at once, each through its own adapter
 * with the owner's saved key — the adapter's egress guard, host allow-list and
 * timeout apply exactly as at runtime. For each: how long it took, what the
 * provider charged by the model's entered rates, what the provider reported
 * (tokens), and the image.
 *
 * WHAT IT DOES NOT DO: no routing changes (every task keeps the model its
 * route names), no customer workspace, no credits, nothing in the Asset
 * Library, and nothing stored but the audit row (models, time, cost — never
 * the brief or the image). The images live in the page's answer only.
 *
 * Everything it needs is passed in, so the logic is tested without a network,
 * a database or a key.
 */

export interface CompareModelRow {
  readonly key: string;
  readonly providerKey: string;
  readonly modality: string;
  readonly displayName?: string | null;
  readonly imageSizing?: ImageSizing | null;
  readonly inputCostPerUnitMicroMinor: number | null;
  readonly outputCostPerUnitMicroMinor: number | null;
  readonly costUnit: ModelCostBasis['costUnit'];
  readonly costCurrency: string;
  readonly imageCostByQualityMicroMinor?: ModelCostBasis['imageCostByQualityMicroMinor'];
}

export interface CompareProviderRow {
  readonly key: string;
  readonly adapter?: string | null;
  readonly baseUrl?: string | null;
  readonly apiKeySecretRef?: string | null;
  readonly timeoutMs?: number | null;
}

export interface CompareInput {
  readonly brief: string;
  /** The format asked for, `WIDTH×HEIGHT`, resolved per model as the gateway does. */
  readonly format: string;
  readonly quality: ImageQuality;
  readonly modelKeys: readonly [string, string];
}

export interface CompareSide {
  readonly modelKey: string;
  readonly providerKey: string;
  readonly adapterKey: string | null;
  readonly sizeSent: string | null;
  readonly latencyMs: number;
  readonly ok: boolean;
  readonly failureClass: AiFailureClass | 'NOT_CONFIGURED' | null;
  /** What the provider charged by the entered rates; null when no rates are entered. */
  readonly costMicroMinor: bigint | null;
  readonly costCurrency: string;
  readonly usage: UsageUnits | null;
  /** `data:` URLs, for this answer only. */
  readonly images: readonly string[];
}

export interface CompareDependencies {
  readonly environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  readonly models: readonly CompareModelRow[];
  readonly providers: readonly CompareProviderRow[];
  readonly allowedHosts: readonly string[];
  readonly registry: AdapterRegistry;
  readonly resolveKey: (secretRef: string) => Promise<string | null>;
  readonly requestId: string;
  readonly now?: () => number;
}

/** A model may take this long at most; the page waits for the slower of the two. */
export const COMPARE_TIMEOUT_MS = 180_000;
export const COMPARE_BRIEF_MAX = 4_000;

export async function compareImageModels(
  input: CompareInput,
  deps: CompareDependencies,
): Promise<readonly [CompareSide, CompareSide]> {
  const [left, right] = await Promise.all(
    input.modelKeys.map((modelKey, index) => runOne(modelKey, index, input, deps)),
  );
  return [left!, right!];
}

async function runOne(
  modelKey: string,
  index: number,
  input: CompareInput,
  deps: CompareDependencies,
): Promise<CompareSide> {
  const now = deps.now ?? Date.now;
  const model = deps.models.find((row) => row.key === modelKey && row.modality === 'image');
  const provider = model ? deps.providers.find((row) => row.key === model.providerKey) : undefined;
  const adapterKey = provider ? (provider.adapter ?? provider.key) : null;
  const adapter = adapterKey ? deps.registry.get(adapterKey) : undefined;
  const base = {
    modelKey,
    providerKey: model?.providerKey ?? '—',
    adapterKey,
    costCurrency: model?.costCurrency ?? 'USD',
  };
  if (!model || !provider || !adapter?.generateImage) {
    return {
      ...base,
      sizeSent: null,
      latencyMs: 0,
      ok: false,
      failureClass: 'NOT_CONFIGURED',
      costMicroMinor: null,
      usage: null,
      images: [],
    };
  }
  const size = resolveImageSize(input.format, model.imageSizing ?? DEFAULT_IMAGE_SIZING);
  const apiKey = provider.apiKeySecretRef ? await deps.resolveKey(provider.apiKeySecretRef) : null;
  const timeoutMs = Math.min(provider.timeoutMs ?? COMPARE_TIMEOUT_MS, COMPARE_TIMEOUT_MS);
  const started = now();
  try {
    const result = await adapter.generateImage(
      { modelKey, prompt: input.brief, count: 1, size, quality: input.quality },
      {
        environment: deps.environment,
        apiKey,
        baseUrl:
          provider.baseUrl ?? aiAdapterDescriptor(adapterKey!)?.defaultBaseUrl ?? 'mock://local',
        timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        requestId: `${deps.requestId}-${index}`,
        allowedHosts: deps.allowedHosts,
      },
    );
    const latencyMs = now() - started;
    const dims = parseImageSize(size);
    let costMicroMinor: bigint | null = null;
    if (model.inputCostPerUnitMicroMinor !== null && model.outputCostPerUnitMicroMinor !== null) {
      costMicroMinor = providerCostMicroMinor(
        result.usage,
        {
          modelKey,
          inputCostPerUnitMicroMinor: model.inputCostPerUnitMicroMinor,
          outputCostPerUnitMicroMinor: model.outputCostPerUnitMicroMinor,
          costUnit: model.costUnit,
          costCurrency: model.costCurrency,
          ...(model.imageCostByQualityMicroMinor
            ? { imageCostByQualityMicroMinor: model.imageCostByQualityMicroMinor }
            : {}),
        } as ModelCostBasis,
        dims ? { quality: input.quality, pixels: dims.width * dims.height } : undefined,
      );
    }
    return {
      ...base,
      sizeSent: size,
      latencyMs,
      ok: true,
      failureClass: null,
      costMicroMinor,
      usage: result.usage,
      images: (result.images ?? [])
        .filter((image) => typeof image.base64 === 'string')
        .map((image) => `data:${image.mimeType ?? 'image/png'};base64,${image.base64}`),
    };
  } catch (error: unknown) {
    return {
      ...base,
      sizeSent: size,
      latencyMs: now() - started,
      ok: false,
      failureClass: adapter.classifyError(error),
      costMicroMinor: null,
      usage: null,
      images: [],
    };
  }
}

/** The audit row's reason: models, time, cost and outcome — never the brief or an image. */
export function comparisonAuditReason(
  input: Pick<CompareInput, 'format' | 'quality'>,
  sides: readonly CompareSide[],
): string {
  const side = (s: CompareSide) =>
    `${s.modelKey} (${s.providerKey}) ${s.ok ? 'ok' : (s.failureClass ?? 'failed')} ${s.latencyMs}ms` +
    ` cost ${s.costMicroMinor === null ? 'n/a' : `${s.costMicroMinor.toString()} micro-minor ${s.costCurrency}`}`;
  return `Image comparison ${input.format} ${input.quality}: ${sides.map(side).join(' | ')}`;
}
