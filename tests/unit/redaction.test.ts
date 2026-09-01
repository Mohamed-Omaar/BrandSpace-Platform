import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, maskSecret, redact } from '@brandspace/shared';

/**
 * The redaction layer is the last line of defence for CLAUDE.md §2.3:
 * "Secrets must never appear in logs, traces, analytics, error messages,
 *  stack traces, or API responses."
 */

describe('redact() by field name', () => {
  it.each([
    'password',
    'passwordHash',
    'apiKey',
    'api_key',
    'accessToken',
    'refresh_token',
    'clientSecret',
    'authorization',
    'mfaSecretRef',
    'sessionId',
    'cookie',
  ])('redacts the field %s regardless of its value', (field) => {
    const out = redact({ [field]: 'totally-innocuous-looking-value' }) as Record<string, unknown>;
    expect(out[field]).toBe(REDACTED);
  });

  it('leaves non-sensitive fields intact', () => {
    const out = redact({ workspaceId: 'ws-1', count: 3, active: true }) as Record<string, unknown>;
    expect(out).toEqual({ workspaceId: 'ws-1', count: 3, active: true });
  });
});

describe('redact() by value shape', () => {
  it.each([
    ['provider api key', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['aws access key', 'AKIAIOSFODNN7EXAMPLE'],
    ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
    [
      'jwt',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ],
  ])('redacts a %s even under an innocuous key name', (_label, value) => {
    const out = redact({ note: value }) as Record<string, unknown>;
    expect(out['note']).toBe(REDACTED);
  });

  it('redacts a private key block', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\n-----END PRIVATE KEY-----';
    expect(redact({ note: pem })).toEqual({ note: REDACTED });
  });
});

describe('redact() structure handling', () => {
  it('replaces a whole sensitive-named branch rather than walking into it', () => {
    // `credentials` matches the sensitive-key pattern, so the entire subtree is
    // replaced. That is deliberate: redacting the branch is safer than walking it
    // and hoping every leaf inside is also recognised.
    const out = redact({
      workspace: { name: 'Acme', credentials: [{ apiKey: 'secret-one' }] },
    }) as Record<string, Record<string, unknown>>;
    expect(out['workspace']?.['credentials']).toBe(REDACTED);
    expect(out['workspace']?.['name']).toBe('Acme');
  });

  it('walks nested objects and arrays under non-sensitive keys', () => {
    const out = redact({
      workspace: { name: 'Acme', members: [{ email: 'a@b.co', apiKey: 'secret-one' }] },
    }) as Record<string, Record<string, unknown>>;
    const members = out['workspace']?.['members'] as Record<string, unknown>[];
    expect(members[0]?.['apiKey']).toBe(REDACTED);
    expect(members[0]?.['email']).toBe('a@b.co');
    expect(out['workspace']?.['name']).toBe('Acme');
  });

  it('redacts inside Error messages and stacks', () => {
    const out = redact(new Error('failed with sk-abcdefghijklmnopqrstuvwxyz012345')) as Record<
      string,
      unknown
    >;
    expect(String(out['message'])).not.toContain('sk-abcdef');
    expect(String(out['message'])).toContain(REDACTED);
  });

  it('truncates rather than recursing forever on deep structures', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain('TRUNCATED');
  });

  it('does not mutate its input', () => {
    const input = { apiKey: 'secret-value' };
    redact(input);
    expect(input.apiKey).toBe('secret-value');
  });
});

describe('maskSecret()', () => {
  it('reveals only the last four characters', () => {
    expect(maskSecret('sk-live-abcdefghijklmnop-a91f')).toBe('…a91f');
  });

  it('reveals nothing for a value too short to mask safely', () => {
    expect(maskSecret('abc')).toBe(REDACTED);
  });
});

describe('logger applies redaction at the sink', () => {
  it('never emits a secret even when one is passed directly', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });

    log.info('saving credential', { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz012345' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('sk-abcdef');
    expect(lines[0]).toContain(REDACTED);
  });

  it('redacts secrets appearing in the message itself', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
    log.error('upstream rejected Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    expect(lines[0]).not.toContain('abcdefghijklmnop');
  });

  it('carries correlation context onto every line', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) }).child({
      requestId: 'req-1',
      workspaceId: 'ws-1',
    });
    log.info('hello');
    const parsed = JSON.parse(lines[0] ?? '{}');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.workspaceId).toBe('ws-1');
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    log.debug('noise');
    log.info('noise');
    log.warn('signal');
    expect(lines).toHaveLength(1);
  });
});
