/**
 * D-572 — WHICH PICTURE A CONNECTED AI APP GETS IN SETTINGS.
 *
 * The logo the app registered (RFC 7591 `logo_uri`) is shown only when it is
 * https AND passes the dashboard's existing image rule: the Content Security
 * Policy's `img-src 'self' data: blob:` (`packages/shared/src/security-headers.ts`).
 * An app's logo on its own host is not `'self'`, so it is not loaded — the
 * browser would refuse it, and widening that rule (or fetching the logo
 * through Brandspace) is a decision this screen does not make. Every other
 * case draws the neutral app icon.
 */
export function appLogoSrc(
  logoUri: string | null | undefined,
  dashboardOrigin: string | null | undefined,
): string | null {
  if (!logoUri || !dashboardOrigin) return null;
  let logo: URL;
  let self: URL;
  try {
    logo = new URL(logoUri);
    self = new URL(dashboardOrigin);
  } catch {
    return null;
  }
  if (logo.protocol !== 'https:') return null;
  return logo.origin === self.origin ? logo.toString() : null;
}
