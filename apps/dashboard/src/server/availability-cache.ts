/**
 * C2 (owner, 2026-11-14) — AN ANSWER KEPT A SHORT WHILE PER WORKSPACE, AND
 * NEVER WAITED ON FOR LONG.
 *
 * `aiAvailability` used to ask the API on every page render, with no time
 * limit: a slow API held the whole page. This keeps one answer per key
 * (a workspace) for `ttlMs`, shares one request among callers asking at the
 * same time, and gives up on a request after `timeoutMs`. A request that fails
 * or times out answers with the last known answer when there is one, and
 * otherwise with `fallback` — never by throwing.
 *
 * No React, no Next: a unit test drives it with a fake clock.
 */
export interface AvailabilityCacheOptions<T> {
  readonly ttlMs: number;
  readonly timeoutMs: number;
  readonly fallback: T;
  readonly fetch: (key: string, signal: AbortSignal) => Promise<T>;
  readonly now?: () => number;
  /** Told when a request failed or timed out (for a log line). */
  readonly onFailure?: (key: string, error: unknown) => void;
}

interface Entry<T> {
  value?: T;
  at?: number;
  pending?: Promise<T> | undefined;
}

export class AvailabilityCache<T> {
  readonly #options: AvailabilityCacheOptions<T>;
  readonly #entries = new Map<string, Entry<T>>();

  constructor(options: AvailabilityCacheOptions<T>) {
    this.#options = options;
  }

  get(key: string): Promise<T> {
    const now = this.#options.now?.() ?? Date.now();
    const entry = this.#entries.get(key) ?? {};
    this.#entries.set(key, entry);
    if (
      entry.at !== undefined &&
      entry.value !== undefined &&
      now - entry.at < this.#options.ttlMs
    ) {
      return Promise.resolve(entry.value);
    }
    if (entry.pending) return entry.pending;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    const pending = this.#options
      .fetch(key, controller.signal)
      .then((value) => {
        entry.value = value;
        entry.at = this.#options.now?.() ?? Date.now();
        return value;
      })
      .catch((error: unknown) => {
        this.#options.onFailure?.(key, error);
        // The last known answer, however old, beats none; with none, the fallback.
        return entry.value ?? this.#options.fallback;
      })
      .finally(() => {
        clearTimeout(timer);
        entry.pending = undefined;
      });
    entry.pending = pending;
    return pending;
  }

  /** Forget everything (tests). */
  clear(): void {
    this.#entries.clear();
  }
}
