/**
 * PR A (smart Copilot, D-605) — WHAT `copilot_message.activity` MAY HOLD.
 *
 * Owner condition (SQL approval, 2026-11-11): only SHORT STEP LABELS AND IDS —
 * never customer content, never a tool's result — with a size cap enforced in
 * code. This is the one gate every write goes through:
 *
 *   - an answer: `{ worked: [{ key, state, contentItemId?, jobId? }] }` —
 *     a tool key (`area.verb`, lower case, ≤ 49 characters), one of three
 *     states, and the uuids of the draft or image job it made;
 *   - a person's message: `{ images: [uuid, …] }` — the Asset Library ids of
 *     the images they sent.
 *
 * Anything else is dropped, entries past the count cap are dropped, and the
 * serialised document never exceeds `ACTIVITY_MAX_BYTES`. The retention purge
 * clears the column with the message body (`retention.ts`).
 */

export const ACTIVITY_MAX_BYTES = 2_048;
export const ACTIVITY_MAX_STEPS = 24;
export const ACTIVITY_MAX_IMAGES = 2;

const STEP_KEY = /^[a-z_]{1,24}\.[a-z_]{1,24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['done', 'failed', 'proposed']);

export interface ActivityStep {
  readonly key: string;
  readonly state: 'done' | 'failed' | 'proposed';
  readonly contentItemId?: string;
  readonly jobId?: string;
}

function step(raw: unknown): ActivityStep | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const key = entry['key'];
  const state = entry['state'];
  if (typeof key !== 'string' || !STEP_KEY.test(key)) return null;
  if (typeof state !== 'string' || !STATES.has(state)) return null;
  const contentItemId = entry['contentItemId'];
  const jobId = entry['jobId'];
  return {
    key,
    state: state as ActivityStep['state'],
    ...(typeof contentItemId === 'string' && UUID.test(contentItemId) ? { contentItemId } : {}),
    ...(typeof jobId === 'string' && UUID.test(jobId) ? { jobId } : {}),
  };
}

const fits = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), 'utf8') <= ACTIVITY_MAX_BYTES;

/** An answer's "worked on": labels and ids only, capped. */
export function answerActivity(worked: readonly unknown[]): { readonly worked: ActivityStep[] } {
  const steps = worked.map(step).filter((entry): entry is ActivityStep => entry !== null);
  const kept = steps.slice(0, ACTIVITY_MAX_STEPS);
  while (kept.length > 0 && !fits({ worked: kept })) kept.pop();
  return { worked: kept };
}

/** A message's images: Asset Library ids only, capped. */
export function messageActivity(imageAssetIds: readonly unknown[]): { readonly images: string[] } {
  const images = imageAssetIds
    .filter((id): id is string => typeof id === 'string' && UUID.test(id))
    .slice(0, ACTIVITY_MAX_IMAGES);
  return { images };
}
