import 'server-only';
import {
  AssetDownloadService,
  AssetLibraryService,
  AssetProcessingService,
  AssetUploadService,
  AssetVersionService,
  TenantAssetPolicySource,
  createVirusScanner,
  type AssetActor,
  type AssetPolicy,
  type CatalogueReader,
  type VersionCompensationFailure,
} from '@brandspace/assets';
import { writeAuditEvent } from '@brandspace/database';
import { QUOTA_FEATURES } from '@brandspace/entitlements';
import { DownloadGrantIssuer, createObjectStore, type ObjectStore } from '@brandspace/storage';
import { createHmac } from 'node:crypto';
import { currentEnvironment, inWorkspace, type ScopedServices } from './customer-context';

/**
 * Asset Library wiring for the customer dashboard.
 *
 * EVERY POLICY VALUE COMES FROM VERSIONED CONFIGURATION, AND NONE IS WRITTEN
 * DOWN IN THIS APP. Phase 5A wrote the Brand Brain numbers here under a comment
 * saying they matched the schema, and two copies of a setting are two settings:
 * an owner who changed one would have changed nothing a customer could see. The
 * policy arrives the way entitlements, plans, flags, credit policy and
 * `brand-brain` already do — through `entitlement_catalogue_snapshot`, the
 * projection the Configuration Service writes on activation and the tenant role
 * may read and may not write.
 *
 * THE TENANT SIDE, THROUGHOUT. Everything runs on `brandspace_app` inside
 * `inWorkspace`, so RLS applies to every statement. Nothing here reads a
 * configuration table or resolves a credential.
 */

export type { AssetPolicy, AssetActor };

/*
 * The object store is process-wide.
 *
 * A per-request store would lose every upload between the request that wrote it
 * and the one that reads it back. Outside production it is filesystem-backed so
 * the WORKER can read what the dashboard wrote (D-97); in production
 * `createObjectStore` REFUSES to return one at all, so this cannot quietly
 * become the production storage layer.
 */
let sharedStore: ObjectStore | null = null;

export function objectStore(): ObjectStore {
  // APP_ENV, not NODE_ENV: every built app has NODE_ENV=production, including
  // the one the E2E suite serves.
  sharedStore ??= createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
  return sharedStore;
}

/**
 * The signing key for download grants.
 *
 * DERIVED FROM THE SESSION SECRET, NOT EQUAL TO IT, and the distinction is the
 * whole point. A grant is a bearer capability with the same blast radius as a
 * session, so introducing a SECOND deployment secret for the same trust level
 * would mean one more value to rotate, one more to leak and one more a
 * deployment can forget. But USING the session key directly would make a flaw
 * in either signature scheme a flaw in the other — the exact coupling
 * `assertRealmsAreSeparated` exists to forbid between realms.
 *
 * An HMAC over a fixed, versioned label is standard domain separation: the two
 * keys are computationally unrelated, a grant can never be mistaken for a
 * session token, and the version in the label is what lets the derivation be
 * rotated later without touching the deployment secret.
 *
 * It FAILS CLOSED. There is no fallback: a default would mean every deployment
 * that forgot to set the secret shared a forgeable signature.
 */
const GRANT_KEY_LABEL = 'brandspace:asset-download-grant:v1';

let derivedKey: string | null = null;

export function downloadSigningKey(): string {
  if (derivedKey) return derivedKey;
  const secret = process.env['CUSTOMER_SESSION_SECRET'];
  if (!secret || secret.trim() === '') {
    // Names the variable and never its value (docs/SECURITY.md §5.1).
    throw new Error('CUSTOMER_SESSION_SECRET is not set, and asset downloads require it.');
  }
  derivedKey = createHmac('sha256', secret).update(GRANT_KEY_LABEL).digest('hex');
  return derivedKey;
}

/**
 * Asset policy for one workspace, read from the projection.
 *
 * Takes the SCOPED client, so the read happens inside the workspace transaction
 * the caller already opened. The catalogue is a global table with no tenant
 * column — identical rows for every workspace — so reading it there is a plain
 * lookup rather than a cross-tenant reach.
 */
export async function assetPolicy(db: CatalogueReader): Promise<AssetPolicy> {
  return new TenantAssetPolicySource(db, currentEnvironment()).load();
}

