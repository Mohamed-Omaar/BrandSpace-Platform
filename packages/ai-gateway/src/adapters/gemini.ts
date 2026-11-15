import { redact } from '@brandspace/shared';
import type {
  AdapterContext,
  AiModality,
  AiProviderAdapter,
  ConnectionTestResult,
  GeneratedImage,
  ImageRequest,
  ImageResult,
} from '../adapter';
import type { AiFailureClass } from '../errors';
import {
  EgressRefusedError,
  pinnedHttpsTransport,
  type EgressResponse,
  type EgressTransport,
} from '../egress';
import { ProviderContentFilteredError, ProviderShapeError, ProviderTruncatedError } from './openai';

/**
 * PR G (D-611) — GOOGLE'S GEMINI IMAGE MODELS, A SECOND IMAGE PROVIDER.
 *
 * THE ONLY FILE THAT KNOWS THIS VENDOR, as `openai.ts` is for its own. It is
 * reached through the adapter registry by its key; nothing else names it, and
 * nothing branches on it.
 *
 * WHAT IT DOES: image generation only (`models/{model}:generateContent`, the
 * image in the answer's `inlineData`). Text and moderation stay with the
 * providers that serve them today. Routing does not change: a model of this
 * provider is used only when the owner saves its key, tests it, activates an
 * `ai.models` row for it and a route names that model.
 *
 * SIZE. The gateway resolves the size a model accepts (`ai.models[].imageSizes`)
 * and sends `WIDTH×HEIGHT`. Gemini takes an aspect ratio and a size class
 * instead, so this maps one to the other: the closest ratio Google lists, and
 * 1K / 2K / 4K by the longer edge. Nothing is cropped here.
 *
 * NO SDK. Plain HTTPS through `egress.ts` — https only, the host checked and
 * pinned, redirects refused. The key goes in one header (`x-goog-api-key`) of
 * one request and is never logged, stored or put in an error; a provider's
 * error body is never copied (only its status and its machine-readable
 * status word, through `redact`).
 *
 * Model ids are configuration (`ai.models[].key`); nothing here names a model.
 */

export const GEMINI_ADAPTER_KEY = 'gemini';

export const GEMINI_DESCRIPTOR = {
  key: GEMINI_ADAPTER_KEY,
  displayName: { en: 'Google Gemini', ar: 'Gemini من Google' },
  defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  officialHosts: ['generativelanguage.googleapis.com'] as const,
  modalities: ['image'] as const satisfies readonly AiModality[],
  developmentOnly: false,
} as const;

/** The aspect ratios Google lists for its image models, as width ÷ height. */
const ASPECT_RATIOS = [
  ['1:1', 1],
  ['2:3', 2 / 3],
  ['3:2', 3 / 2],
  ['3:4', 3 / 4],
  ['4:3', 4 / 3],
  ['4:5', 4 / 5],
  ['5:4', 5 / 4],
  ['9:16', 9 / 16],
  ['16:9', 16 / 9],
  ['21:9', 21 / 9],
] as const;

/** `WIDTH×HEIGHT` (or `WIDTHxHEIGHT`) → Google's aspect ratio and size class. */
export function geminiImageConfig(size: string): { aspectRatio: string; imageSize: string } {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
  const width = match ? Number(match[1]) : 1024;
  const height = match ? Number(match[2]) : 1024;
  const ratio = width / Math.max(1, height);
  let best: (typeof ASPECT_RATIOS)[number] = ASPECT_RATIOS[0];
  for (const candidate of ASPECT_RATIOS) {
    // Compared on a log scale, so 2:1 and 1:2 are equally far from 1:1.
    if (Math.abs(Math.log(candidate[1] / ratio)) < Math.abs(Math.log(best[1] / ratio))) {
      best = candidate;
    }
  }
  const longest = Math.max(width, height);
  const imageSize = longest <= 1024 ? '1K' : longest <= 2048 ? '2K' : '4K';
  return { aspectRatio: best[0], imageSize };
}

