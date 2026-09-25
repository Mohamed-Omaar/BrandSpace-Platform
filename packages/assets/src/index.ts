export { assertAssetBrandInScope, assertPermission, hasPermission, type AssetActor } from './actor';
export * from './errors';
export {
  ASSETS_CONFIG_DOMAIN,
  assetPolicyFrom,
  kindForMimeType,
  maxBytesForKind,
  resolveAssetPolicy,
  TenantAssetPolicySource,
  type AssetPolicy,
  type CatalogueReader,
  type DerivativePolicy,
  type ProcessingPolicy,
  type ScanningPolicy,
  type UploadPolicy,
} from './policy';
export {
  checkAssetSignature,
  extensionMatchesType,
  normaliseFileName,
  signatureIsKnown,
  type NormalisedFileName,
} from './file-safety';
export {
  assetObjectKey,
  assetVersionAttemptKey,
  derivativeObjectKey,
  uploadStagingKey,
} from './storage-keys';
export {
  createVirusScanner,
  EICAR_TEST_STRING,
  MockVirusScanner,
  SCAN_FAILURE_PROBE,
  type ScanResult,
  type ScanVerdict,
  type VirusScanner,
} from './scanning';
export {
  canPreviewWithoutDerivative,
  ENCODABLE_KINDS,
  INLINE_PREVIEW_MAX_BYTES,
  planDerivatives,
  type PlannedDerivative,
} from './derivatives';
export {
  AssetUploadService,
  type AssetUploadServiceOptions,
  type InitiatedUpload,
  type InitiateUploadInput,
} from './upload';
export {
  AssetLibraryService,
  isSelectable,
  type AssetLibraryServiceOptions,
  type AssetPage,
  type AssetUse,
  type AssetSortField,
  type BrowseAssetsInput,
  type SortDirection,
} from './library';
export {
  AssetProcessingService,
  type AssetProcessingServiceOptions,
  type ProcessAssetResult,
} from './processing';
export {
  AssetVersionService,
  type AssetVersionServiceOptions,
  type VersionCompensationFailure,
} from './versions';
export { AssetDownloadService, type AssetDownloadServiceOptions } from './download';
export {
  AssetMaintenanceService,
  findUnclaimedAssetJobs,
  type AssetMaintenanceOptions,
} from './maintenance';

/*
 * PHASE 8 — the publishable-media predicate and resolver.
 *
 * EXPORTED BECAUSE TWO SUBSYSTEMS ASK THE SAME QUESTION: the Content Studio
 * when an author attaches a picture, and the publish pipeline just before a
 * payload reaches a provider. `ContentVariant.assetIds` is a uuid array and
 * cannot carry a composite foreign key, so this predicate IS the tenant
 * boundary for media, and there must be exactly one of it.
 */
export {
  PUBLISHABLE_ASSET_KINDS,
  PublishMediaResolver,
  publishableAssetWhere,
  publishableMediaNotFound,
} from './publishable';
export type { PublishMediaResolverOptions, ResolvedPublishMedia } from './publishable';
