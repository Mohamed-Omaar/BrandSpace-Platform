import {
  parseConfigPayload,
  type ConfigPayload,
  type ConfigurationService,
  type Environment,
} from '@brandspace/config';
import type { AssetKind } from '@brandspace/database';

/**
 * Asset Library operational policy, resolved from VERSIONED CONFIGURATION.
 *
 * THIS FILE CONTAINS NO POLICY VALUE, and that is its whole point. CLAUDE.md
 * §2.2 puts upload rules, size ceilings, version and derivative bounds, the
 * download window and retention in owner-managed configuration. Phase 5A broke
 * that in the quietest possible way — the API and the dashboard each carried
 * their own copy of the numbers under a comment saying they "mirror" the schema
 * — and two copies of a setting are two settings.
 *
 * Everything below is a RESHAPE of the `assets` configuration document into the
 * shapes the services take. Every default lives in the schema
 * (`packages/config/src/domains.ts`), which is the single place an operator
 * change lands, and `ConfigurationService.get` applies those defaults when no
 * version has been activated yet.
 *
 * WHO MAY CALL WHICH ENTRY POINT:
 *   - `resolveAssetPolicy` needs a ConfigurationService, which needs the
 *     PLATFORM database identity. Only a platform surface may hold that
 *     (F-07 / eslint.config.mjs PLATFORM_SURFACE_APPS) — in practice `apps/api`.
 *   - The customer dashboard and the worker never touch `configuration_version`.
 *     They read `TenantAssetPolicySource`, the tenant-readable projection.
 *
 * WHAT IS DELIBERATELY ABSENT: the storage QUOTA. It is per-plan
 * (`limit.storage_gb`, D-10) and resolved through the entitlements engine like
 * every other quota. A ceiling here as well would be two limits for one
 * question, and the stricter would win by accident rather than by design.
 */

export const ASSETS_CONFIG_DOMAIN = 'assets';

type AssetsConfig = ConfigPayload<'assets'>;

/** The per-kind halves of the upload rules, in the shape the services ask in. */
export interface UploadPolicy {
  readonly allowedMimeTypes: Readonly<Record<Lowercase<AssetKind>, readonly string[]>>;
  readonly maxFileBytes: Readonly<Record<Lowercase<AssetKind>, number>>;
  readonly maxAssetsPerBrand: number;
  readonly sessionTtlSeconds: number;
  readonly maxFileNameLength: number;
  readonly maxTagsPerAsset: number;
  readonly maxTagLength: number;
  readonly maxFolderDepth: number;
}

export interface DerivativePolicy {
  readonly thumbnailEnabled: boolean;
  readonly thumbnailMaxEdgePx: number;
  readonly previewEnabled: boolean;
  readonly previewMaxEdgePx: number;
  readonly maxPerAsset: number;
  readonly timeoutMs: number;
}

export interface ScanningPolicy {
  readonly required: boolean;
  readonly provider: 'mock';
  readonly timeoutMs: number;
}

export interface ProcessingPolicy {
  readonly maxAttempts: number;
  readonly retryBackoffSeconds: number;
  readonly stuckAfterSeconds: number;
}

export interface AssetPolicy {
  readonly upload: UploadPolicy;
  readonly versions: { readonly maxVersionsPerAsset: number };
  readonly derivatives: DerivativePolicy;
  readonly scanning: ScanningPolicy;
  readonly processing: ProcessingPolicy;
  readonly download: { readonly grantTtlSeconds: number };
  readonly retention: {
    readonly purgeDeletedAfterDays: number;
    readonly purgeExpiredSessionsAfterHours: number;
  };
}

/**
 * The configuration document, reshaped. A pure function, so a test can hand it
 * a document and assert the runtime behaviour that follows without a database.
 */
export function assetPolicyFrom(document: AssetsConfig): AssetPolicy {
  return {
    upload: {
      allowedMimeTypes: document.upload.allowedMimeTypes,
      maxFileBytes: document.upload.maxFileBytes,
      maxAssetsPerBrand: document.upload.maxAssetsPerBrand,
      sessionTtlSeconds: document.upload.sessionTtlSeconds,
      maxFileNameLength: document.upload.maxFileNameLength,
      maxTagsPerAsset: document.upload.maxTagsPerAsset,
      maxTagLength: document.upload.maxTagLength,
      maxFolderDepth: document.upload.maxFolderDepth,
    },
    versions: { maxVersionsPerAsset: document.versions.maxVersionsPerAsset },
    derivatives: {
      thumbnailEnabled: document.derivatives.thumbnailEnabled,
      thumbnailMaxEdgePx: document.derivatives.thumbnailMaxEdgePx,
      previewEnabled: document.derivatives.previewEnabled,
      previewMaxEdgePx: document.derivatives.previewMaxEdgePx,
      maxPerAsset: document.derivatives.maxPerAsset,
      timeoutMs: document.derivatives.timeoutMs,
    },
    scanning: {
      required: document.scanning.required,
      provider: document.scanning.provider,
      timeoutMs: document.scanning.timeoutMs,
    },
    processing: {
      maxAttempts: document.processing.maxAttempts,
      retryBackoffSeconds: document.processing.retryBackoffSeconds,
      stuckAfterSeconds: document.processing.stuckAfterSeconds,
    },
    download: { grantTtlSeconds: document.download.grantTtlSeconds },
    retention: {
      purgeDeletedAfterDays: document.retention.purgeDeletedAfterDays,
      purgeExpiredSessionsAfterHours: document.retention.purgeExpiredSessionsAfterHours,
    },
  };
}

