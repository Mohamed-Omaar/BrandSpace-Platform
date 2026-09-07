/**
 * The Copilot's SURFACE vocabulary and its suggested-action catalogue.
 *
 * In a neutral module rather than beside the component, for the same reason as
 * `menu-style.ts` and `social-post-types.ts`: everything exported from a
 * `'use client'` module becomes a client reference, so a server component
 * cannot read this table. Data and types belong on the shared side of the
 * boundary (F-25).
 */

/**
 * Where the Copilot is docked.
 *
 * The Copilot is CONTEXTUAL: it is not one floating chat window reachable from
 * everywhere, it is a panel that knows which screen opened it and offers the
 * actions that screen can actually use. `general` is the fallback for a surface
 * that has no specialised action set yet.
 */
export type CopilotSurface = 'general' | 'calendar' | 'posts' | 'composer' | 'studio';

/**
 * The stable identifiers of the suggested actions.
 *
 * IDENTIFIERS, NOT COPY. The visible label of each one is a translation key
 * resolved by the caller; nothing here is user-facing text.
 */
export type CopilotActionId =
  | 'generate-ideas'
  | 'write-caption'
  | 'rewrite-caption'
  | 'change-tone'
  | 'translate'
  | 'generate-hashtags'
  | 'suggest-time'
  | 'repurpose'
  | 'platform-variations'
  | 'visual-direction'
  | 'resize-design';

/**
 * Which actions each surface offers, in the order it should list them.
 *
 * Deliberately not "every action everywhere": a design canvas has no posting
 * time to suggest, and a calendar has nothing to resize. Offering an action a
 * surface cannot serve is the same failure as a button that does nothing.
 */
export const SURFACE_ACTIONS: Record<CopilotSurface, readonly CopilotActionId[]> = {
  general: ['generate-ideas', 'write-caption', 'translate'],
  calendar: ['generate-ideas', 'suggest-time', 'repurpose', 'platform-variations'],
  posts: ['repurpose', 'platform-variations', 'rewrite-caption', 'translate'],
  composer: [
    'write-caption',
    'rewrite-caption',
    'change-tone',
    'generate-hashtags',
    'translate',
    'suggest-time',
  ],
  studio: ['visual-direction', 'resize-design', 'generate-ideas'],
};
