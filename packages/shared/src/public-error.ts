import { AppError } from './errors';

/**
 * The boundary between an internal error and anything a browser can see.
 *
 * The independent security review found server actions doing this:
 *
 *     function safeMessage(error: unknown) { return error.message; }
 *     redirect(`...?error=${encodeURIComponent(safeMessage(error))}`);
 *
 * The name said "safe"; the implementation was a pass-through. A Prisma
 * constraint message, a `postgresql://` connection string, a provider response
 * or a stack trace would go straight into the address bar — and from there into
 * browser history, access logs, the `Referer` header of the next request,
 * screenshots and support tickets.
 *
 * `AppError.toPublicJSON()` already omits `message` for exactly this reason.
 * This module applies the same rule to the redirect path: a fixed CODE from a
 * closed set travels to the client, the real error is logged once with a
 * correlation id, and the two are joined up by that id when someone
 * investigates.
 */

/** Every code a client may ever receive. Nothing outside this list is emitted. */
export const PUBLIC_ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_JSON',
  'CONCURRENT_EDIT',
  'CONFLICT',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
] as const;

export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

export function isPublicErrorCode(value: string): value is PublicErrorCode {
  return (PUBLIC_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * An `AppError` carrying this flag has a code that is meaningful to an
 * operator, so the mapping below may use it. Anything else becomes INTERNAL.
 */
const APP_ERROR_CODE_MAP: Partial<Record<string, PublicErrorCode>> = {
  VALIDATION_FAILED: 'INVALID_INPUT',
  CONFLICT: 'CONFLICT',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  // TENANT_*, INTERNAL, ENTITLEMENT_REQUIRED and QUOTA_EXCEEDED deliberately
  // fall through to INTERNAL: their messages describe internal state.
};

/**
 * A public error explicitly raised by our own code, with a chosen code.
 *
 * Use this when a handler wants a specific public outcome — "that JSON does not
 * parse" — rather than letting a parser's own message decide.
 */
export class PublicError extends Error {
  constructor(readonly publicCode: PublicErrorCode) {
    super(`Public error: ${publicCode}`);
    this.name = 'PublicError';
  }
}

/**
 * Classify any thrown value into a code that is safe to put in a URL.
 *
 * NEVER returns text derived from the error. The only free variable in the
 * result is the correlation id, which the caller generates.
 */
export function toPublicErrorCode(error: unknown): PublicErrorCode {
  if (error instanceof PublicError) return error.publicCode;

  if (error instanceof AppError) {
    // A lost-update conflict is worth distinguishing: the operator must reload
    // rather than retry, and saying so costs nothing.
    if (error.code === 'CONFLICT' && 'expectedLockVersion' in error.publicDetails) {
      return 'CONCURRENT_EDIT';
    }
    return APP_ERROR_CODE_MAP[error.code] ?? 'INTERNAL';
  }

  return 'INTERNAL';
}

/**
 * What to log for an error that is about to be reduced to a code.
 *
 * The message is included because logs are a trusted sink and the redaction
 * layer runs over them; the point is that this NEVER travels to a browser.
 */
export function internalErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorName: 'UnknownError', errorMessage: String(error) };
}