/** A Google HTTP failure: its status and status word (`RESOURCE_EXHAUSTED`…). Never its message. */
export class GeminiHttpError extends Error {
  readonly status: number;
  readonly statusWord: string | null;
  readonly providerCode: string;
  readonly providerReason: string | undefined;
  constructor(status: number, statusWord: string | null, reason?: string) {
    super(
      String(
        redact(`The provider answered HTTP ${status}${statusWord ? ` (${statusWord})` : ''}.`),
      ),
    );
    this.name = 'GeminiHttpError';
    this.status = status;
    this.statusWord = statusWord;
    this.providerCode = statusWord ?? `http_${status}`;
    this.providerReason = reason;
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function errorFrom(response: EgressResponse): GeminiHttpError {
  const parsed = parseJson(response.body) as {
    error?: { status?: unknown; message?: unknown };
  } | null;
  const word = parsed?.error?.status;
  const message = parsed?.error?.message;
  return new GeminiHttpError(
    response.status,
    typeof word === 'string' && /^[A-Z_]{2,40}$/.test(word) ? word : null,
    typeof message === 'string' ? message.slice(0, 400) : undefined,
  );
}

/** The finish reasons Google gives when it withheld the image for safety or policy. */
const FILTERED = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'RECITATION',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

interface GenerateContentAnswer {
  candidates?: {
    finishReason?: unknown;
    content?: { parts?: { inlineData?: { mimeType?: unknown; data?: unknown } }[] };
  }[];
  promptFeedback?: { blockReason?: unknown };
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
    thoughtsTokenCount?: unknown;
  };
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;

export interface GeminiAdapterOptions {
  /** A test injects a fake-server transport; production always uses the pinned one. */
  readonly transportFor?: (allowedHosts: readonly string[]) => EgressTransport;
}

export class GeminiAdapter implements AiProviderAdapter {
  readonly key = GEMINI_ADAPTER_KEY;
  readonly supportedModalities: readonly AiModality[] = GEMINI_DESCRIPTOR.modalities;
  readonly #transportFor: (allowedHosts: readonly string[]) => EgressTransport;

  constructor(options: GeminiAdapterOptions = {}) {
    this.#transportFor = options.transportFor ?? ((hosts) => pinnedHttpsTransport(hosts));
  }

  #send(
    ctx: AdapterContext,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<EgressResponse> {
    const allowed = [...GEMINI_DESCRIPTOR.officialHosts, ...(ctx.allowedHosts ?? [])];
    const base = ctx.baseUrl.replace(/\/+$/, '');
    return this.#transportFor(allowed)({
      method,
      url: `${base}${path}`,
      headers: {
        accept: 'application/json',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(ctx.apiKey ? { 'x-goog-api-key': ctx.apiKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctx.signal,
    });
  }

  async testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      // Lists the models the key can see: no generation, no cost.
      const response = await this.#send(ctx, 'GET', '/models?pageSize=1');
      const latencyMs = Date.now() - started;
      if (response.status === 200) {
        return { ok: true, latencyMs, message: 'Connected. The provider accepted the key.' };
      }
      return {
        ok: false,
        latencyMs,
        message: testMessage(this.classifyError(errorFrom(response))),
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        message: testMessage(this.classifyError(error)),
      };
    }
  }

  /** One request per image: these models answer one image per call. */
  async generateImage(request: ImageRequest, ctx: AdapterContext): Promise<ImageResult> {
    const config = geminiImageConfig(request.size);
    const images: GeneratedImage[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    for (let index = 0; index < Math.max(1, request.count); index += 1) {
      const response = await this.#send(
        ctx,
        'POST',
        `/models/${encodeURIComponent(request.modelKey)}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: config,
          },
        },
      );
      if (response.status !== 200) throw errorFrom(response);
      const answer = parseJson(response.body) as GenerateContentAnswer | null;
      if (typeof answer?.promptFeedback?.blockReason === 'string') {
        throw new ProviderContentFilteredError();
      }
      const candidate = answer?.candidates?.[0];
      const inline = candidate?.content?.parts?.find(
        (part) => typeof part.inlineData?.data === 'string',
      )?.inlineData;
      if (!inline) {
        const reason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : '';
        if (FILTERED.has(reason)) throw new ProviderContentFilteredError();
        if (reason === 'MAX_TOKENS') throw new ProviderTruncatedError('length');
        throw new ProviderShapeError('image');
      }
      const usage = answer?.usageMetadata;
      promptTokens += count(usage?.promptTokenCount);
      // Thinking is billed as output: it is counted with the image's tokens.
      completionTokens += count(usage?.candidatesTokenCount) + count(usage?.thoughtsTokenCount);
      images.push({
        ref: `${GEMINI_ADAPTER_KEY}://image/${ctx.requestId}/${index}`,
        base64: inline.data as string,
        mimeType: typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png',
      });
    }
    return {
      imageRefs: images.map((image) => image.ref),
      images,
      usage: { imageCount: images.length, promptTokens, completionTokens },
      modelKey: request.modelKey,
    };
  }

