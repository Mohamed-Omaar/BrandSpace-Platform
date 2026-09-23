/**
 * WHERE THE COPILOT WAS OPENED FROM — a CLOSED set (P6-12).
 *
 * `copilot_session.surface` has been stored since Phase 7 and never read: the
 * assistant answered a question asked from the Analytics screen exactly as it
 * answered one asked from nowhere, so "why did this drop?" arrived with no hint
 * of what "this" was.
 *
 * WHY A CLOSED LIST AND NOT THE ROUTE STRING. The surface reaches the model's
 * instructions, which is the one place in the prompt that is NOT fenced as
 * untrusted. A free string there would be a caller-controlled line in the
 * system instruction — a prompt-injection channel with a friendly name. So the
 * API accepts only a key from this list, and the prompt carries the
 * DESCRIPTION this file wrote, never anything the caller sent.
 *
 * Each description says what the screen is FOR, not what is on it: the
 * assistant is told where the person is standing, and it still learns the
 * brand's facts only from Brand Brain retrieval, which stays fenced.
 */
export const COPILOT_SURFACES = {
  general: 'the Copilot screen itself, with no other screen in view',
  overview: 'Home: the Command Center and its Pulse list of what needs attention',
  analytics: 'Analytics: measured performance for the selected brand',
  intelligence: 'Marketing Intelligence: evidence-backed findings and proposed learnings',
  brand_brain: 'Brand Brain: the governed knowledge this brand is grounded in',
  campaigns: 'Campaigns: planned and running campaigns for the selected brand',
  calendar: 'the content calendar: what is planned, scheduled and published',
  content: 'the Content Studio: drafts and the content library',
  automations: 'Automations: trigger, condition and action rules for the selected brand',
} as const;

export type CopilotSurface = keyof typeof COPILOT_SURFACES;

export const COPILOT_SURFACE_KEYS = Object.keys(COPILOT_SURFACES) as CopilotSurface[];

/** A stored surface, narrowed back into the closed set. Anything else is `general`. */
export function copilotSurface(value: string | null | undefined): CopilotSurface {
  return value !== null && value !== undefined && value in COPILOT_SURFACES
    ? (value as CopilotSurface)
    : 'general';
}
