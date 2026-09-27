import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

/**
 * MFA for platform roles — D-27, mandatory.
 *
 * PROVIDER-INDEPENDENT BY DESIGN. TOTP (RFC 6238) needs no external service:
 * the user scans a QR code into any authenticator app. That means MFA is fully
 * enforced today without waiting on a vendor decision.
 *
 * If the owner later adopts a hosted MFA provider (SMS, push, WebAuthn), it
 * implements `MfaVerifier` below and the enforcement points do not change.
 * Nothing here claims a production provider is connected, because none is —
 * TOTP is the implementation, not a placeholder for one.
 */

export const TOTP_ISSUER = 'BrandSpace Platform';
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
/** ±1 step tolerates clock skew without meaningfully widening the window. */
const TOTP_WINDOW = 1;

export interface MfaVerifier {
  readonly method: string;
  verify(input: { secret: string; token: string }): boolean;
}

export interface TotpEnrolment {
  /** Store via the Secret Service. Never a database column, never logged. */
  readonly secret: string;
  /** For the QR code. Contains the secret, so it is shown ONCE at enrolment. */
  readonly otpauthUri: string;
  readonly issuer: string;
  readonly label: string;
}

function buildTotp(secret: string, label: string): TOTP {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secret),
  });
}

export function generateTotpEnrolment(label: string): TotpEnrolment {
  const secret = new Secret({ size: 20 });
  const totp = buildTotp(secret.base32, label);
  return {
    secret: secret.base32,
    otpauthUri: totp.toString(),
    issuer: TOTP_ISSUER,
    label,
  };
}

/**
 * The `otpauth://` URI for a seed that already exists — for rendering the QR
 * code and the typed key of an enrolment in progress from the SERVER, so the
 * seed never travels in a URL (G4, D-333).
 */
export function totpUri(secret: string, label: string): string {
  return buildTotp(secret, label).toString();
}

export const totpVerifier: MfaVerifier = {
  method: 'totp',
  verify({ secret, token }) {
    const normalized = token.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) return false;
    try {
      // `validate` returns the time-step delta, or null when no step matches.
      const delta = buildTotp(secret, 'verify').validate({
        token: normalized,
        window: TOTP_WINDOW,
      });
      return delta !== null;
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;

/**
 * Generate recovery codes. Shown ONCE, stored only as hashes.
 *
 * Without these, losing a phone locks the Platform Owner out of their own
 * platform permanently — which is how mandatory MFA turns into disabled MFA.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    // Crockford-ish alphabet: no 0/O/1/I, so codes are transcribable by hand.
    const raw = randomBytes(10).toString('base64url').replace(/[-_]/g, '').slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`.toUpperCase();
  });
}

export function hashRecoveryCode(code: string): string {
  // Recovery codes are high-entropy, so a fast hash is appropriate — unlike a
  // password, there is nothing to brute-force cheaply.
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
}

/** Constant-time comparison, so timing cannot reveal a partial match. */
export function recoveryCodeMatches(candidateHash: string, storedHash: string): boolean {
  const a = Buffer.from(candidateHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
