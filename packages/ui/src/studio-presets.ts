/**
 * The Design Studio's PRESET SIZES, as data.
 *
 * In a neutral module rather than beside the editor, for the same reason as
 * `menu-style.ts`, `social-post-types.ts` and `copilot-types.ts`: everything
 * exported from a `'use client'` module becomes a client reference, so a
 * server component cannot read this table without pulling the whole editor
 * into the browser bundle. Data and types belong on the shared side of the
 * boundary (F-25), and `tests/unit/design-system.test.ts` now enforces it.
 */

export interface StudioPreset {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/**
 * The preset design sizes the brief asks for.
 *
 * The pixel dimensions are the data; the NAME is not here, because a name is
 * user-facing copy and must be translatable. `StudioLabels.presetNames`
 * supplies it, keyed by the id below.
 */
export const PRESET_SIZES: readonly StudioPreset[] = [
  { id: 'ig-post', width: 1080, height: 1080 },
  { id: 'ig-story', width: 1080, height: 1920 },
  { id: 'fb-post', width: 1200, height: 630 },
  { id: 'li-post', width: 1200, height: 627 },
  { id: 'x-post', width: 1600, height: 900 },
  { id: 'yt-thumb', width: 1280, height: 720 },
];
