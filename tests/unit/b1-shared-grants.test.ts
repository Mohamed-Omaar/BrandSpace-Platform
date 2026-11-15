import { describe, expect, it } from 'vitest';
import { AppError } from '@brandspace/shared';
import { DownloadGrantIssuer, sharedExpiry } from '@brandspace/storage';

/**
 * B1 (owner, 2026-11-14) — AN IMAGE ON SCREEN KEEPS ONE URL FOR A WHILE.
 *
 * Every page render used to mint a new grant for every tile, so the browser
 * downloaded every picture again (792 image requests a minute on a Media page
 * with one pending file). An inline grant's expiry is now rounded UP to a
 * shared window, so the same picture issued again within it gets the SAME
 * token and the browser keeps the image it has. Never a shorter grant, and
 * `verify` refuses exactly what `redeem` refuses (bar the workspace, which
 * the image route checks against the SESSION).
 */

const KEY = 'unit-test-signing-key-not-a-secret';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const at = (iso: string) =>
  new DownloadGrantIssuer({ signingKey: KEY, clock: { now: () => new Date(iso) } });
const inline = (issuer: DownloadGrantIssuer, shareWindowSeconds?: number) =>
  issuer.issue({
    storageKey: 'ws/w/asset/a/v1',
    workspaceId: WORKSPACE,
    ttlSeconds: 300,
    disposition: 'inline',
    contentType: 'image/png',
    ...(shareWindowSeconds ? { shareWindowSeconds } : {}),
  });

describe('B1 · shared expiry', () => {
  it('rounds UP to the window, never down; no window leaves it as it is', () => {
    expect(sharedExpiry(1_000, 600)).toBe(1_200);
    expect(sharedExpiry(1_200, 600)).toBe(1_200);
    expect(sharedExpiry(1_201, 600)).toBe(1_800);
    expect(sharedExpiry(1_001, undefined)).toBe(1_001);
    expect(sharedExpiry(1_001, 0)).toBe(1_001);
  });

  it('two renders within the window get the SAME url; without a window they did not', () => {
    const first = inline(at('2026-11-14T12:00:05Z'), 600);
    const second = inline(at('2026-11-14T12:03:40Z'), 600);
    expect(second.token).toBe(first.token);
    expect(inline(at('2026-11-14T12:00:06Z')).token).not.toBe(
      inline(at('2026-11-14T12:00:07Z')).token,
    );
  });

  it('a shared grant is never shorter than its own lifetime', () => {
    const now = Date.parse('2026-11-14T12:09:59Z') / 1_000;
    const grant = inline(at('2026-11-14T12:09:59Z'), 600);
    const claims = at('2026-11-14T12:09:59Z').verify(grant.token);
    expect(claims.expiresAt - now).toBeGreaterThanOrEqual(300);
    expect(claims.expiresAt - now).toBeLessThanOrEqual(300 + 600);
  });
});

describe('B1 · verify refuses what redeem refuses', () => {
  it('tampered, malformed, expired: the same NOT_FOUND', () => {
    const grant = inline(at('2026-11-14T12:00:00Z'));
    for (const attempt of [
      () => at('2026-11-14T12:00:00Z').verify(`${grant.token}x`),
      () => at('2026-11-14T12:00:00Z').verify('not-a-token'),
      () => at('2026-11-14T12:06:00Z').verify(grant.token),
      () => new DownloadGrantIssuer({ signingKey: 'another-key' }).verify(grant.token),
    ]) {
      expect(attempt).toThrow(AppError);
      try {
        attempt();
      } catch (error) {
        expect((error as AppError).code).toBe('NOT_FOUND');
      }
    }
    expect(at('2026-11-14T12:00:00Z').verify(grant.token).workspaceId).toBe(WORKSPACE);
  });
});
