import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CopilotActionClass } from '@brandspace/database';

/**
 * THE PLAN HASH, AND THE CONFIRMATION TOKEN.
 *
 * `planHash` IS WHAT MAKES "CHANGING THE PLAN INVALIDATES THE CONFIRMATION"
 * ARITHMETIC RATHER THAN A RULE SOMEBODY HAS TO REMEMBER TO ENFORCE.
 *
 * It is a sha256 over the CANONICAL steps — the tool keys, their arguments and
 * their action classes, in order — and nothing else. Not the summary, which is
 * prose and may be regenerated; not the timestamps, which move; not the plan id,
 * which would make every revision trivially distinct and therefore prove
 * nothing. Two plans that would DO THE SAME THING hash the same, and two plans
 * that would do anything different hash differently.
 *
 * The confirmation is bound to this value: `confirm()` takes the hash the
 * customer was SHOWN and refuses when it no longer matches the stored one. So a
 * plan edited between the preview and the confirmation cannot be confirmed by
 * the confirmation the customer issued for the previous version — and a database
 * trigger refuses to let a confirmed plan's steps change at all, which closes
 * the same attack one layer lower.
 *
 * THE TOKEN IS SINGLE-USE AND STORED HASHED, exactly as the OAuth state is
 * (D-141). The value that travels through the browser is never written down, so
 * a database read cannot be replayed as a confirmation, and single use is
 * enforced by a conditional UPDATE on `confirmedAt` rather than by a
 * read-then-write.
 */

/** One step, in the shape the hash is taken over. */
export interface CanonicalStep {
  readonly ordinal: number;
  readonly toolKey: string;
  readonly actionClass: CopilotActionClass;
  /** Already parsed by the tool's own schema. */
  readonly arguments: unknown;
}

/**
 * Serialize a value so that two structurally identical values produce identical
 * text, whatever order their keys were built in.
 *
 * KEY ORDER IS NOT INCIDENTAL HERE. `JSON.stringify` preserves insertion order,
 * so a plan rebuilt from the database — where Prisma returns JSON with its own
 * ordering — would hash differently from the plan as constructed, and every
 * confirmation would fail for a reason nobody could see. Sorting makes the hash
 * a function of the VALUE rather than of how it was assembled.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is not JSON and must not become the string "undefined".
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256 over the canonical steps. The confirmation binds to this. */
export function planHashOf(steps: readonly CanonicalStep[]): string {
  const canonical = steps
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((step) => ({
      ordinal: step.ordinal,
      toolKey: step.toolKey,
      actionClass: step.actionClass,
      arguments: step.arguments,
    }));
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

/**
 * A fresh confirmation secret and its stored hash.
 *
 * 32 BYTES FROM `randomBytes`, not a uuid: a confirmation token is a bearer
 * credential for a state change, and a v4 uuid carries 122 bits in a format that
 * invites being logged as an identifier. This one is obviously a secret.
 */
export function issueConfirmationToken(): { readonly token: string; readonly hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashConfirmationToken(token) };
}

export function hashConfirmationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Compare two hex digests without leaking where they differ.
 *
 * The database comparison is the real gate — the conditional UPDATE matches on
 * the stored hash — so this is defence in depth for the paths that compare in
 * process. `timingSafeEqual` throws on a length mismatch, which is why the
 * length is checked first rather than caught.
 */
export function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * The deterministic identity of one tool execution.
 *
 * hash(plan, ordinal, tool, arguments), UNIQUE per workspace. A retried
 * execution — a lost HTTP response, a duplicate job, a customer pressing the
 * button twice — finds the completed call rather than running the tool a second
 * time. Derived rather than minted for exactly that reason: a fresh key per
 * attempt would de-duplicate nothing.
 */
export function toolCallIdempotencyKey(input: {
  planId: string;
  ordinal: number;
  toolKey: string;
  arguments: unknown;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        planId: input.planId,
        ordinal: input.ordinal,
        toolKey: input.toolKey,
        arguments: input.arguments,
      }),
    )
    .digest('hex');
}
