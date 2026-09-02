import { redact } from '@brandspace/shared';
import type { Attributes } from '@opentelemetry/api';

/**
 * Span attribute sanitiser.
 *
 * "No credentials, tokens or personal data in spans." Telemetry is shipped to a
 * third party and retained for weeks, so a secret that reaches a span is a
 * secret that has left the building. Every attribute passes through the same
 * redaction layer the logger uses, plus a hard deny-list of keys that must
 * never be recorded at all.
 */

/** Keys dropped entirely — not redacted, removed. */
const FORBIDDEN_ATTRIBUTE_KEYS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /credential/i,
  /authorization/i,
  /cookie/i,
  /session/i,
  /email/i,
  /phone/i,
  /\bdsn\b/i,
  /connection[_-]?string/i,
  /database[_-]?url/i,
  // Error DETAIL, as opposed to error TYPE. A driver message, a constraint
  // name, a secret ref or a stack frame is internal state; the error's name is
  // all a trace needs, and all `withSpan` records.
  /error\.(detail|message|stack|cause|body|response)/i,
  /\bstack\b/i,
];

/** Values that look like a connection string or credential, under any key. */
const FORBIDDEN_VALUE_PATTERNS = [
  /postgres(ql)?:\/\//i,
  /redis:\/\//i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bBearer\s+\S{16,}/i,
];

export function sanitizeAttributes(attributes: Attributes): Attributes {
  const safe: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    if (FORBIDDEN_ATTRIBUTE_KEYS.some((pattern) => pattern.test(key))) continue;

    if (typeof value === 'string') {
      if (FORBIDDEN_VALUE_PATTERNS.some((pattern) => pattern.test(value))) continue;
      // Cap length: a span is not a place for a payload.
      safe[key] = String(redact(value)).slice(0, 512);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      safe[key] = value;
    } else if (Array.isArray(value)) {
      safe[key] = value
        .filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map((v) =>
          typeof v === 'string' ? String(redact(v)).slice(0, 256) : v,
        ) as Attributes[string];
    }
  }
  return safe;
}
