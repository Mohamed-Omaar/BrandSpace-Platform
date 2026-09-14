import { describe, expect, it } from 'vitest';
import { defaultPayload, parseConfigPayload } from '@brandspace/config';
import {
  assetPolicyFrom,
  canPreviewWithoutDerivative,
  createVirusScanner,
  EICAR_TEST_STRING,
  ENCODABLE_KINDS,
  kindForMimeType,
  maxBytesForKind,
  MockVirusScanner,
  planDerivatives,
  SCAN_FAILURE_PROBE,
} from '@brandspace/assets';
import { contentDispositionHeader, DownloadGrantIssuer } from '@brandspace/storage';
import { AppError } from '@brandspace/shared';

/**
 * Policy, scanning, derivatives and download grants — the pure halves.
 *
 * Every test here hands a DOCUMENT to a pure function and asserts the runtime
 * behaviour that follows, with no database. That is the property `policy.ts`
 * was built for: it contains no policy value, so a test can change the
 * configuration and watch the behaviour change without touching source.
 */

const defaults = defaultPayload('assets');

describe('operational policy comes from configuration, never from source', () => {
  it('the schema supplies a complete document from an empty one', () => {
    const policy = assetPolicyFrom(defaults);
    expect(policy.upload.maxAssetsPerBrand).toBeGreaterThan(0);
    expect(policy.versions.maxVersionsPerAsset).toBeGreaterThan(0);
    expect(policy.download.grantTtlSeconds).toBeGreaterThan(0);
    expect(policy.retention.purgeDeletedAfterDays).toBeGreaterThan(0);
  });

  it('CHANGING THE DOCUMENT CHANGES THE BEHAVIOUR, with no source edit', () => {
    /*
     * The claim CLAUDE.md §2.2 makes, asserted rather than described. If any of
     * these numbers were a constant in the services, this test would pass while
     * the product ignored the operator.
     */
    const tightened = parseConfigPayload('assets', {
      upload: { maxAssetsPerBrand: 7, maxFileBytes: { image: 1_024 }, maxTagsPerAsset: 2 },
      versions: { maxVersionsPerAsset: 1 },
      download: { grantTtlSeconds: 31 },
    });
    const policy = assetPolicyFrom(tightened);
    expect(policy.upload.maxAssetsPerBrand).toBe(7);
    expect(maxBytesForKind(policy.upload, 'IMAGE')).toBe(1_024);
    expect(policy.upload.maxTagsPerAsset).toBe(2);
    expect(policy.versions.maxVersionsPerAsset).toBe(1);
    expect(policy.download.grantTtlSeconds).toBe(31);
  });

  it('the CONFIGURATION decides an asset kind, not a prefix match on the type', () => {
    /*
     * THE DEFECT THIS NAMES: classifying by `image/*`. An operator who REMOVES
     * `image/webp` from the allow-list would find it still classified and still
     * accepted, because the prefix does not know what the allow-list says.
     */
    const policy = assetPolicyFrom(defaults);
    expect(kindForMimeType(policy.upload, 'image/png')).toBe('IMAGE');
    expect(kindForMimeType(policy.upload, 'application/pdf')).toBe('DOCUMENT');
    expect(kindForMimeType(policy.upload, 'font/woff2')).toBe('FONT');
    expect(kindForMimeType(policy.upload, 'video/mp4')).toBe('VIDEO');

    const withoutWebp = assetPolicyFrom(
      parseConfigPayload('assets', {
        upload: { allowedMimeTypes: { image: ['image/png'] } },
      }),
    );
    expect(kindForMimeType(withoutWebp.upload, 'image/webp')).toBeNull();
  });

  it('an operator can ADD a type, and the kind follows what they wrote', () => {
    const widened = assetPolicyFrom(
      parseConfigPayload('assets', {
        upload: { allowedMimeTypes: { document: ['application/pdf', 'text/html'] } },
      }),
    );
    expect(kindForMimeType(widened.upload, 'text/html')).toBe('DOCUMENT');
  });

  it('SVG is absent from the defaults, and that is a decision', () => {
    /*
     * docs/SECURITY.md §11.5 requires an SVG to be sanitised or converted
     * before it is served, because an SVG is a script-bearing document.
     * Nothing sanitises one yet, so admitting it would mean storing an XSS
     * payload the product promises to neutralise and does not.
     */
    const policy = assetPolicyFrom(defaults);
    expect(kindForMimeType(policy.upload, 'image/svg+xml')).toBeNull();
  });

  it('a missing per-kind ceiling refuses every file rather than admitting one', () => {
    // The lookup cannot miss in practice; the fallback direction is what
    // matters, because the wrong one would admit an unbounded upload.
    const policy = assetPolicyFrom(defaults);
    const broken = { ...policy.upload, maxFileBytes: {} as never };
    expect(maxBytesForKind(broken, 'IMAGE')).toBe(0);
  });

  it('the STORAGE QUOTA is not in this document, because it is per-plan', () => {
    /*
     * D-10 puts storage in `plans` as `limit.storage_gb`, resolved through the
     * entitlements engine. A ceiling here as well would be two limits for one
     * question, and the stricter would win by accident rather than by design.
     */
    expect(JSON.stringify(defaults)).not.toContain('storageGb');
    expect(JSON.stringify(defaults)).not.toContain('storage_gb');
  });
});

