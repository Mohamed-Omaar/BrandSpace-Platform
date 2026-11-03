/**
 * PERF A (#4) — A SHORT IN-PROCESS CACHE FOR GLOBAL CONFIGURATION ONLY.
 *
 * For the activated configuration documents, plans and the entitlement
 * catalogue: the same rows for every workspace, changed only by an owner
 * activation. Never for a session, a membership, a role, a permission or any
 * tenant row — those are asked again on every request.
 *
 * THE CEILING IS 30 SECONDS, whatever a caller asks for: an activation or a
 * rollback reaches every process within that time. Each process (each
 * dashboard and Control Center instance) holds its own copy; nothing is
 * shared between them. A concurrent miss for the same key shares one load.
 */
export const MAX_CONFIG_CACHE_TTL_MS = 30_000;

export class TtlCache<V> {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { readonly value: Promise<V>; readonly at: number }>();

  constructor(ttlMs: number = MAX_CONFIG_CACHE_TTL_MS, now: () => number = Date.now) {
    this.#ttlMs = Math.max(0, Math.min(ttlMs, MAX_CONFIG_CACHE_TTL_MS));
    this.#now = now;
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  /** The cached value for `key`, or `load()`'s, kept for the TTL. A failed load is not kept. */
  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.#entries.get(key);
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.value;
    const value = load();
    this.#entries.set(key, { value, at: this.#now() });
    value.catch(() => {
      if (this.#entries.get(key)?.value === value) this.#entries.delete(key);
    });
    return value;
  }

  /** Forget one key, or everything. */
  clear(key?: string): void {
    if (key === undefined) this.#entries.clear();
    else this.#entries.delete(key);
  }
}
