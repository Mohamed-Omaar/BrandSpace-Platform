import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE EMAIL PROVIDER CACHE IS KEYED ON THE ACTIVATED VERSION — Phase 5.
 *
 * WHY THIS IS A SOURCE ASSERTION. `getEmailProvider` composes the platform
 * database, the configuration service and the secret vault; standing all three
 * up to prove one caching rule would test the scaffolding rather than the rule.
 * The behaviour that MATTERS across processes is proven against real PostgreSQL
 * in `tests/isolation/phase5-email-provider-staleness.test.ts`. What this file
 * pins is the shape that made the cross-process bug possible in the first place:
 * a cache keyed on time ALONE.
 *
 * THE DEFECT IT GUARDS. The provider was memoised for sixty seconds with no
 * reference to the configuration it was built from. Activation happens in the
 * Control Center; sending happens in the API. So an owner could connect Resend,
 * see success, and watch the API keep writing to the development outbox —
 * returning 200 from `/v1/internal/email/deliver` the whole time, because a
 * provider did accept the message. CI caught it as two `production-email`
 * failures where the fake Resend recorder received zero requests.
 */

const SOURCE = readFileSync(
  path.resolve(__dirname, '../../apps/api/src/email-provider.ts'),
  'utf8',
);

describe('the resolved provider is stamped with the configuration it came from', () => {
  it('reads the ACTIVE VERSION ID before answering from cache', () => {
    // `activeVersionId` is the uncached accessor — the only thing in the
    // configuration service that can tell a second process it is out of date.
    expect(SOURCE).toMatch(/activeVersionId\(\s*'integrations\.email'/);
  });

  it('carries the version on the cache entry', () => {
    expect(SOURCE).toMatch(/versionId/);
    expect(SOURCE).toMatch(/cached\.versionId === versionId/);
  });

  it('does NOT return a cached provider on time alone', () => {
    /*
     * The exact shape of the defect: `if (cached && cached.expiresAt > now)
     * return cached.provider;`. A time-only guard is what let an activation in
     * one process go unseen in another for a minute.
     */
    const timeOnlyGuard = /if\s*\(\s*cached\s*&&\s*cached\.expiresAt\s*>\s*now\s*\)/;
    expect(SOURCE).not.toMatch(timeOnlyGuard);
  });

  it('drops the configuration cache before rebuilding', () => {
    /*
     * Noticing the stamp is only half of it. `ConfigurationService` memoises
     * payloads for thirty seconds of its own, invalidated in the process that
     * ACTIVATED — not in this one. Without this the rebuild would read the
     * previous document and produce the stale provider again.
     */
    expect(SOURCE).toMatch(/invalidateCache\(\s*'integrations\.email'/);
  });

  it('states the rotation contract, because the TTL still bounds it', () => {
    // Rotating a credential does not change the document, so no stamp can see
    // it. That residual delay is a contract, and it is written down rather than
    // left for somebody to discover.
    expect(SOURCE).toMatch(/rotation/i);
  });
});