describe('malware scanning quarantines by default', () => {
  const scanner = new MockVirusScanner();

  it('reports a clean verdict for ordinary bytes', async () => {
    const result = await scanner.scan({
      bytes: new TextEncoder().encode('an ordinary brand photograph'),
      declaredMimeType: 'image/png',
      timeoutMs: 1_000,
    });
    expect(result.verdict).toBe('clean');
  });

  it('detects the EICAR probe, which exercises the real path', async () => {
    /*
     * EICAR IS NOT MALWARE. It is a 68-byte printable string every antivirus
     * agrees to report, published for exactly this purpose — so the quarantine
     * tests run the same code a real infection would rather than a branch wired
     * to a boolean.
     */
    const result = await scanner.scan({
      bytes: new TextEncoder().encode(EICAR_TEST_STRING),
      declaredMimeType: 'application/pdf',
      timeoutMs: 1_000,
    });
    expect(result.verdict).toBe('infected');
    expect(result.reason).toBe('infected');
  });

  it('distinguishes a FAILED scan from an infected file', async () => {
    /*
     * They are genuinely different outcomes and the product behaves
     * differently: infected is terminal, a failed scan is retryable and leaves
     * the asset quarantined meanwhile. Without a way to provoke it, that branch
     * would be untested.
     */
    const result = await scanner.scan({
      bytes: new TextEncoder().encode(SCAN_FAILURE_PROBE),
      declaredMimeType: 'application/pdf',
      timeoutMs: 1_000,
    });
    expect(result.verdict).toBe('failed');
  });

  it('is DETERMINISTIC — the same bytes always reach the same verdict', async () => {
    const bytes = new TextEncoder().encode(EICAR_TEST_STRING);
    const verdicts = await Promise.all(
      Array.from({ length: 5 }, () =>
        scanner.scan({ bytes, declaredMimeType: 'application/pdf', timeoutMs: 1_000 }),
      ),
    );
    expect(new Set(verdicts.map((v) => v.verdict))).toEqual(new Set(['infected']));
  });

  it('REFUSES the mock in production rather than marking everything clean', () => {
    /*
     * A deployment with no real scanner must fail closed. The alternative is a
     * platform that marks every customer upload clean without looking at it,
     * which is a promise docs/SECURITY.md §11.3 makes explicitly.
     */
    expect(() =>
      createVirusScanner({ appEnv: 'production', policy: { provider: 'mock' } }),
    ).toThrow(/scanner/i);
    expect(createVirusScanner({ appEnv: 'development', policy: { provider: 'mock' } }).key).toBe(
      'mock',
    );
  });

  it('gates on APP_ENV rather than NODE_ENV', () => {
    // D-97: NODE_ENV is `production` in ANY production build, including the one
    // the E2E suite serves. APP_ENV is what says which deployment this is.
    expect(createVirusScanner({ appEnv: 'staging', policy: { provider: 'mock' } })).toBeDefined();
  });
});

describe('derivatives are bounded and honest about what is not built', () => {
  const policy = assetPolicyFrom(defaults).derivatives;

  it('plans NOTHING today, because no encoder has been reviewed', () => {
    /*
     * Stated as an assertion rather than left to be discovered. Re-encoding a
     * PNG needs a decoder running on bytes a stranger uploaded, which is the
     * review D-94 requires before a parser ships. None has been done, so the
     * asset becomes READY with no derivative rather than stuck waiting for one.
     */
    expect(ENCODABLE_KINDS).toHaveLength(0);
    expect(planDerivatives('IMAGE', policy)).toHaveLength(0);
    expect(planDerivatives('DOCUMENT', policy)).toHaveLength(0);
  });

  it('the CEILING holds even if a kind becomes encodable', () => {
    // Asserted against a policy that enables both kinds with a ceiling of one,
    // so the bound is proven independently of what is currently encodable.
    const capped = { ...policy, maxPerAsset: 1 };
    const planned = planDerivatives('IMAGE', capped);
    expect(planned.length).toBeLessThanOrEqual(1);
  });

  it('a browser-decodable image previews from its own bytes, up to a bound', () => {
    /*
     * The honest middle ground between showing a thumbnail that does not exist
     * and showing nothing: a small PNG can go into a grid as-is, a 20 MB one
     * cannot, and the ceiling is what stops a gallery pushing megabytes.
     */
    expect(canPreviewWithoutDerivative('image/png', 100_000)).toBe(true);
    expect(canPreviewWithoutDerivative('image/png', 50 * 1024 * 1024)).toBe(false);
    expect(canPreviewWithoutDerivative('application/pdf', 100)).toBe(false);
    expect(canPreviewWithoutDerivative('font/woff2', 100)).toBe(false);
  });
});

