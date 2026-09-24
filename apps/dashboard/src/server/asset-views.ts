/**
 * THE ASSET LIBRARY'S VIEWS AND RIGHTS STATES (Phase 6 final, D-277 §30, D-287).
 *
 * PURE, AND NOT `server-only`: the unit suite imports it directly.
 *
 * A VIEW IS A FILTER, NOT A COLLECTION. "Recent", "AI generated" and "Unused"
 * are questions asked of real columns and references each time the page is
 * read; nothing is stored, so the screen calls them views, never "smart
 * collections" that could be mistaken for something a person curated.
 */
import type { AssetKind } from '@brandspace/database';

export const ASSET_VIEWS = [
  'images',
  'videos',
  'documents',
  'recent',
  'ai',
  'uploaded',
  'shared',
  'unused',
] as const;
export type AssetView = (typeof ASSET_VIEWS)[number];

/** How far back "Recent" looks. A definition of the view, not a policy value. */
export const RECENT_DAYS = 7;

/** How close to its end a licence is called "expiring". */
export const RIGHTS_WARNING_DAYS = 30;

export function viewKinds(view: AssetView | undefined): { kinds?: AssetKind[] } {
  switch (view) {
    case 'images':
      return { kinds: ['IMAGE'] };
    case 'videos':
      return { kinds: ['VIDEO'] };
    case 'documents':
      return { kinds: ['DOCUMENT', 'FONT', 'AUDIO'] };
    default:
      return {};
  }
}

/**
 * Where a file's licence stands. `expired` is the state the publishability
 * predicate refuses (D-286); `expiring` is a warning only.
 */
export type RightsState = 'none' | 'ok' | 'expiring' | 'expired';

export function rightsState(expiry: Date | null | undefined, now: Date): RightsState {
  if (!expiry) return 'none';
  if (expiry.getTime() <= now.getTime()) return 'expired';
  if (expiry.getTime() - now.getTime() <= RIGHTS_WARNING_DAYS * 86_400_000) return 'expiring';
  return 'ok';
}
