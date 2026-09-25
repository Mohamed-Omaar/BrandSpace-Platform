/**
 * The Asset Library's object-storage layout.
 *
 * WORKSPACE FIRST, AND NOT NEGOTIABLE. A prefix that starts with the tenant is
 * what lets an object-store policy be written per tenant at all, and what makes
 * a mis-scoped read visible as a wrong prefix rather than as a plausible key
 * (docs/SECURITY.md §11.7 — "storage keys are workspace-prefixed").
 *
 * EVERY SEGMENT IS AN IDENTIFIER, AND NONE IS A FILE NAME. The customer's name
 * for the file is display metadata; it lives in the database column and never
 * in the key. That is what makes the key safe by construction rather than by a
 * sanitiser somebody has to remember to call: a UUID cannot traverse, cannot
 * carry a separator, cannot collide across tenants and cannot be guessed from
 * the listing screen.
 *
 * THE VERSION IS IN THE KEY. An asset's bytes are immutable once written, and a
 * new version is a new object rather than an overwrite — which is what lets
 * `asset_version` be an append-only history that can actually be restored. An
 * overwrite would make every historical row point at whatever was written last.
 */

/** Where the bytes of one version of one asset live. */
export function assetObjectKey(input: {
  workspaceId: string;
  /** NULL for a workspace-level asset. */
  brandId: string | null;
  assetId: string;
  versionNumber: number;
}): string {
  /*
   * A WORKSPACE-LEVEL ASSET GETS ITS OWN PREFIX rather than a placeholder
   * inside the brand one. `ws/<id>/brand/none/...` would mean a brand that a
   * customer later names "none" shares a prefix with every unfiled asset in
   * their workspace, and a per-brand retention or access policy written against
   * that prefix would then apply to the wrong objects.
   */
  const scope =
    input.brandId === null
      ? `ws/${input.workspaceId}`
      : `ws/${input.workspaceId}/brand/${input.brandId}`;
  return `${scope}/asset/${input.assetId}/v${input.versionNumber}`;
}

/**
 * Where the bytes of a version ADDED to an existing asset live — one key per
 * upload ATTEMPT (B-1).
 *
 * WHY NOT `assetObjectKey`. Two uploads racing on the same asset both compute
 * the same next version number. With the number alone in the key they would
 * write the SAME object: the loser's bytes could overwrite the winner's after
 * the winner had already recorded its checksum, and the database would then
 * describe an object that no longer exists. The attempt id makes every write
 * land somewhere only that attempt owns, so a loser can never touch a winner's
 * object — and so a failed attempt can delete its own object knowing nothing
 * else can be pointing at it.
 *
 * NOTHING EXISTING MOVES. Objects already stored keep their keys, and every
 * `asset_version.storageKey` stays as written; readers always follow the
 * stored key, never recompute it. The first version of an upload keeps
 * `assetObjectKey`, whose single writer is guarded by its upload session.
 */
export function assetVersionAttemptKey(input: {
  workspaceId: string;
  brandId: string | null;
  assetId: string;
  versionNumber: number;
  /** A fresh UUID per attempt. */
  attemptId: string;
}): string {
  if (!/^[0-9a-f-]{36}$/i.test(input.attemptId)) {
    throw new Error('A version attempt id must be a UUID.');
  }
  return `${assetObjectKey(input)}-${input.attemptId}`;
}

/**
 * Where a derivative lives.
 *
 * UNDER THE ASSET'S OWN PREFIX, so deleting an asset is a prefix operation on a
 * real store and so nothing can be orphaned by a delete path that forgot a
 * second location. The kind is part of the key because there is at most one
 * derivative per kind per asset, which the unique constraint also says.
 */
export function derivativeObjectKey(input: {
  workspaceId: string;
  brandId: string | null;
  assetId: string;
  versionNumber: number;
  kind: string;
}): string {
  return `${assetObjectKey(input)}/derivative-${input.kind.toLowerCase()}`;
}

/**
 * Where an upload session stages its bytes before an asset row exists.
 *
 * A SEPARATE PREFIX FROM THE LIBRARY ITSELF, deliberately. Bytes under
 * `upload/` have been received and NOT yet verified, scanned or accepted; bytes
 * under `asset/` have. Keeping them apart means the expiry sweep can clear
 * abandoned uploads without ever walking a prefix that holds real assets, and
 * means a bug in the sweep cannot delete a customer's library.
 */
export function uploadStagingKey(input: { workspaceId: string; sessionId: string }): string {
  return `ws/${input.workspaceId}/upload/${input.sessionId}`;
}
