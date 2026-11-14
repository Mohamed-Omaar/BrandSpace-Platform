import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoVirusScanner, ScaniiVirusScanner, createVirusScanner } from '@brandspace/assets';
import { defaultPayload, validateConfiguration } from '@brandspace/config';
import { servedUploadDisposition } from '../../apps/dashboard/src/server/served-upload';

/**
 * PR F (g), Q13 — the scanner choice, the Scanii adapter, and the two
 * protections that stay while scanning is off.
 */

const ROOT = join(__dirname, '..', '..');
const source = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function assetsIssues(scanning: Record<string, unknown>) {
  const payload = { ...(defaultPayload('assets') as Record<string, unknown>), scanning };
  return validateConfiguration('assets', payload, {} as never).issues.filter(
    (issue) => issue.severity === 'error',
  );
}

describe('the scanner configuration', () => {
  it('"none" must be said twice: provider none AND required false', () => {
    expect(assetsIssues({ required: false, provider: 'none', timeoutMs: 30_000 })).toEqual([]);
    expect(assetsIssues({ required: true, provider: 'none', timeoutMs: 30_000 })).not.toEqual([]);
    expect(assetsIssues({ required: false, provider: 'mock', timeoutMs: 30_000 })).not.toEqual([]);
  });

  it('Scanii needs its URL, and the URL is never assumed', () => {
    expect(assetsIssues({ required: true, provider: 'scanii', timeoutMs: 30_000 })).not.toEqual([]);
    expect(
      assetsIssues({
        required: true,
        provider: 'scanii',
        timeoutMs: 30_000,
        scanii: { endpoint: 'https://scanner.example/v2.2/files' },
      }),
    ).toEqual([]);
    const defaults = defaultPayload('assets') as { scanning: { scanii: { endpoint: unknown } } };
    expect(defaults.scanning.scanii.endpoint).toBeNull();
  });
});

describe('createVirusScanner', () => {
  it('"none" is allowed in production and marks every file not scanned', async () => {
    const scanner = createVirusScanner({ appEnv: 'production', policy: { provider: 'none' } });
    expect(scanner).toBeInstanceOf(NoVirusScanner);
    await expect(
      scanner.scan({ bytes: new Uint8Array([1]), declaredMimeType: 'image/png', timeoutMs: 1_000 }),
    ).resolves.toEqual({ verdict: 'clean', notScanned: true });
  });

  it('Scanii refuses to start without its URL or its credentials', () => {
    expect(() =>
      createVirusScanner({ appEnv: 'production', policy: { provider: 'scanii' } }),
    ).toThrow(/not configured/);
    expect(() =>
      createVirusScanner({
        appEnv: 'production',
        policy: { provider: 'scanii', scaniiEndpoint: 'https://scanner.example/v2.2/files' },
        scaniiCredentials: { apiKey: '', apiSecret: '' },
      }),
    ).toThrow(/not configured/);
    expect(
      createVirusScanner({
        appEnv: 'production',
        policy: { provider: 'scanii', scaniiEndpoint: 'https://scanner.example/v2.2/files' },
        scaniiCredentials: { apiKey: 'k', apiSecret: 's' },
      }),
    ).toBeInstanceOf(ScaniiVirusScanner);
  });
});

describe('the Scanii adapter', () => {
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const scan = (fetchDouble: typeof fetch) =>
    new ScaniiVirusScanner({
      endpoint: 'https://scanner.example/v2.2/files',
      apiKey: 'key',
      apiSecret: 'secret',
      fetch: fetchDouble,
    }).scan({ bytes: new Uint8Array([1, 2, 3]), declaredMimeType: 'image/png', timeoutMs: 1_000 });

  it('no findings is clean; any finding is a detection', async () => {
    await expect(scan(answer(201, { findings: [] }))).resolves.toEqual({ verdict: 'clean' });
    await expect(scan(answer(201, { findings: ['x'] }))).resolves.toEqual({
      verdict: 'infected',
      reason: 'infected',
    });
  });

  it('an unreadable answer fails the scan; a refusal throws (retryable), naming no credential', async () => {
    await expect(scan(answer(201, { nothing: true }))).resolves.toEqual({
      verdict: 'failed',
      reason: 'scan_failed',
    });
    const refused = scan(answer(401, { message: 'bad key' }));
    await expect(refused).rejects.toThrow('The scanner answered 401.');
    await expect(refused).rejects.not.toThrow(/key|secret/);
  });

  it('sends the file as multipart "file" with Basic credentials', async () => {
    let seen: { authorization: string | null; file: Blob | null } | null = null;
    await scan((async (_url: string, init?: RequestInit) => {
      seen = {
        authorization: new Headers(init?.headers).get('authorization'),
        file: (init?.body as FormData).get('file') as Blob,
      };
      return new Response(JSON.stringify({ findings: [] }), { status: 201 });
    }) as unknown as typeof fetch);
    expect(seen!.authorization).toBe(`Basic ${Buffer.from('key:secret').toString('base64')}`);
    expect(seen!.file?.size).toBe(3);
  });
});

describe('a served upload is never inline', () => {
  it('the disposition is always attachment', () => {
    expect(servedUploadDisposition('photo.png')).toMatch(/^attachment; filename="photo\.png"/);
  });

  it.each([
    'apps/dashboard/src/app/[locale]/assets/file/[token]/route.ts',
    'apps/dashboard/src/app/[locale]/assets/font/[token]/route.ts',
  ])('%s serves through servedUploadDisposition, with nosniff and no inline', (path) => {
    const route = source(path);
    expect(route).toContain("'content-disposition': servedUploadDisposition(");
    expect(route).toContain("'x-content-type-options': 'nosniff'");
    expect(route).not.toMatch(/contentDispositionHeader\(/);
    expect(route).not.toMatch(/['"]inline['"]/);
  });
});

describe('an upload never looks frozen', () => {
  it('the status check slows down, and when it stops it SAYS so (B1, owner 2026-11-14)', () => {
    // B1 replaced the endless page refresh with a status check that backs off
    // and, after ten minutes, stops with a visible "Still working — refresh to
    // check" and a Refresh button: never a silent stop. The timing itself is
    // proven in tests/unit/b1-pending-poll.test.ts.
    const poll = source('apps/dashboard/src/components/pending-poll.ts');
    expect(poll).toContain('PENDING_MAX_DELAY_MS = 15_000');
    expect(poll).toContain('host.onStopped()');
    const watch = source('apps/dashboard/src/components/pending-watch.tsx');
    expect(watch).toContain("t('pending.stillWorking')");
    expect(watch).toContain('data-testid="pending-refresh"');
    expect(watch).toContain('role="status"');
  });

  it('every upload form says, while files are not scanned, that they are not', () => {
    const field = source('apps/dashboard/src/components/upload-field.tsx');
    expect(field).toContain('{rules.notScanned ? <UploadNotScannedLine /> : null}');
    expect(field).toContain('/terms#uploads');
  });
});
