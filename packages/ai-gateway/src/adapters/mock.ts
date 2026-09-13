import { createHash } from 'node:crypto';

import type {
  AdapterContext,
  AiModality,
  AiProviderAdapter,
  ConnectionTestResult,
  ImageRequest,
  ImageResult,
  ModerationRequest,
  ModerationResult,
  TextRequest,
  TextResult,
} from '../adapter';
import { AiProviderError, customerMessageFor, type AiFailureClass } from '../errors';

/**
 * The Mock provider — docs/AI-GATEWAY.md §3.2.
 *
 * A first-class, always-present adapter. It exists so the whole reserve →
 * execute → settle path, the ledger, routing, retries and fallback can be
 * proven END TO END before any real provider credential exists — and so those
 * proofs stay cheap enough to run on every commit.
 *
 * THREE PROPERTIES MAKE IT USEFUL, AND ALL THREE ARE DELIBERATE.
 *
 * 1. DETERMINISM. Output, token counts and latency are derived from a hash of
 *    (seed, model, request). The same request always produces the same usage,
 *    so an assertion about a credit charge is an assertion about the pricing
 *    rules and not about what the mock happened to return this time.
 *
 * 2. INSTRUCTABLE FAILURE. A test can say "the primary model fails with
 *    PROVIDER_UNAVAILABLE twice, then succeeds" and observe whether the gateway
 *    retried, fell back, and — the part that matters — whether the customer was
 *    charged for the attempts that failed. Failures that cannot be summoned on
 *    demand are failures nobody has tested.
 *
 * 3. DIRECTIVES COME FROM THE TEST, NEVER FROM THE PROMPT. `program()` is the
 *    only way to change behaviour. Nothing in a prompt, in `untrustedContext`,
 *    or in a model key is ever interpreted as an instruction: a mock that could
 *    be steered by request content would be a prompt-injection surface
 *    reachable by any customer in any environment where the mock is enabled.
 */

/** What the mock should do for the next matching call. Set by tests only. */
export interface MockDirective {
  /** Scope to one model. Omitted means every model — needed for fallback tests. */
  readonly modelKey?: string;
  /** Throw this class instead of responding. */
  readonly failWith?: AiFailureClass;
  /** Wait this long first. Honours the abort signal, so timeouts are real. */
  readonly delayMs?: number;
  /** How many matching calls this applies to. Default 1. */
  readonly times?: number;
}

export interface MockAdapterOptions {
  /** Changes every derived value. Two seeds give two stable universes. */
  readonly seed?: string;
  /** Baseline simulated latency for every call. Default 0, so tests are fast. */
  readonly latencyMs?: number;
  /**
   * Moderation flags text containing one of these. Empty means never flagged.
   * This reads request CONTENT, which is what a moderation call is for; it is
   * not a behaviour directive and cannot make the adapter fail or stall.
   */
  readonly flaggedPhrases?: readonly string[];
  /**
   * Compose the answer out of the supplied reference material instead of the
   * bland placeholder words. OFF by default, and NEVER enabled in production.
   *
   * WHY IT EXISTS. Without a real provider — D-13 approved the architecture and
   * deferred vendor selection — a developer or an end-to-end run has no way to
   * see what a grounded answer looks like. The placeholder words are right for a
   * pricing test and useless for that: a screen showing
   * "[mock:mock-fast] placeholder sample draft" tells a reviewer nothing about
   * whether retrieval, citation and the refusal path actually work, and it puts
   * the word "mock" and a model key on a customer-shaped screen.
   *
   * What it does instead is SELECT, never generate: the first sentences of the
   * material the retriever already chose, within the caller's token budget. No
   * claim is invented, so an answer a reviewer reads in development is made of
   * the workspace's own approved knowledge.
   *
   * IT IS STILL NOT AN INSTRUCTION CHANNEL. Selecting a prefix is not
   * interpreting: nothing in the material can make this adapter fail, stall,
   * change model or do anything other than return some of that same material.
   * Property 3 above is intact.
   */
  readonly answerFromContext?: boolean;
}

export interface MockCall {
  readonly modelKey: string;
  readonly operation: string;
}

interface ActiveDirective {
  readonly directive: MockDirective;
  remaining: number;
}