  classifyError(error: unknown): AiFailureClass {
    if (error instanceof EgressRefusedError) return 'MODEL_UNAVAILABLE';
    if (error instanceof ProviderContentFilteredError) return 'CONTENT_FILTERED';
    if (error instanceof ProviderTruncatedError) return 'OUTPUT_TRUNCATED';
    if (error instanceof ProviderShapeError) return 'PROVIDER_UNAVAILABLE';
    if (error instanceof GeminiHttpError) {
      const word = error.statusWord ?? '';
      if (
        error.status === 401 ||
        error.status === 403 ||
        word === 'PERMISSION_DENIED' ||
        word === 'UNAUTHENTICATED' ||
        // Google answers a wrong key with 400 and says so in its message.
        (error.status === 400 && /api key/i.test(error.providerReason ?? ''))
      ) {
        return 'AUTH_ERROR';
      }
      if (error.status === 429 || word === 'RESOURCE_EXHAUSTED') {
        return /quota/i.test(error.providerReason ?? '') ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED';
      }
      if (error.status === 404 || word === 'NOT_FOUND') return 'MODEL_UNAVAILABLE';
      if (error.status === 504 || word === 'DEADLINE_EXCEEDED') return 'TIMEOUT';
      if (error.status === 400 || word === 'INVALID_ARGUMENT' || word === 'FAILED_PRECONDITION') {
        return 'INVALID_REQUEST';
      }
      if (error.status >= 500) return 'PROVIDER_UNAVAILABLE';
      return 'UNKNOWN';
    }
    if (error instanceof Error) {
      if (error.name === 'AbortError' || error.name === 'TimeoutError') return 'TIMEOUT';
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'TIMEOUT';
      if (
        [
          'ECONNRESET',
          'ECONNREFUSED',
          'ENOTFOUND',
          'EAI_AGAIN',
          'EPIPE',
          'EHOSTUNREACH',
          'ENETUNREACH',
        ].includes(code)
      ) {
        return 'NETWORK_ERROR';
      }
    }
    return 'UNKNOWN';
  }
}

/** What "Test the connection" says, from the failure class alone. */
function testMessage(failure: AiFailureClass): string {
  switch (failure) {
    case 'AUTH_ERROR':
      return 'The provider refused the key.';
    case 'MODEL_UNAVAILABLE':
      return 'The provider address is not allowed or could not be reached.';
    case 'RATE_LIMITED':
    case 'QUOTA_EXCEEDED':
      return 'The provider accepted the key but is limiting requests right now.';
    case 'TIMEOUT':
      return 'The provider did not answer in time.';
    case 'NETWORK_ERROR':
      return 'The provider could not be reached.';
    default:
      return 'The connection test failed.';
  }
}
