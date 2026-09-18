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
import { deterministicPng } from './deterministic-image';

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

/**
 * THE TASKS THAT ASK FOR A DOCUMENT RATHER THAN A SENTENCE.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT. Several product surfaces parse the
 * model's answer against a schema and refuse anything else — correctly: a
 * model's output is untrusted input about to become a database row (AC-11.9).
 * The development adapter returned prose for every task, so every one of those
 * surfaces answered "that could not be completed" and the whole path was
 * unprovable end to end. The Content Studio had never once produced a draft in
 * a browser.
 *
 * IT IS STILL SELECTION, NOT GENERATION. The words come from the SAME context
 * `answerFrom` uses — the workspace's own approved knowledge, already chosen by
 * the retriever — arranged in the shape the caller asked for. Nothing is
 * invented, no claim is composed, and nothing in the material can make this
 * adapter fail, stall or change model.
 *
 * IT IS KEYED ON THE PLATFORM'S OWN TASK KEY, from the closed registry, chosen
 * by the routing rule. A customer cannot reach it and a prompt cannot select
 * it: this is not prompt-sniffing.
 *
 * AND IT IS DEVELOPMENT ONLY. The provider is `mock`, whose base url resolves
 * nowhere and whose credential is a placeholder; production routes to a real
 * model or to nothing at all.
 */
const STRUCTURED_TASKS = new Set([
  'caption.generate',
  // Both the strategy proposal and the content-gap analysis run under this key:
  // routing is per TASK, and they are one task asked two ways. The shape is
  // told apart below by the schema the platform's own prompt printed.
  'strategy.generate',
  'plan.monthly',
  'analytics.explain',
]);

/** The platform keys a caption request named, read from the prompt's own line. */
function platformsFromPrompt(prompt: string): string[] {
  /*
   * THE CHANNEL LINE THE STUDIO WRITES, and only that line. This reads the
   * PLATFORM's own prompt, which this package composes — not customer text, and
   * not the untrusted context, which is never parsed here or anywhere.
   */
  const line = /Write for these channels: ([^\n]+)/.exec(prompt)?.[1] ?? '';
  const keys = line
    .split(';')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter((key) => key !== '');
  return keys.length > 0 ? keys : ['instagram'];
}

/**
 * A localized pair, from one piece of the brand's own material.
 *
 * NO DIGITS. The grounding validator refuses prose containing a numeral that is
 * not in the evidence — correctly, because a number in a claim is a measurement
 * — and material selected from a brand's knowledge can easily contain one. A
 * mock that emitted a stray "2024" would be refused for saying something it
 * never meant to say.
 */