export interface AssetServices extends ScopedServices {
  /** The configured policy, read from the tenant-readable catalogue. */
  policy(): Promise<AssetPolicy>;
  library(): Promise<AssetLibraryService>;
  /**
   * Built ON DEMAND, and asynchronously. Uploading needs the policy, the store
   * and the plan's storage ceiling; browsing needs only the first. Constructing
   * them eagerly made every READ depend on all three, so the whole screen
   * failed before it rendered a row when any was unavailable.
   */
  upload(): Promise<AssetUploadService>;
  versions(): Promise<AssetVersionService>;
  download(): Promise<AssetDownloadService>;
  /**
   * The processor, for the NON-PRODUCTION inline fallback only.
   *
   * Production dispatches to the worker and cannot process inline at all
   * (`mayProcessInline`). Outside production a developer with no Redis still
   * needs an upload to reach READY, which is the difference between a working
   * local setup and one that needs a container to try a feature.
   */
  processing(): Promise<AssetProcessingService>;
  /** The plan's storage ceiling in gigabytes. `null` means unlimited. */
  storageLimitGb(): Promise<number | null>;
}

/**
 * B-1 — a version attempt whose clean-up did not complete, RECORDED.
 *
 * A SEPARATE TRANSACTION, deliberately, as for a refused approval
 * (`approvals-context.ts` `denialSink`): the failure is about to be rethrown
 * and the request's own transaction rolls back with it, taking any audit row
 * written there along. The record carries identifiers and a byte count only —
 * never the storage key or file content — which is what reconciliation needs:
 * `pnpm storage:recompute` (dry run) for the counter, and the attempt id to
 * find an orphaned object.
 */
async function recordVersionCompensationFailure(
  failure: VersionCompensationFailure,
): Promise<void> {
  await inWorkspace(failure.workspaceId, async ({ db }) =>
    writeAuditEvent(db, failure.workspaceId, {
      action: 'assets.version_compensation_failed',
      actorType: 'SYSTEM',
      resourceType: 'Asset',
      resourceId: failure.assetId,
      severity: 'WARNING',
      outcome: 'ERROR',
      reason: failure.failed.join(','),
      after: {
        attemptId: failure.attemptId,
        versionNumber: failure.versionNumber,
        bytes: failure.bytes,
        failed: [...failure.failed],
      },
    }),
  );
}

export async function inAssetLibrary<T>(
  workspaceId: string,
  fn: (services: AssetServices) => Promise<T>,
): Promise<T> {
  return inWorkspace(workspaceId, async (scoped) => {
    const policy = () => assetPolicy(scoped.db);

    /*
     * THE STORAGE CEILING COMES FROM THE ENTITLEMENTS ENGINE, not from this
     * file and not from the `assets` document. D-10 puts it in the plan
     * (`limit.storage_gb`), resolved through plan, override, flag and default
     * in that precedence — and a second implementation of that precedence is a
     * second answer.
     */
    const storageLimitGb = async (): Promise<number | null> =>
      scoped.entitlements.limit(workspaceId, QUOTA_FEATURES.storageGb);

    return fn({
      ...scoped,
      policy,
      library: async () =>
        new AssetLibraryService({ db: scoped.db, workspaceId, policy: await policy() }),
      upload: async () =>
        new AssetUploadService({
          db: scoped.db,
          workspaceId,
          store: objectStore(),
          policy: await policy(),
          usage: scoped.usage,
          storageLimitGb: await storageLimitGb(),
        }),
      versions: async () =>
        new AssetVersionService({
          db: scoped.db,
          workspaceId,
          store: objectStore(),
          policy: await policy(),
          // B-1 — a new version is storage, charged to the same byte meter
          // and the same plan ceiling as an ordinary upload.
          usage: scoped.usage,
          storageLimitGb: await storageLimitGb(),
          onCompensationFailure: recordVersionCompensationFailure,
        }),
      download: async () =>
        new AssetDownloadService({
          db: scoped.db,
          workspaceId,
          policy: await policy(),
          issuer: new DownloadGrantIssuer({ signingKey: downloadSigningKey() }),
        }),
      processing: async () => {
        const resolved = await policy();
        return new AssetProcessingService({
          db: scoped.db,
          workspaceId,
          store: objectStore(),
          policy: resolved,
          scanner: createVirusScanner({
            appEnv: process.env['APP_ENV'] ?? 'development',
            policy: resolved.scanning,
          }),
        });
      },
      storageLimitGb,
    });
  });
}
