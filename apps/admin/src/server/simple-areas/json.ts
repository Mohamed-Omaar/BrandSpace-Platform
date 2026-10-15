/**
 * Reading configuration documents defensively.
 *
 * The areas read the ACTIVE documents as plain JSON and write back the whole
 * object they read, so every field Simple does not edit (a plan's add-ons, a
 * provider's media rules) survives untouched. Validation is the Configuration
 * Service's job when the change is proposed; these only keep the reading safe.
 */

export const rec = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

export const bool = (value: unknown): boolean => value === true;

/**
 * Put `item` into a keyed list: replacing the entry whose key is `replaceKey`
 * (an edit, which may rename it) or the entry with the same key, else appended.
 */
export function upsertBy(
  list: readonly Record<string, unknown>[],
  keyField: string,
  item: Record<string, unknown>,
  replaceKey: string | null,
): Record<string, unknown>[] {
  const target = replaceKey ?? str(item[keyField]);
  const index = list.findIndex((entry) => str(entry[keyField]) === target);
  if (index < 0) return [...list, item];
  return list.map((entry, at) => (at === index ? item : entry));
}

/** The same JSON value, whatever the order of an object's keys (arrays stay ordered). */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