function localizedFromMaterial(material: string, fallback: string): { ar: string; en: string } {
  const clean = material
    .replace(/[0-9\u0660-\u0669]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const text = clean === '' ? fallback : clean.slice(0, 160);
  return { ar: text, en: text };
}

/**
 * The evidence ordinals the caller actually supplied, in order.
 *
 * READ FROM THE PLATFORM'S OWN EVIDENCE BLOCK, whose lines begin `e1`, `e2`.
 * A claim must cite a row that exists: citing one that does not is exactly the
 * fabricated citation the grounding gate was built to refuse, and a mock that
 * invented `[1]` on an empty package would be testing the gate rather than the
 * path.
 */
function evidenceOrdinals(context: readonly string[]): number[] {
  const found = new Set<number>();
  for (const match of context.join('\n').matchAll(/(?:^|\s)e(\d{1,3})\b/g)) {
    const ordinal = Number(match[1]);
    if (Number.isInteger(ordinal) && ordinal > 0) found.add(ordinal);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * A REASONING DOCUMENT IN THE SHAPE THE PROMPT PRINTED.
 *
 * WHICH SHAPE, AND HOW IT IS KNOWN. Three product surfaces share one task key
 * or differ only by schema, so the task alone cannot tell them apart. Each
 * prompt prints the schema it wants — `"gaps"`, `"pillars"`, `"claims"` — and
 * that line is written by THIS CODEBASE, in `packages/intelligence` and
 * `packages/analytics`. Reading our own instruction is not prompt-sniffing and
 * is not an instruction channel: nothing a customer writes reaches it, and the
 * only thing it can change is which of three fixed shapes is returned.
 *
 * RETURNS NULL WHEN IT CANNOT ANSWER HONESTLY — an unrecognised shape, or a
 * claim-shaped document with no evidence to cite. The caller then falls back to
 * prose, the product refuses it as unparseable, and the refusal is the right
 * outcome rather than a fabricated citation.
 */
function reasoningDocument(
  prompt: string,
  context: readonly string[],
  maxOutputTokens: number,
): string | null {
  const material = answerFrom(context, maxOutputTokens).replace(/\s+/g, ' ').trim();
  const summary = localizedFromMaterial(material, 'A short summary of the material supplied.');
  const ordinals = evidenceOrdinals(context);
  const cite = ordinals.slice(0, 1);

  if (prompt.includes('"gaps"')) {
    if (cite.length === 0) return null;
    return JSON.stringify({
      summary,
      gaps: [
        {
          title: localizedFromMaterial(material, 'An area with nothing published against it'),
          rationale: {
            evidenceRefs: cite,
            text: localizedFromMaterial(material, 'The reference material shows nothing here.'),
          },
          suggestedAction: localizedFromMaterial(material, 'Plan content against it.'),
        },
      ],
    });
  }

  if (prompt.includes('"pillars"')) {
    if (cite.length === 0) return null;
    const rationale = {
      evidenceRefs: cite,
      text: localizedFromMaterial(material, 'It rests on the material supplied.'),
    };
    return JSON.stringify({
      summary,
      pillars: [
        {
          name: localizedFromMaterial(material, 'The brand own subject'),
          rationale,
          sharePercent: 100,
        },
      ],
      channelMix: [{ platformKey: 'linkedin', sharePercent: 100, rationale }],
      monthlyPlan: [],
    });
  }

  if (prompt.includes('"claims"')) {
    if (cite.length === 0) return null;
    return JSON.stringify({
      summary,
      claims: [
        {
          evidenceRefs: cite,
          text: localizedFromMaterial(material, 'The measurements supplied show this.'),
        },
      ],
      notableChanges: [],
      recommendations: [],
    });
  }

  return null;
}

/**
 * A caption document, composed from the brand's own material.
 *
 * ONE VARIANT PER CHANNEL ASKED FOR, each carrying a prefix of the context and
 * nothing else. The body is deliberately SHORT — well inside every platform's
 * ceiling — because a mock that overran a limit would fail a validation the
 * product is right to apply and would be testing the limit rather than the
 * path.
 */
function captionDocument(
  prompt: string,
  context: readonly string[],
  maxOutputTokens: number,
): string {
  const material = answerFrom(context, maxOutputTokens).replace(/\s+/g, ' ').trim();
  const body = material === '' ? 'A short note from this brand.' : material.slice(0, 180);
  return JSON.stringify({
    // The brief's own first line, which the Studio would otherwise derive
    // itself. Never a sentence this adapter made up about the brand.
    title: (/Brief:\n([^\n]+)/.exec(prompt)?.[1] ?? 'Draft').slice(0, 120),
    variants: platformsFromPrompt(prompt).map((platformKey) => ({
      platformKey,
      body,
      hashtags: [],
    })),
  });
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

    /*
     * A DOCUMENT WHERE THE TASK ASKS FOR ONE, prose everywhere else. The task
     * key is the platform's own and comes from the resolved route; see
     * `STRUCTURED_TASKS` for why an adapter is allowed to know it.
     */
    const structured = request.taskKey !== undefined && STRUCTURED_TASKS.has(request.taskKey);

    const document = structured
      ? request.taskKey === 'caption.generate'
        ? captionDocument(request.prompt, context, request.maxOutputTokens)
        : reasoningDocument(request.prompt, context, request.maxOutputTokens)
      : null;

    return {
      text:
        document ??
        (this.#answerFromContext
          ? answerFrom(context, request.maxOutputTokens)
          : `[mock:${request.modelKey}] ${words.join(' ')}`),
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

    /*
     * REAL BYTES, DETERMINISTICALLY DRAWN (Phase 8).
     *
     * The ref alone proved nothing: a Creative Studio that cannot store a file
     * cannot show one, attach one to a post, or publish one, and half the
     * product would have stayed untested until an image vendor was chosen
     * (D-13, Phase 10). These are small abstract compositions in the brand
     * palette, derived entirely from the fingerprint above — the same prompt at
     * the same size always yields the same file, which is what makes a
     * checksum, a screenshot and a duplicate test mean the same thing twice.
     *
     * Nothing here pretends to be a photograph, and every asset the Studio
     * stores records that a provider generated it.
     */
    const images = Array.from({ length: Math.max(1, request.count) }, (_unused, index) => {
      const ref = `mock://image/${fingerprint}/${index}`;
      const drawn = deterministicPng(`${fingerprint}:${index}`, request.size);
      return {
        ref,
        base64: Buffer.from(drawn.bytes).toString('base64'),
        mimeType: drawn.mimeType,
        width: drawn.width,
        height: drawn.height,
      };
    });

    return {
      imageRefs: images.map((image) => image.ref),
      images,
      modelKey: request.modelKey,
      usage: { imageCount: images.length },
    };
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
