import { describe, expect, it } from 'vitest';
import { AssetDownloadService, type AssetActor, type AssetPolicy } from '@brandspace/assets';
import { DownloadGrantIssuer } from '@brandspace/storage';

/**
 * B1 (owner, 2026-11-14) — A PAGE THAT LISTS ASSETS GRANTS EACH TILE FROM THE
 * ROW IT ALREADY READ, with the same refusals `grantFor` makes: the
 * permission, another workspace, a deleted or unusable file, and the member's
 * brand scope (a workspace-level file, with no brand, is everyone's).
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BRAND_A = '33333333-3333-4333-8333-333333333333';
const BRAND_B = '44444444-4444-4444-8444-444444444444';

const issuer = new DownloadGrantIssuer({ signingKey: 'unit-test-signing-key-not-a-secret' });
const service = new AssetDownloadService({
  // The row is already loaded: this path never reads the database.
  db: {} as never,
  workspaceId: WORKSPACE,
  policy: { download: { grantTtlSeconds: 300 } } as unknown as AssetPolicy,
  issuer,
});

const actor = (over: Partial<AssetActor> = {}): AssetActor => ({
  userId: 'u',
  permissionKeys: ['assets.read'],
  brandScope: [],
  ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  storageKey: 'ws/w/asset/a/v1',
  mimeType: 'image/png',
  brandId: BRAND_A as string | null,
  status: 'READY' as const,
  scanStatus: 'CLEAN' as const,
  deletedAt: null as Date | null,
  workspaceId: WORKSPACE,
  ...over,
});

describe('B1 · inlineGrantForLoaded', () => {
  it('a ready, clean file in this workspace: an inline grant for it', () => {
    const grant = service.inlineGrantForLoaded(row() as never, actor());
    const claims = issuer.redeem(grant!.token, WORKSPACE);
    expect(claims).toMatchObject({
      storageKey: 'ws/w/asset/a/v1',
      disposition: 'inline',
      contentType: 'image/png',
    });
  });

  it('no assets.read: refused, as grantFor refuses', () => {
    expect(() =>
      service.inlineGrantForLoaded(row() as never, actor({ permissionKeys: [] })),
    ).toThrow();
  });

  it('another workspace, deleted, still processing, not scanned clean: no grant', () => {
    for (const over of [
      { workspaceId: OTHER },
      { deletedAt: new Date() },
      { status: 'PROCESSING' },
      { scanStatus: 'PENDING' },
      { scanStatus: 'INFECTED' },
    ]) {
      expect(service.inlineGrantForLoaded(row(over) as never, actor())).toBeNull();
    }
  });

  it('brand scope: another brand refused; its own brand and a workspace-level file allowed', () => {
    const scoped = actor({ brandScope: [BRAND_A] });
    expect(service.inlineGrantForLoaded(row({ brandId: BRAND_B }) as never, scoped)).toBeNull();
    expect(service.inlineGrantForLoaded(row({ brandId: BRAND_A }) as never, scoped)).not.toBeNull();
    expect(service.inlineGrantForLoaded(row({ brandId: null }) as never, scoped)).not.toBeNull();
  });
});