const MOCK_MODALITIES: readonly AiModality[] = ['text', 'image', 'moderation'];

/** Deliberately bland. The text is a placeholder, never mistakable for a real answer. */
const WORDS = [
  'placeholder',
  'sample',
  'draft',
  'outline',
  'summary',
  'note',
  'section',
  'item',
  'entry',
  'line',
  'block',
  'value',
] as const;

/** ~4 characters per token. Close enough that cost tests exercise real arithmetic. */
const CHARS_PER_TOKEN = 4;

function digest(parts: readonly string[]): Buffer {
  const hash = createHash('sha256');
  for (const part of parts) {
    // Length-prefixed so ('ab','c') and ('a','bc') are different inputs. Without
    // this, two different requests could hash alike and one test could mask
    // another's failure.
    hash.update(String(part.length));
    hash.update(' ');
    hash.update(part);
  }
  return hash.digest();
}

/** A deterministic non-negative integer in [0, bound) drawn from the digest. */
function pick(bytes: Buffer, offset: number, bound: number): number {
  if (bound <= 0) return 0;
  const high = bytes[offset % bytes.length] ?? 0;
  const low = bytes[(offset + 1) % bytes.length] ?? 0;
  return (high * 256 + low) % bound;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const fail = (): void =>
      reject(
        new AiProviderError(
          'TIMEOUT',
          customerMessageFor('TIMEOUT'),
          'mock adapter aborted by the request deadline',
        ),
      );
    if (signal.aborted) {
      fail();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      fail();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The opening sentences of the reference material, within the token budget.
 *
 * SELECTION, NOT GENERATION. The fence lines the caller wrapped the material in
 * are dropped because they are the caller's own framing rather than content;
 * everything else is returned verbatim, in order, until the budget runs out.
 * Deterministic by construction — the same material always yields the same
 * answer, which is what makes an end-to-end assertion about it meaningful.
 */
function answerFrom(context: readonly string[], maxOutputTokens: number): string {
  const body = context
    .join('\n')
    .split('\n')
    .filter((line) => !line.startsWith('--- BEGIN ') && !line.startsWith('--- END '))
    .join('\n')
    .trim();

  // The same ~4 characters per token this adapter uses everywhere else, so the
  // answer respects the budget the routing rule set.
  const budget = Math.max(1, maxOutputTokens) * CHARS_PER_TOKEN;
  if (body.length <= budget) return body;

  // Cut at a sentence end inside the budget when there is one, so the answer
  // does not stop mid-word.
  const window = body.slice(0, budget);
  const lastStop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
  return (lastStop > budget / 2 ? window.slice(0, lastStop + 1) : window).trim();
}

export class MockProviderAdapter implements AiProviderAdapter {
  readonly key = 'mock';
  readonly supportedModalities = MOCK_MODALITIES;

  readonly #seed: string;
  readonly #latencyMs: number;
  readonly #flaggedPhrases: readonly string[];
  readonly #answerFromContext: boolean;
  #directives: ActiveDirective[] = [];
  #calls: MockCall[] = [];

  constructor(options: MockAdapterOptions = {}) {
    this.#seed = options.seed ?? 'brandspace-mock';
    this.#latencyMs = options.latencyMs ?? 0;
    this.#flaggedPhrases = options.flaggedPhrases ?? [];
    this.#answerFromContext = options.answerFromContext ?? false;
  }

  /** Queue behaviour for upcoming calls. The ONLY way to change what happens. */
  program(...directives: readonly MockDirective[]): this {
    for (const directive of directives) {
      this.#directives.push({ directive, remaining: directive.times ?? 1 });
    }
    return this;
  }

  /** Forget programmed directives and the call log. */
  reset(): this {
    this.#directives = [];
    this.#calls = [];
    return this;
  }

  /** What was called, in order. Lets a test prove a fallback was actually tried. */
  get calls(): readonly MockCall[] {
    return this.#calls;
  }

  async testConnection(ctx: AdapterContext): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      await this.#enter('__connection__', 'testConnection', ctx);
    } catch (error) {
      if (error instanceof AiProviderError) {
        return { ok: false, latencyMs: Date.now() - started, message: error.message };
      }
      throw error;
    }
    return { ok: true, latencyMs: Date.now() - started, message: 'Mock provider reachable.' };
  }

  async generateText(request: TextRequest, ctx: AdapterContext): Promise<TextResult> {
    await this.#enter(request.modelKey, 'generateText', ctx);

    const context = request.untrustedContext ?? [];
    const bytes = digest([
      this.#seed,
      request.modelKey,
      request.prompt,
      // Included so different context produces different output — and for no
      // other reason. It is never parsed.
      context.join(' '),
      String(request.maxOutputTokens),
    ]);

    // At least one token, never more than the caller allowed: a mock that
    // overran maxOutputTokens would let an over-budget response pass a test
    // that a real provider would fail.
    const completionTokens = Math.max(1, pick(bytes, 0, Math.max(1, request.maxOutputTokens)) + 1);
    const words: string[] = [];
    for (let index = 0; index < completionTokens; index += 1) {
      words.push(WORDS[pick(bytes, 2 + index, WORDS.length)] ?? 'placeholder');
    }

    const promptChars =
      request.prompt.length + context.reduce((total, entry) => total + entry.length, 0);

    return {
      text: this.#answerFromContext
        ? answerFrom(context, request.maxOutputTokens)
        : `[mock:${request.modelKey}] ${words.join(' ')}`,
      modelKey: request.modelKey,
      usage: {
        promptTokens: Math.max(1, Math.ceil(promptChars / CHARS_PER_TOKEN)),
        completionTokens,
      },
    };
  }

  async generateImage(request: ImageRequest, ctx: AdapterContext): Promise<ImageResult> {
    await this.#enter(request.modelKey, 'generateImage', ctx);

    const bytes = digest([this.#seed, request.modelKey, request.prompt, request.size]);
    const fingerprint = bytes.toString('hex').slice(0, 16);
    const imageRefs = Array.from(
      { length: Math.max(1, request.count) },
      (_unused, index) => `mock://image/${fingerprint}/${index}`,
    );

    return { imageRefs, modelKey: request.modelKey, usage: { imageCount: imageRefs.length } };
  }

  async moderate(request: ModerationRequest, ctx: AdapterContext): Promise<ModerationResult> {
    await this.#enter(request.modelKey, 'moderate', ctx);

    const haystack = request.text.toLowerCase();
    const categories = this.#flaggedPhrases
      .filter((phrase) => haystack.includes(phrase.toLowerCase()))
      .map((phrase) => `mock.${phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`);

    return {
      flagged: categories.length > 0,
      // Category keys only. The offending text is the customer's and does not
      // belong in an operator record.
      categories,
      usage: { promptTokens: Math.max(1, Math.ceil(request.text.length / CHARS_PER_TOKEN)) },
    };
  }

  classifyError(error: unknown): AiFailureClass {
    if (error instanceof AiProviderError) return error.failureClass;
    // A caller-side abort reaches the adapter as an AbortError from the
    // transport. Anything the mock cannot name is UNKNOWN, which is neither
    // retried nor rerouted — guessing "transient" would gamble a second charge.
    if (error instanceof Error && error.name === 'AbortError') return 'TIMEOUT';
    return 'UNKNOWN';
  }

  /** Record the call, apply any matching directive, then simulate latency. */
  async #enter(modelKey: string, operation: string, ctx: AdapterContext): Promise<void> {
    this.#calls.push({ modelKey, operation });

    const match = this.#directives.find(
      (entry) =>
        entry.remaining > 0 &&
        (entry.directive.modelKey === undefined || entry.directive.modelKey === modelKey),
    );

    let delayMs = this.#latencyMs;
    if (match) {
      match.remaining -= 1;
      delayMs = match.directive.delayMs ?? delayMs;
    }

    // Delay FIRST so a directive that both stalls and fails behaves like a
    // provider that timed out on the way to an error, not one that answered
    // instantly.
    await abortableDelay(delayMs, ctx.signal);

    if (match?.directive.failWith) {
      throw new AiProviderError(
        match.directive.failWith,
        customerMessageFor(match.directive.failWith),
        `mock adapter programmed to fail with ${match.directive.failWith} on ${operation}`,
      );
    }
  }
}
