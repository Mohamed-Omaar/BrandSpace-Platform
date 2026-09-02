import { describe, expect, it } from 'vitest';
import {
  AppError,
  PUBLIC_ERROR_CODES,
  PublicError,
  internalErrorFields,
  isPublicErrorCode,
  toPublicErrorCode,
} from '@brandspace/shared';

/**
 * Regression suite for the independent security review — finding 5.
 *
 * `safeMessage()` returned `error.message` and the result went straight into a
 * redirect query parameter. These are the exact payloads that would have leaked
 * into the address bar, browser history, access logs and `Referer` headers.
 */

const LEAKY_ERRORS: ReadonlyArray<readonly [string, Error]> = [
  [
    'a PostgreSQL URL',
    new Error(
      'connect ECONNREFUSED: postgresql://brandspace_platform:hunter2@db.internal:5432/brandspace',
    ),
  ],
  ['a provider API key', new Error('provider rejected key sk-abcdefghijklmnopqrstuvwxyz012345')],
  [
    'a Prisma constraint and table name',
    new Error(
      'Invalid `prisma.secretRecord.create()` invocation: Unique constraint failed on the fields: (`ref`,`environment`) on table `secret_record`',
    ),
  ],
  [
    'a multiline stack trace',
    new Error(
      'boom\n    at SecretService.createSecret (/app/packages/secrets/src/service.ts:120:11)\n    at async createSecretAction',
    ),
  ],
  ['a secret reference', new Error('No secret configured for "ai_provider/openai/production/key"')],
  [
    'an encryption detail',
    new Error('Unsupported state or unable to authenticate data (AES-256-GCM)'),
  ],
];

/** Fragments that must never survive into anything client-facing. */
const FORBIDDEN_FRAGMENTS = [
  'postgresql://',
  'hunter2',
  'sk-abcdefghijklmnopqrstuvwxyz012345',
  'secret_record',
  'prisma',
  'service.ts',
  'ai_provider/openai/production/key',
  'aes-256-gcm',
  'econnrefused',
];

describe('no internal error text can reach the client', () => {
  it.each(LEAKY_ERRORS)('reduces %s to a fixed code', (_label, error) => {
    const code = toPublicErrorCode(error);

    expect(isPublicErrorCode(code)).toBe(true);
    expect(code).toBe('INTERNAL');
  });

  it.each(LEAKY_ERRORS)('leaks no fragment of %s into the emitted code', (_label, error) => {
    const code = toPublicErrorCode(error).toLowerCase();
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      expect(code).not.toContain(fragment);
    }
  });

  it('keeps every emitted code inside the published allowlist', () => {
    for (const [, error] of LEAKY_ERRORS) {
      expect(PUBLIC_ERROR_CODES).toContain(toPublicErrorCode(error));
    }
  });

  it('maps a non-Error throw to INTERNAL rather than stringifying it', () => {
    expect(toPublicErrorCode({ password: 'hunter2' })).toBe('INTERNAL');
    expect(toPublicErrorCode('postgresql://user:pw@host/db')).toBe('INTERNAL');
    expect(toPublicErrorCode(null)).toBe('INTERNAL');
  });
});

describe('errors that are deliberately meaningful to an operator', () => {
  it('maps an AppError code onto a public code, never its message', () => {
    const error = new AppError('VALIDATION_FAILED', 'trialDefaultDays must be >= 0 in table plans');
    expect(toPublicErrorCode(error)).toBe('INVALID_INPUT');
  });

  it('distinguishes a lost-update conflict so the operator knows to reload', () => {
    const conflict = new AppError('CONFLICT', 'This draft was changed by someone else', {
      expectedLockVersion: 3,
      actualLockVersion: 4,
    });
    expect(toPublicErrorCode(conflict)).toBe('CONCURRENT_EDIT');
  });

  it('keeps an ordinary conflict distinct from a concurrent edit', () => {
    expect(toPublicErrorCode(new AppError('CONFLICT', 'already exists'))).toBe('CONFLICT');
  });

  it('does NOT trust internal AppError codes', () => {
    for (const code of ['INTERNAL', 'TENANT_SCOPE_VIOLATION', 'TENANT_CONTEXT_MISSING'] as const) {
      expect(toPublicErrorCode(new AppError(code, 'internal detail here'))).toBe('INTERNAL');
    }
  });

  it('lets a handler choose a code explicitly', () => {
    expect(toPublicErrorCode(new PublicError('INVALID_JSON'))).toBe('INVALID_JSON');
  });
});

describe('the internal side keeps the detail, for logs only', () => {
  it('carries the message into log fields', () => {
    const fields = internalErrorFields(new Error('a detailed internal failure'));
    expect(fields['errorMessage']).toBe('a detailed internal failure');
    expect(fields['errorName']).toBe('Error');
  });

  it('handles a non-Error throw without crashing', () => {
    expect(internalErrorFields(42)['errorName']).toBe('UnknownError');
  });
});
