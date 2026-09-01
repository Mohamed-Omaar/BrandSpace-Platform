/**
 * Server-only guard.
 *
 * Standalone by design: it holds no connection and no credential, so it can be
 * imported and tested freely without widening access to the platform pool. The
 * pool imports it; nothing imports the pool but `platform.ts`.
 */
export function assertServerSide(moduleName: string): void {
  // Probed through globalThis: this package has no DOM lib, and correctly so —
  // it is server-only, so `window` must not be part of its type surface.
  const maybeWindow = (globalThis as { window?: unknown }).window;
  if (typeof maybeWindow !== 'undefined') {
    throw new Error(
      `${moduleName} was loaded in a browser context. ` +
        'It is server-only and must never reach a client bundle.',
    );
  }
}
