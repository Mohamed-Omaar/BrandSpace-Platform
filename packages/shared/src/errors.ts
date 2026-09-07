/**
 * Typed application errors with stable, machine-readable codes.
 *
 * CLAUDE.md §5: "Errors are typed and mapped to stable machine-readable codes.
 * Never leak internals to clients."
 */

export const ERROR_CODES = [
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'CONFLICT',
  'RATE_LIMITED',
  'ENTITLEMENT_REQUIRED',
  'QUOTA_EXCEEDED',
  // Phase 3. The wallet cannot cover the action. D-11 makes this a hard stop:
  // there is no postpaid overage, so the only paths forward are a top-up or a
  // plan change, and the customer must be told which.
  'INSUFFICIENT_CREDITS',
  'TENANT_CONTEXT_MISSING',
  'TENANT_SCOPE_VIOLATION',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  ENTITLEMENT_REQUIRED: 402,
  QUOTA_EXCEEDED: 402,
  INSUFFICIENT_CREDITS: 402,
  TENANT_CONTEXT_MISSING: 500,
  TENANT_SCOPE_VIOLATION: 500,
  INTERNAL: 500,
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  /** Safe to serialize to the client. Never contains internals. */
  public readonly publicDetails: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: ErrorCode,
    message: string,
    publicDetails: Record<string, string | number | boolean> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.publicDetails = Object.freeze({ ...publicDetails });
  }

  /**
   * The client-facing shape. Deliberately omits `message` — the internal message
   * may contain detail that must not leak. Clients render from `code`.
   */
  toPublicJSON(requestId: string): {
    error: { code: ErrorCode; requestId: string; details: Record<string, unknown> };
  } {
    return {
      error: { code: this.code, requestId, details: { ...this.publicDetails } },
    };
  }
}

/**
 * Cross-tenant access must be indistinguishable from a genuine miss.
 *
 * docs/SECURITY.md §2.3: "Cross-tenant access returns a 404 with the same body and
 * timing characteristics as a genuine miss." Callers must use this for BOTH cases so
 * the two are byte-identical and no existence information leaks.
 */
export function notFound(resource: string): AppError {
  return new AppError('NOT_FOUND', `${resource} not found`, {});
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
