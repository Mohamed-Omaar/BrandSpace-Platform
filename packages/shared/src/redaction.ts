/**
 * Redaction layer applied to EVERY log sink and error serializer.
 *
 * docs/SECURITY.md §5.1 rule 8: "Log sinks and error serializers run a redaction layer
 * keyed on field names and value patterns." Applied at the sink, not the call site, so a
 * developer cannot forget it.
 */

/** Field names whose values are always replaced, regardless of content. */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|secret|token|apikey|api_key|authorization|auth|credential|privatekey|private_key|clientsecret|client_secret|refreshtoken|refresh_token|accesstoken|access_token|sessionid|session_id|cookie|mfa|totp|otp|signature|salt|hash)/i;

/** Value shapes that look like credentials even under an innocuous key name. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // provider-style API keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub token
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, // bearer tokens
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  // A connection string with embedded credentials. These arrive inside driver
  // ERROR MESSAGES, not under a helpfully-named key, so the key pattern above
  // never sees them — which is exactly how a database password ends up in a log
  // line that everybody assumed was redacted.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]*/gi,
];

export const REDACTED = '[REDACTED]';

/** Maximum recursion depth; deeper structures are truncated rather than walked forever. */
const MAX_DEPTH = 8;

function redactString(value: string): string {
  let out = value;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Recursively redact a value. Returns a new structure; the input is never mutated.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }

  // functions, symbols — never logged
  return '[UNSERIALIZABLE]';
}

/**
 * Mask a secret down to audit-safe metadata.
 *
 * docs/SECURITY.md §5.1 rule 5: after saving, only masked metadata is ever readable.
 * Never returns enough of the value to be useful to an attacker.
 */
export function maskSecret(value: string): string {
  if (value.length <= 4) return REDACTED;
  return `…${value.slice(-4)}`;
}
