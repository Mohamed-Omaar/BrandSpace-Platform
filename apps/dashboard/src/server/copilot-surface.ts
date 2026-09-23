/**
 * The screens the Copilot can be opened FROM (P6-12), as the dashboard knows them.
 *
 * A COPY OF `COPILOT_SURFACE_KEYS`, and deliberately so: `@brandspace/copilot`
 * reaches the AI Gateway, which F-07 keeps out of this app, so the dashboard
 * does not import it. `tests/unit/phase6-copilot.test.ts` fails if the two lists
 * ever differ — a key the API does not accept would be refused at session open,
 * and one the dashboard does not know would silently become `general`.
 *
 * PURE, AND NOT `server-only` — the unit suite imports it directly.
 */
export const COPILOT_ENTRY_SURFACES = [
  'general',
  'overview',
  'analytics',
  'intelligence',
  'brand_brain',
  'campaigns',
  'calendar',
  'content',
  'automations',
] as const;

export type CopilotEntrySurface = (typeof COPILOT_ENTRY_SURFACES)[number];

/** `?from=` narrowed into the closed set. Anything else is `general`. */
export function copilotSurface(value: string | null | undefined): CopilotEntrySurface {
  return (COPILOT_ENTRY_SURFACES as readonly string[]).includes(value ?? '')
    ? (value as CopilotEntrySurface)
    : 'general';
}

/** The link that opens the Copilot from a screen, carrying that screen as context. */
export function copilotHref(locale: string, from: CopilotEntrySurface): string {
  return `/${locale}/copilot?from=${from}`;
}
