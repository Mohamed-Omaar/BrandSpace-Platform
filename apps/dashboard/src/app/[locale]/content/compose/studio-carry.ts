/**
 * ROUND 4 (3.1) — WHAT WAS TYPED WHILE THE DRAFT WAS BEING MADE.
 *
 * The new-post Studio creates its draft on the first meaningful input and then
 * opens the draft's editor. Words typed in the moment between are written here
 * by the composer and read ONCE by that draft's editor, which saves them as the
 * person types. Same tab only (`sessionStorage`); it holds nothing the page did
 * not already show.
 */
export const STUDIO_CARRY_KEY = 'bsp-studio-carry';

export interface StudioCarry {
  readonly itemId: string;
  readonly caption: string;
  readonly tags: readonly string[];
}

/** The carry for THIS draft, removed as it is read; null for anything else. */
export function takeStudioCarry(itemId: string): StudioCarry | null {
  try {
    const raw = window.sessionStorage.getItem(STUDIO_CARRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StudioCarry>;
    if (parsed.itemId !== itemId) return null;
    window.sessionStorage.removeItem(STUDIO_CARRY_KEY);
    return {
      itemId,
      caption: typeof parsed.caption === 'string' ? parsed.caption : '',
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag) => typeof tag === 'string') : [],
    };
  } catch {
    return null;
  }
}
