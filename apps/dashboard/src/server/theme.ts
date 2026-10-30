import 'server-only';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { themeLookSchema, type ThemeLook } from '@brandspace/shared/theme';

/**
 * THE ACTIVE LOOK & FEEL THEME, AS THE CUSTOMER APP SEES IT (LF).
 *
 * Read from the API's public `/v1/theme` — the customer database role cannot
 * read the configuration store, by design — and held for 30 s like every
 * configuration read, so an activation reaches every page within a minute.
 * Anything that goes wrong is the original look.
 */
const log = createLogger({ context: { component: 'dashboard.theme' } });
const TTL_MS = 30_000;
let held: { look: ThemeLook; at: number } | null = null;

export async function activeLook(): Promise<ThemeLook> {
  if (held && Date.now() - held.at < TTL_MS) return held.look;
  const base = process.env['BRANDSPACE_API_URL'];
  let raw: unknown = {};
  if (base) {
    try {
      const upstream = await fetch(`${base.replace(/\/$/, '')}/v1/theme`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(1500),
      });
      if (upstream.ok) raw = ((await upstream.json()) as { look?: unknown }).look ?? {};
    } catch (error: unknown) {
      log.warn(
        'The theme could not be read; the original look is used',
        internalErrorFields(error),
      );
    }
  }
  const parsed = themeLookSchema.safeParse(raw);
  held = { look: parsed.success ? parsed.data : themeLookSchema.parse({}), at: Date.now() };
  return held.look;
}

/** The theme's image slots and the address each is served at. */
export const LOGO_SLOTS = ['light', 'dark', 'mark', 'favicon'] as const;
export type LogoSlot = (typeof LOGO_SLOTS)[number];

/** `/theme-assets/<slot>.img?v=<key>`: the key in the query changes the address when the image does. */
export function logoHref(slot: LogoSlot, key: string): string {
  return `/theme-assets/${slot}.img?v=${encodeURIComponent(key.slice(-16))}`;
}
