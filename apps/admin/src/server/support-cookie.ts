/**
 * The Support Mode cookie name.
 *
 * Kept out of the `'use server'` module because a server-actions file may only
 * export async functions — exporting a constant from one is a build error.
 *
 * The cookie carries a support-session ID, NOT an authorisation. It grants
 * nothing by itself: `SupportModeService.resolve()` re-checks the owner, the
 * expiry and the workspace on every use, and the platform session is required
 * first. A stolen cookie without that session is inert.
 */
export const SUPPORT_COOKIE = '__Host-bs_support_session';
