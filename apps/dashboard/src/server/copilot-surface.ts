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

/**
 * WHICH SCREEN THE READER IS ON, as a Copilot surface (P6-16).
 *
 * The top bar's Copilot entry is on every page, so it cannot pass a literal the
 * way the in-page "Ask Copilot" links do. It reads the route instead, longest
 * prefix first, and anything not listed opens the Copilot as `general` — the
 * honest answer for a screen the Copilot has no description of.
 */
const SURFACE_FOR_ROUTE: readonly (readonly [string, CopilotEntrySurface])[] = [
  ['/overview', 'overview'],
  ['/analytics', 'analytics'],
  ['/intelligence', 'intelligence'],
  ['/brand-brain', 'brand_brain'],
  ['/campaigns', 'campaigns'],
  ['/calendar', 'calendar'],
  ['/content', 'content'],
  ['/automations', 'automations'],
];

/** `/en/content/compose?item=1` → `content`. A path without a locale is `general`. */
export function copilotSurfaceForPath(requestPath: string | null | undefined): CopilotEntrySurface {
  if (!requestPath) return 'general';
  const [pathname = ''] = requestPath.split('?', 1);
  const route = `/${pathname.split('/').filter(Boolean).slice(1).join('/')}`;
  const match = SURFACE_FOR_ROUTE.find(
    ([prefix]) => route === prefix || route.startsWith(`${prefix}/`),
  );
  return match ? match[1] : 'general';
}
