import { z } from 'zod';
import { AppError } from '@brandspace/shared';

/**
 * AC-11.9 — "Output is validated against a schema; a malformed provider
 * response is a retryable error and is never persisted."
 *
 * THIS IS A TRUST BOUNDARY, not a convenience. A model's output is untrusted
 * input in exactly the sense CLAUDE.md §5 means: it arrives from outside, it is
 * about to become a database row, and the thing that produced it is a
 * statistical process that has no obligation to honour the shape it was asked
 * for. Parsing it here is what stops a provider's bad day becoming a draft
 * nobody can read or a `platformKey` nobody offers.
 *
 * TWO REFUSALS THAT MATTER MORE THAN THE REST:
 *
 *   - A VARIANT FOR A PLATFORM NOBODY ASKED FOR IS DROPPED. A model that
 *     invents `"platformKey": "myspace"` would otherwise write a row the
 *     composer cannot render and no validation rule covers.
 *
 *   - THE COUNT IS BOUNDED. A model that returns four hundred variants would
 *     otherwise turn one request into four hundred rows, which is a cost the
 *     customer did not agree to and a fan-out the quote did not price.
 */

const variantSchema = z.object({
  platformKey: z.string().min(1),
  body: z.string(),
  hashtags: z.array(z.string()).default([]),
});

const generatedSchema = z.object({
  title: z.string().default(''),
  variants: z.array(variantSchema).min(1),
});

export interface GeneratedContent {
  readonly title: string;
  readonly variants: readonly { platformKey: string; body: string; hashtags: string[] }[];
}

export interface ParseOptions {
  /** Only these platform keys may appear; anything else is dropped. */
  readonly platformKeys: readonly string[];
  readonly maxVariants: number;
  /**
   * Tool mode: the model was asked for one caption rather than a set, so a
   * bare `{ "body": ... }` is accepted and wrapped.
   */
  readonly singleBody?: boolean;
}

/**
 * Parse a model's text into content, or throw.
 *
 * Tolerant of the two harmless things models reliably do — wrapping JSON in a
 * ```json fence, and padding it with a sentence — and intolerant of everything
 * else. Being tolerant of the shape would defeat the point.
 */
export function parseGeneratedContent(text: string, options: ParseOptions): GeneratedContent {
  const json = extractJson(text);
  if (json === null) throw malformed();

  let candidate: unknown = json;

  if (options.singleBody && isRecord(json) && typeof json['body'] === 'string') {
    candidate = {
      title: '',
      variants: [
        {
          platformKey: options.platformKeys[0],
          body: json['body'],
          hashtags: Array.isArray(json['hashtags']) ? json['hashtags'] : [],
        },
      ],
    };
  }

  const parsed = generatedSchema.safeParse(candidate);
  if (!parsed.success) throw malformed();

  const allowed = new Set(options.platformKeys);
  const variants = parsed.data.variants
    .filter((v) => allowed.has(v.platformKey))
    // One variant per platform: a model that returned two for Instagram would
    // otherwise violate `unique(contentItemId, platformKey, locale)` at the
    // insert, turning a model quirk into a 500.
    .filter((v, i, all) => all.findIndex((o) => o.platformKey === v.platformKey) === i)
    .slice(0, options.maxVariants);

  if (variants.length === 0) throw malformed();

  return {
    title: parsed.data.title.slice(0, 200),
    variants: variants.map((v) => ({
      platformKey: v.platformKey,
      body: v.body,
      hashtags: v.hashtags.slice(0, 50),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Find the JSON object in a response that may be fenced or padded. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text].filter((c): c is string => typeof c === 'string');

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // Try the next candidate rather than failing on the first.
    }
  }
  return null;
}

/**
 * The customer-facing failure.
 *
 * Says nothing about the provider, the model or the shape that was wrong —
 * AC-11.6. "The model returned invalid JSON" would leak that there is a model
 * and invite someone to find out which.
 */
function malformed(): AppError {
  return new AppError('CONFLICT', 'Content could not be generated. Please try again.');
}