/** Read the active `assets` document and reshape it. Platform surfaces only. */
export async function resolveAssetPolicy(
  configuration: Pick<ConfigurationService, 'get'>,
  environment: Environment,
): Promise<AssetPolicy> {
  return assetPolicyFrom(await configuration.get(ASSETS_CONFIG_DOMAIN, environment));
}

/**
 * Which kind a declared media type belongs to, according to the ACTIVATED
 * configuration.
 *
 * THE CONFIGURATION DECIDES THE KIND, not a regular expression over the MIME
 * string. `image/*` would be the obvious shortcut and it is wrong twice: an
 * operator who removes `image/webp` from the allow-list would find it still
 * classified and still accepted, and a type an operator added under `document`
 * would be classified as whatever its prefix happened to say. The allow-list is
 * the single statement of both what is permitted and what it is.
 *
 * Returns null when nothing admits the type, which the caller turns into a
 * refusal rather than a guess.
 */
export function kindForMimeType(policy: UploadPolicy, mimeType: string): AssetKind | null {
  const entries = Object.entries(policy.allowedMimeTypes) as [Lowercase<AssetKind>, string[]][];
  for (const [kind, types] of entries) {
    if (types.includes(mimeType)) return kind.toUpperCase() as AssetKind;
  }
  return null;
}

/**
 * The size ceiling for one kind.
 *
 * The lookup cannot miss — `AssetKind` and the schema's per-kind objects are
 * the same closed set, and the schema supplies a default for every one — but
 * the compiler cannot see that through the index signature. Falling back to
 * ZERO rather than to some permissive number is the only safe direction: a
 * missing ceiling must refuse every file, never admit every file.
 */
export function maxBytesForKind(policy: UploadPolicy, kind: AssetKind): number {
  return policy.maxFileBytes[kind.toLowerCase() as Lowercase<AssetKind>] ?? 0;
}

/**
 * The tenant-side source.
 *
 * Reads the PROJECTION — `entitlement_catalogue_snapshot`, the global catalogue
 * the Configuration Service writes on activation and the tenant role may read
 * and may not write. The customer application therefore never touches
 * `configuration_version`, which stays platform-owned with every privilege
 * revoked, and cannot reach any domain beyond the ones that CHECK constraint
 * admits.
 *
 * This is the same mechanism `TenantBrandBrainPolicySource` uses, for the same
 * reason, and it is what lets the dashboard, the API and the worker all enforce
 * ONE set of numbers.
 */
export class TenantAssetPolicySource {
  readonly #db: CatalogueReader;
  readonly #environment: Environment;

  constructor(db: CatalogueReader, environment: Environment) {
    this.#db = db;
    this.#environment = environment;
  }

  async load(): Promise<AssetPolicy> {
    const row = await this.#db.entitlementCatalogueSnapshot.findUnique({
      where: {
        domain_environment: { domain: ASSETS_CONFIG_DOMAIN, environment: this.#environment },
      },
    });

    /*
     * NO SNAPSHOT MEANS NOTHING HAS BEEN ACTIVATED YET, not an error.
     *
     * Parsing `{}` yields the schema's own defaults — the same values
     * `ConfigurationService.get` returns on the platform side in the same
     * situation. The defaults live in exactly one place, which is the property
     * that matters: whatever an operator activates in Platform Admin is what
     * every side sees, with no second copy anywhere to drift.
     */
    return assetPolicyFrom(parseConfigPayload(ASSETS_CONFIG_DOMAIN, row?.payload ?? {}));
  }
}

/**
 * The slice of the tenant-scoped Prisma client this source needs.
 *
 * Structural rather than the full `PrismaClient`, so a caller can hand it the
 * scoped client it already has inside a workspace transaction.
 */
export interface CatalogueReader {
  readonly entitlementCatalogueSnapshot: {
    findUnique(args: {
      where: { domain_environment: { domain: string; environment: Environment } };
    }): Promise<{ payload: unknown } | null>;
  };
}
