import type { Asset, TenantScopedClient } from '@brandspace/database';
import type { DownloadDisposition, DownloadGrant, DownloadGrantIssuer } from '@brandspace/storage';
import { assertAssetBrandInScope, assertPermission, type AssetActor } from './actor';
import { assetNotFound, assetNotUsable } from './errors';
import { isSelectable } from './library';
import type { AssetPolicy } from './policy';

/**
 * Authorised, time-limited download.
 *
 * THIS IS WHERE THE AUTHORISATION DECISION IS MADE, ONCE. Permission, brand
 * scope, lifecycle and scan verdict are all checked here; the grant that comes
 * out is the record of that decision, and redeeming it re-checks only signature,
 * expiry and workspace (see `DownloadGrantIssuer`). Splitting it that way is
 * deliberate: a redemption path that re-derives authorisation is a second
 * authorisation implementation, and two of those disagree eventually.
 *
 * NOTHING UNSCANNED IS EVER SERVED. `isSelectable` requires READY and CLEAN,
 * and it is the same function the Content Studio and the publisher will call.
 * A file that is quarantined, still processing, failed or archived has no
 * grant, so there is no path to its bytes at all — not a broken one, none.
 *
 * A DOWNLOAD IS NOT AUDITED PER REQUEST, and that is a considered choice rather
 * than an omission. A library page issues a grant per tile, so auditing each
 * would write hundreds of rows per screen and bury the events that matter —
 * upload, version, archive, restore, delete and scan outcome — in noise.
 * docs/SECURITY.md §11 asks for controlled access, which is what the grant is;
 * CLAUDE.md §5 asks for an audit event per MUTATION, and reading is not one.
 */

export interface AssetDownloadServiceOptions {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly policy: AssetPolicy;
  readonly issuer: DownloadGrantIssuer;
}

export class AssetDownloadService {
  readonly #db: TenantScopedClient;
  readonly #workspaceId: string;
  readonly #policy: AssetPolicy;
  readonly #issuer: DownloadGrantIssuer;

  constructor(options: AssetDownloadServiceOptions) {
    this.#db = options.db;
    this.#workspaceId = options.workspaceId;
    this.#policy = options.policy;
    this.#issuer = options.issuer;
  }

  /**
   * Issue a grant for an asset's current bytes.
   *
   * `disposition` decides how the browser treats them, and it is the CALLER's
   * decision rather than the file's: a preview pane wants `inline`, a download
   * button wants `attachment`. It is never derived from the file name, which is
   * customer input.
   */
  async grantFor(input: {
    readonly assetId: string;
    readonly actor: AssetActor;
    readonly disposition: DownloadDisposition;
  }): Promise<{ asset: Asset; grant: DownloadGrant }> {
    assertPermission(input.actor, 'assets.read');

    const asset = await this.#db.asset.findUnique({ where: { id: input.assetId } });
    // Another workspace's asset is invisible to RLS and arrives as null — the
    // same answer a missing one gives.
    if (!asset || asset.deletedAt !== null) throw assetNotFound();
    assertAssetBrandInScope(input.actor, asset.brandId);
    if (!isSelectable(asset)) throw assetNotUsable();

    const grant = this.#issuer.issue({
      storageKey: asset.storageKey,
      workspaceId: this.#workspaceId,
      ttlSeconds: this.#policy.download.grantTtlSeconds,
      disposition: input.disposition,
      /*
       * THE TYPE IS THE ONE THE SIGNATURE PROVED AT UPLOAD, pinned into the
       * grant. Serving a stored value rather than sniffing at read time means a
       * later edit to the row cannot change what an already-issued grant
       * serves, and means nothing ever re-derives a type from a file name.
       */
      contentType: asset.mimeType,
    });

    return { asset, grant };
  }

  /**
   * Issue a grant for one historical version.
   *
   * THE VERSION'S OWN SCAN VERDICT DECIDES, not the asset's. An asset that is
   * clean today may have a version that was never cleared — a failed scan, an
   * upload that was superseded before the scanner ran — and serving it because
   * the CURRENT bytes are fine would hand out exactly the file quarantine was
   * protecting against.
   */
  async grantForVersion(input: {
    readonly assetId: string;
    readonly versionNumber: number;
    readonly actor: AssetActor;
    readonly disposition: DownloadDisposition;
  }): Promise<DownloadGrant> {
    assertPermission(input.actor, 'assets.read');

    const asset = await this.#db.asset.findUnique({ where: { id: input.assetId } });
    if (!asset || asset.deletedAt !== null) throw assetNotFound();
    assertAssetBrandInScope(input.actor, asset.brandId);

    const version = await this.#db.assetVersion.findFirst({
      where: { assetId: asset.id, versionNumber: input.versionNumber },
    });
    if (!version) throw assetNotFound();
    if (version.scanStatus !== 'CLEAN') throw assetNotUsable();

    return this.#issuer.issue({
      storageKey: version.storageKey,
      workspaceId: this.#workspaceId,
      ttlSeconds: this.#policy.download.grantTtlSeconds,
      disposition: input.disposition,
      contentType: version.mimeType,
    });
  }
}
