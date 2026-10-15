/**
 * OLD -> NEW, FOR THE AUDIT LOG (Control Center Simple mode, owner decision).
 *
 * The activation audit event used to carry the domain and the version number
 * only, so "who changed the trial credits, and from what" meant opening two
 * versions and comparing them by eye. This walks the previous active document
 * and the one being activated and returns every LEAF that changed, as a path a
 * person can read: `plans[starter].trialCredits`, `signup.minPasswordLength`.
 *
 * KEYED LISTS ARE MATCHED BY KEY, not by position: inserting a plan before
 * another must not read as "every plan after it changed". A list of plain
 * values (allowed MIME types, suggested times) is one leaf: compared whole.
 *
 * NOTHING SECRET IS COPIED. Configuration holds secret REFERENCES, never
 * values (CLAUDE.md §2.3), but a leaf whose name looks like a credential is
 * still recorded as changed without either value, so the log never becomes the
 * place a value could leak from.
 *
 * Bounded: an activation that rewrites a whole document records the first
 * `limit` leaves and says it was truncated, rather than writing an unbounded row.
 */

export interface AuditLeafChange {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface AuditDiff {
  readonly changes: readonly AuditLeafChange[];
  readonly truncated: boolean;
}

/** The fields a keyed list is matched on, in order of preference. */
const KEY_FIELDS = ['key', 'featureKey', 'providerKey', 'taskKey', 'capability', 'country'];

const SECRET_NAME = /secret|password|token|apikey|api_key|privatekey|credential/i;

const MASKED = '(changed)';

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keyFieldOf(list: readonly Json[]): string | null {
  if (list.length === 0 || !list.every(isRecord)) return null;
  for (const field of KEY_FIELDS) {
    const keys = list.map((item) => (item as Record<string, Json>)[field]);
    if (
      keys.every((key) => typeof key === 'string' && key !== '') &&
      new Set(keys).size === keys.length
    ) {
      return field;
    }
  }
  return null;
}

function same(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function configLeafDiff(before: Json, after: Json, limit = 200): AuditDiff {
  const changes: AuditLeafChange[] = [];
  let truncated = false;

  const record = (path: string, name: string, from: Json, to: Json) => {
    if (changes.length >= limit) {
      truncated = true;
      return;
    }
    const secret = SECRET_NAME.test(name);
    changes.push({
      path,
      before: secret && from !== undefined ? MASKED : (from ?? null),
      after: secret && to !== undefined ? MASKED : (to ?? null),
    });
  };

  const walk = (path: string, name: string, from: Json, to: Json) => {
    if (same(from, to)) return;
    if (isRecord(from) && isRecord(to)) {
      for (const field of [...new Set([...Object.keys(from), ...Object.keys(to)])].sort()) {
        walk(path ? `${path}.${field}` : field, field, from[field], to[field]);
      }
      return;
    }
    if (Array.isArray(from) && Array.isArray(to)) {
      // Both sides must be matchable on the same key; an empty side takes the other's.
      const keyField = keyFieldOf(from.length > 0 ? from : to);
      if (
        keyField !== null &&
        (from.length === 0 || keyFieldOf(from) === keyField) &&
        (to.length === 0 || keyFieldOf(to) === keyField)
      ) {
        const byKey = (list: readonly Json[]) =>
          new Map(list.map((item) => [String((item as Record<string, Json>)[keyField]), item]));
        const a = byKey(from);
        const b = byKey(to);
        for (const key of [...new Set([...a.keys(), ...b.keys()])]) {
          walk(`${path}[${key}]`, name, a.get(key), b.get(key));
        }
        return;
      }
    }
    record(path, name, from, to);
  };

  walk('', '', before, after);
  return { changes, truncated };
}
