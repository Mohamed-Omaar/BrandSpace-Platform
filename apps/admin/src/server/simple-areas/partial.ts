import 'server-only';
import { cookies } from 'next/headers';
import { AppError } from '@brandspace/shared';
import { isConfigDomain, type ConfigDomain } from '@brandspace/config';
import { refusalCode } from '../simple-config';

/**
 * THE MISSING HALF OF A TWO-DOCUMENT CHANGE (owner review of D-558).
 *
 * When the second activation of a change is refused, the first stays saved.
 * The owner is told, in one message, what was saved and what was not, and may
 * try the second part again. To do that without retyping, the change itself —
 * the card, the item and the values the owner confirmed — is kept for half an
 * hour in an http-only, same-site cookie: never in the address bar (the URL
 * carries codes only), never readable by scripts. Trying again re-runs the
 * WHOLE edit against the documents live at that moment, through the same
 * checks and the same service as any save; the part already saved is then
 * unchanged, so only the missing part is written.
 */

export const PARTIAL_COOKIE = 'bs_simple_partial';
const MAX_AGE_SECONDS = 30 * 60;

export type PartialWhy = 'DRAFT_OPEN' | 'INVALID' | 'OTHER';

export interface PartialChange {
  readonly area: string;
  readonly c: string;
  readonly kind: 'save' | 'archive';
  /** The item as it is NOW (a new plan's own key once its first part exists). */
  readonly item: string;
  /** The editor's posted fields, exactly as the owner confirmed them. */
  readonly values: readonly (readonly [string, string])[];
  readonly saved: readonly ConfigDomain[];
  readonly failed: ConfigDomain;
  readonly why: PartialWhy;
}

export function whyOf(refusal: unknown): PartialWhy {
  if (refusalCode(refusal) === 'DRAFT_OPEN') return 'DRAFT_OPEN';
  if (refusal instanceof AppError && refusal.code === 'VALIDATION_FAILED') return 'INVALID';
  return 'OTHER';
}

/** The editor's fields from a posted form — the `f.` names only. */
export function postedFields(form: FormData): (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const [name, value] of form.entries()) {
    if (name.startsWith('f.') && typeof value === 'string') out.push([name, value]);
  }
  return out;
}

export async function rememberPartial(change: PartialChange): Promise<void> {
  const store = await cookies();
  store.set(PARTIAL_COOKIE, Buffer.from(JSON.stringify(change)).toString('base64url'), {
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max;

/** Parse, don't trust: a cookie is input like any other (CLAUDE.md §5). */
function parsePartial(value: unknown): PartialChange | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const values = v['values'];
  const saved = v['saved'];
  const failed = v['failed'];
  if (
    !isText(v['area'], 40) ||
    !isText(v['c'], 40) ||
    (v['kind'] !== 'save' && v['kind'] !== 'archive') ||
    !isText(v['item'], 120) ||
    !Array.isArray(values) ||
    values.length > 400 ||
    !values.every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        isText(pair[0], 120) &&
        isText(pair[1], 2000) &&
        pair[0].startsWith('f.'),
    ) ||
    !Array.isArray(saved) ||
    saved.length > 8 ||
    !saved.every((domain) => typeof domain === 'string' && isConfigDomain(domain)) ||
    typeof failed !== 'string' ||
    !isConfigDomain(failed) ||
    (v['why'] !== 'DRAFT_OPEN' && v['why'] !== 'INVALID' && v['why'] !== 'OTHER')
  ) {
    return null;
  }
  return {
    area: v['area'],
    c: v['c'],
    kind: v['kind'],
    item: v['item'],
    values: values as [string, string][],
    saved: saved as ConfigDomain[],
    failed,
    why: v['why'],
  };
}

export async function readPartial(): Promise<PartialChange | null> {
  const raw = (await cookies()).get(PARTIAL_COOKIE)?.value;
  if (!raw || raw.length > 8000) return null;
  try {
    return parsePartial(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

export async function forgetPartial(): Promise<void> {
  (await cookies()).delete(PARTIAL_COOKIE);
}