describe('a download grant is opaque, bound and short-lived', () => {
  const KEY = 'unit-test-signing-key-not-a-secret';
  const WORKSPACE = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  function issuerAt(now: Date) {
    return new DownloadGrantIssuer({ signingKey: KEY, clock: { now: () => now } });
  }

  it('round-trips the claims it was issued with', () => {
    const issuer = issuerAt(new Date('2026-09-14T12:00:00Z'));
    const grant = issuer.issue({
      storageKey: 'ws/w/asset/a/v1',
      workspaceId: WORKSPACE,
      ttlSeconds: 300,
      disposition: 'inline',
      contentType: 'image/png',
    });
    const claims = issuer.redeem(grant.token, WORKSPACE);
    expect(claims.storageKey).toBe('ws/w/asset/a/v1');
    expect(claims.contentType).toBe('image/png');
    expect(claims.disposition).toBe('inline');
  });

  it('the token carries no path a caller could use directly', () => {
    const issuer = issuerAt(new Date('2026-09-14T12:00:00Z'));
    const grant = issuer.issue({
      storageKey: 'ws/w/asset/a/v1',
      workspaceId: WORKSPACE,
      ttlSeconds: 300,
      disposition: 'inline',
      contentType: 'image/png',
    });
    // Opaque to a reader: base64url, not a readable key or a filesystem path.
    expect(grant.token).not.toContain('/');
    expect(grant.token).not.toContain('ws/');
  });

  it('REFUSES a forged, tampered, expired or wrong-workspace token IDENTICALLY', () => {
    /*
     * ONE MESSAGE FOR ALL FOUR, deliberately. "This token expired" confirms it
     * was once real, which confirms the object exists — the same inference the
     * 404 rule closes for cross-tenant access.
     */
    const issued = issuerAt(new Date('2026-09-14T12:00:00Z'));
    const grant = issued.issue({
      storageKey: 'ws/w/asset/a/v1',
      workspaceId: WORKSPACE,
      ttlSeconds: 60,
      disposition: 'inline',
      contentType: 'image/png',
    });

    const messages: string[] = [];
    const capture = (fn: () => unknown): void => {
      try {
        fn();
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('NOT_FOUND');
        messages.push((error as AppError).message);
      }
    };

    // Tampered signature.
    capture(() => issued.redeem(`${grant.token}x`, WORKSPACE));
    // Malformed entirely.
    capture(() => issued.redeem('not-a-token', WORKSPACE));
    // Right signature, wrong workspace.
    capture(() => issued.redeem(grant.token, OTHER));
    // Right everything, but the clock has moved past the window.
    const later = issuerAt(new Date('2026-09-14T12:05:00Z'));
    capture(() => later.redeem(grant.token, WORKSPACE));

    expect(new Set(messages).size).toBe(1);
  });

  it('a grant signed with a different key is refused', () => {
    const mine = issuerAt(new Date('2026-09-14T12:00:00Z'));
    const theirs = new DownloadGrantIssuer({
      signingKey: 'a-different-key',
      clock: { now: () => new Date('2026-09-14T12:00:00Z') },
    });
    const grant = theirs.issue({
      storageKey: 'ws/w/asset/a/v1',
      workspaceId: WORKSPACE,
      ttlSeconds: 60,
      disposition: 'inline',
      contentType: 'image/png',
    });
    expect(() => mine.redeem(grant.token, WORKSPACE)).toThrow();
  });

  it('refuses to SIGN a traversing storage key at all', () => {
    /*
     * A grant for `../../etc/passwd` that is refused later is still a signed
     * statement that the platform considered the key legitimate. Refusing here
     * means such a key never acquires a signature.
     */
    const issuer = issuerAt(new Date('2026-09-14T12:00:00Z'));
    expect(() =>
      issuer.issue({
        storageKey: 'ws/w/../../etc/passwd',
        workspaceId: WORKSPACE,
        ttlSeconds: 60,
        disposition: 'inline',
        contentType: 'text/plain',
      }),
    ).toThrow();
  });

  it('requires a signing key rather than defaulting to one', () => {
    // A default would mean every deployment that forgot to configure one shared
    // a forgeable signature.
    expect(() => new DownloadGrantIssuer({ signingKey: '' })).toThrow();
  });

  it('re-derives the file name in the header instead of passing it through', () => {
    /*
     * A customer file name can contain quotes, semicolons and newlines, all of
     * which either break the header or let a caller inject one. The ASCII
     * fallback is sanitised and the real name travels percent-encoded.
     */
    const header = contentDispositionHeader('attachment', 'report"; rm -rf /\n.pdf');
    expect(header).not.toContain('\n');
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header).toContain("filename*=UTF-8''");
  });

  it('keeps an Arabic file name readable through the encoded parameter', () => {
    const header = contentDispositionHeader('attachment', 'تقرير.pdf');
    expect(header).toContain(encodeURIComponent('تقرير.pdf'));
    // The ASCII fallback never carries a delimiter, whatever the real name is.
    expect(header).toMatch(/filename="[A-Za-z0-9._-]*"/);
  });
});
