/**
 * Model and enum types, re-exported.
 *
 * `packages/database` is the only package permitted to import `@prisma/client`
 * (eslint.config.mjs, and a unit test). That rule exists so a schema change
 * cannot quietly reach into a package that has no business knowing about
 * PostgreSQL — but a domain package still has to be able to SAY
 * `BrandKnowledgeArea` without inventing a parallel enum that would drift from
 * the database on the first migration.
 *
 * So the types come through here, and only the types: no client, no query
 * builder, no connection. Adding a name to this file is a deliberate act.
 */
export type {
  Asset,
  AssetDerivative,
  AssetFolder,
  AssetProcessingJob,
  AssetUploadSession,
  AssetVersion,
  Brand,
  BrandBrainConversation,
  BrandBrainMessage,
  BrandIngestionJob,
  BrandKnowledgeCandidate,
  BrandKnowledgeItem,
  BrandKnowledgeVersion,
  BrandSourceChunk,
  BrandSourceDocument,
} from '@prisma/client';

export type {
  AssetDerivativeKind,
  AssetKind,
  AssetProcessingStage,
  AssetScanStatus,
  AssetSource,
  AssetStatus,
  AssetUploadSessionStatus,
  BrandCandidateStatus,
  BrandIngestionStage,
  BrandKnowledgeArea,
  BrandKnowledgeOrigin,
  BrandKnowledgeStatus,
  BrandMemoryLayer,
  BrandSourceStatus,
  BrandStatus,
  Locale,
} from '@prisma/client';
