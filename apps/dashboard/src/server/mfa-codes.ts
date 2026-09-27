/**
 * The cookie that carries freshly issued recovery codes to the one render of
 * the Security page that shows them (G4, D-333): httpOnly, same-site strict,
 * five minutes, and deleted by "I have saved them". Never a query string.
 */
export const RECOVERY_CODES_COOKIE = 'bs_mfa_recovery_codes';
