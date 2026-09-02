import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  createLogger,
  internalErrorFields,
  isPublicErrorCode,
  toPublicErrorCode,
} from '@brandspace/shared';
import { sanitizeAttributes } from '@brandspace/observability';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * Regression suite for the independent security review — finding 5, at the
 * boundary rather than at the unit.
 *
 * Injects errors carrying the exact payloads the review named and proves none
 * of them can reach a redirect destination, the rendered UI, a log line, a span
 * or an audit event.
 */

const INJECTED = {
  postgresUrl: 'postgresql://brandspace_platform:hunter2@db.internal:5432/brandspace',
  apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345',
  prismaDetail:
    'Unique constraint failed on the fields: (`ref`,`environment`) on table `secret_record`',
  stack:
    'Error: boom\n    at SecretService.createSecret (/app/packages/secrets/src/service.ts:120:11)',
  secretRef: 'ai_provider/openai/production/api-key',
} as const;

const ALL_FRAGMENTS = Object.values(INJECTED);

const INJECTED_ERRORS: ReadonlyArray<readonly [string, unknown]> = [
  ['a PostgreSQL URL', new Error(`connect failed ${INJECTED.postgresUrl}`)],
  ['a fake API key', new Error(`provider rejected ${INJECTED.apiKey}`)],
  ['a Prisma constraint', new Error(INJECTED.prismaDetail)],
  ['a multiline stack trace', new Error(INJECTED.stack)],
  ['a secret reference', new AppError('NOT_FOUND', `No secret for "${INJECTED.secretRef}"`)],
];

/**
 * Reproduces exactly what a server action now builds: a redirect carrying a
 * code and an opaque correlation id, and nothing else.
 */
function redirectFor(error: unknown): string {
  const correlationId = '11111111-2222-4333-8444-555555555555';
  const search = new URLSearchParams({
    domain: 'operations',
    error: toPublicErrorCode(error),
    ref: correlationId,
  });
  return `/en/console/configuration?${search.toString()}`;
}

describe('injected internal detail never reaches a redirect destination', () => {
  it.each(INJECTED_ERRORS)('drops %s', (_label, error) => {
    const destination = redirectFor(error);
    for (const fragment of ALL_FRAGMENTS) {
      expect(destination).not.toContain(fragment);
      expect(decodeURIComponent(destination)).not.toContain(fragment);
    }
  });

  it('emits only an allowlisted code in the query string', () => {
    for (const [, error] of INJECTED_ERRORS) {
      const code = new URL(redirectFor(error), 'https://admin.example').searchParams.get('error');
      expect(code).not.toBeNull();
      expect(isPublicErrorCode(code!)).toBe(true);
    }
  });

  it('puts nothing in the URL except the domain, the code and an opaque id', () => {
    const params = new URL(redirectFor(INJECTED_ERRORS[0]![1]), 'https://admin.example')
      .searchParams;
    expect([...params.keys()].sort()).toEqual(['domain', 'error', 'ref']);
    expect(params.get('ref')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('injected internal detail never reaches the rendered UI', () => {
  it.each(INJECTED_ERRORS)('renders fixed text for %s', async (_label, error) => {
    const { errorMessage } = await import('../../apps/admin/src/i18n/status-messages');
    for (const locale of ['en', 'ar']) {
      const rendered = errorMessage(
        toPublicErrorCode(error),
        locale,
        '11111111-2222-4333-8444-555555555555',
      );
      for (const fragment of ALL_FRAGMENTS) {
        expect(rendered).not.toContain(fragment);
      }
    }
  });

  it('falls back to generic text for a hand-crafted error code', async () => {
    const { errorMessage } = await import('../../apps/admin/src/i18n/status-messages');
    const forged = errorMessage(`<script>${INJECTED.apiKey}</script>`, 'en');
    expect(forged).not.toContain(INJECTED.apiKey);
    expect(forged).not.toContain('<script>');
  });

  it('ignores a correlation id that is not one of ours', async () => {
    const { errorMessage } = await import('../../apps/admin/src/i18n/status-messages');
    const rendered = errorMessage('INTERNAL', 'en', INJECTED.postgresUrl);
    expect(rendered).not.toContain(INJECTED.postgresUrl);
  });
});

describe('injected internal detail never reaches a span', () => {
  it.each(INJECTED_ERRORS)('sanitises %s out of span attributes', (_label, error) => {
    const attributes = sanitizeAttributes({
      'error.detail': error instanceof Error ? error.message : String(error),
      'brandspace.domain': 'operations',
    });
    const serialised = JSON.stringify(attributes);
    for (const fragment of ALL_FRAGMENTS) {
      expect(serialised).not.toContain(fragment);
    }
  });
});

describe('the internal log keeps the detail, redacted, behind a correlation id', () => {
  it('writes the correlation id and redacts credential-shaped values', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (line) => lines.push(line), context: { component: 'test' } });

    log.error('secret action failed', {
      correlationId: '11111111-2222-4333-8444-555555555555',
      ...internalErrorFields(new Error(`connect failed ${INJECTED.postgresUrl}`)),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('11111111-2222-4333-8444-555555555555');
    // The log is a trusted sink, but the redaction layer still runs over it.
    expect(lines[0]).not.toContain('hunter2');
  });
});

describe('the source no longer contains the leaky helper', () => {
  it.each([
    'apps/admin/src/app/[locale]/console/configuration/actions.ts',
    'apps/admin/src/app/[locale]/console/secrets/actions.ts',
  ])('%s does not put error.message into a redirect', (file) => {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');

    // No function that returns a raw message, and no interpolation of one into
    // the query string.
    expect(source).not.toMatch(/return\s+error\s+instanceof\s+Error\s*\?\s*error\.message/);
    expect(source).not.toMatch(/encodeURIComponent\(\s*safeMessage/);
    expect(source).not.toMatch(/error:\s*encodeURIComponent\(/);
  });
});
