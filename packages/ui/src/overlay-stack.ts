/**
 * C8 (Phase 2B-2b) — WHICH OVERLAYS ARE OPEN, AND WHICH ONE IS ON TOP.
 *
 * The owner's rule (Phase 2B-2b, answer 7):
 *
 *   - An overlay opened from OUTSIDE every open overlay closes the others:
 *     only one managed overlay is open at a time.
 *   - An overlay opened from INSIDE another stacks on top of it — a delete
 *     confirmation opened from a detail sheet must not close the sheet.
 *   - Escape closes only the top one.
 *
 * Before this there was no shared record at all: every open overlay added its
 * own document-level Escape listener, and stopping propagation in one does not
 * stop another listener on the same node — so one Escape closed every overlay
 * at once, the sheet underneath included.
 *
 * Pure and DOM-free, so the rule is unit-tested as a rule. The DOM half —
 * where "inside" comes from, focus, the one keydown listener — is
 * `useOverlayBehaviour` in `overlays.tsx`, the hook every managed overlay
 * already used.
 */
export interface StackedOverlay {
  readonly id: number;
  /** Does this overlay's surface contain `origin` (the element that opened another)? */
  readonly contains: (origin: unknown) => boolean;
  readonly close: () => void;
}

export class OverlayStack<Entry extends StackedOverlay> {
  #entries: Entry[] = [];

  /** Bottom first; the last entry is the one on top. */
  get entries(): readonly Entry[] {
    return this.#entries;
  }

  top(): Entry | undefined {
    return this.#entries[this.#entries.length - 1];
  }

  /**
   * Opens `entry`, opened from `origin`. It stacks on the TOPMOST open overlay
   * that contains `origin`; everything above that overlay — or everything, when
   * `origin` is inside none — is returned for the caller to close.
   */
  open(entry: Entry, origin: unknown): Entry[] {
    let parent = -1;
    for (let index = this.#entries.length - 1; index >= 0; index -= 1) {
      if (this.#entries[index]!.contains(origin)) {
        parent = index;
        break;
      }
    }
    const displaced = this.#entries.slice(parent + 1);
    this.#entries = [...this.#entries.slice(0, parent + 1), entry];
    return displaced;
  }

  /**
   * Removes `id`. Anything stacked ABOVE it was opened from it, so it goes too
   * and is returned for the caller to close: a dialog must not outlive the
   * sheet it was asked from.
   */
  close(id: number): Entry[] {
    const index = this.#entries.findIndex((entry) => entry.id === id);
    if (index < 0) return [];
    const above = this.#entries.slice(index + 1);
    this.#entries = this.#entries.slice(0, index);
    return above;
  }

  /** Is `node` inside any open overlay? */
  anyContains(node: unknown): boolean {
    return this.#entries.some((entry) => entry.contains(node));
  }
}
