import type { AiFailureClass } from './errors';

/**
 * The provider adapter contract — docs/AI-GATEWAY.md §3.
 *
 * Every provider implements this and nothing else changes. The pipeline in
 * `gateway.ts` never mentions a provider by name, never branches on one, and
 * never sees a provider-shaped error: adapters translate both directions.
 *
 * NOTHING HERE IMPORTS A PROVIDER SDK. A lint rule blocks such an import
 * outside this package, and this file is the reason the rule can hold — the
 * contract is expressed in terms the gateway owns.
 */

export const AI_MODALITIES = [
  'text',
  'image',
  'video',
  'voice',
  'embedding',
  'moderation',
] as const;
export type AiModality = (typeof AI_MODALITIES)[number];

/**
 * What an adapter is given for one call.
 *
 * THE CREDENTIAL IS IN MEMORY AND NOWHERE ELSE. It arrives already resolved
 * from the Secret Service; an adapter must not log it, attach it to a span, or
 * include it in an error. `AiProviderError.operatorDetail` exists so an adapter
 * has somewhere to put diagnostics that is explicitly not the customer's.
 */
export interface AdapterContext {
  readonly environment: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /**
   * Aborted when the request's deadline passes. An adapter MUST pass this to
   * its transport: a timeout the caller cannot enforce is a request that
   * outlives its reservation, which docs/AI-GATEWAY.md §6.1 forbids.
   */
  readonly signal: AbortSignal;
  readonly requestId: string;
}

/** Usage as the gateway counts it, normalised from whatever the provider reports. */
export interface UsageUnits {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly imageCount?: number;
  readonly durationSeconds?: number;
  /** For models priced per character rather than per token (voice synthesis). */
  readonly characters?: number;
}

export interface TextRequest {
  readonly modelKey: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** Untrusted context, inserted as clearly delimited data (§10.3). */
  readonly untrustedContext?: readonly string[];
}

export interface TextResult {
  readonly text: string;
  readonly usage: UsageUnits;
  /** What the provider says it used, when it differs from what was asked for. */
  readonly modelKey: string;
}

export interface ImageRequest {
  readonly modelKey: string;
  readonly prompt: string;
  readonly count: number;
  readonly size: string;
}

export interface ImageResult {
  /** Opaque references. The gateway does not persist image bytes. */
  readonly imageRefs: readonly string[];
  readonly usage: UsageUnits;
  readonly modelKey: string;
}

export interface ModerationRequest {
  readonly modelKey: string;
  readonly text: string;
}

export interface ModerationResult {
  readonly flagged: boolean;
  /** Category keys, for the operator record. Never the offending text. */
  readonly categories: readonly string[];
  readonly usage: UsageUnits;
}

export interface ConnectionTestResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  /** Safe to display. Never a credential or a raw provider error. */
  readonly message: string;
}

export interface AiProviderAdapter {
  readonly key: string;
  readonly supportedModalities: readonly AiModality[];

  testConnection(ctx: AdapterContext): Promise<ConnectionTestResult>;

  generateText?(request: TextRequest, ctx: AdapterContext): Promise<TextResult>;
  generateImage?(request: ImageRequest, ctx: AdapterContext): Promise<ImageResult>;
  moderate?(request: ModerationRequest, ctx: AdapterContext): Promise<ModerationResult>;

  /**
   * Translate a provider error into the gateway's taxonomy.
   *
   * The single place a provider's own vocabulary is allowed to matter. Every
   * decision downstream — retry, fall back, charge, what the customer reads —
   * is made from the returned class.
   */
  classifyError(error: unknown): AiFailureClass;
}

/** A registry of adapters by provider key. */
export type AdapterRegistry = ReadonlyMap<string, AiProviderAdapter>;
