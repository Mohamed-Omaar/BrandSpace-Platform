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
  // Phase 5B-2 — AI Content Studio.
  ContentItem,
  ContentVariant,
  // Phase 5B-2 — Content Calendar.
  CalendarSlot,
  // Phase 5B-3 — Approvals, Activity Log, Notifications. `AuditEvent` comes
  // through for the Activity Log, which is a READ MODEL over it: the customer
  // screen needs the row's shape, and nothing here grants a way to write one.
  Approval,
  ApprovalPolicy,
  AuditEvent,
  Notification,
  // Phase 6 — Social Publishing. `SocialCredential` comes through because the
  // one code path allowed to decrypt a token needs the row's shape; the type
  // grants nothing, and the RLS policy plus the package boundary are what keep
  // that path to one place.
  SocialConnection,
  SocialCredential,
  SocialOAuthState,
  PublishJob,
  PublishAttempt,
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
  CalendarSlotStatus,
  ApprovalStatus,
  ApprovalSubjectType,
  ActorType,
  AuditOutcome,
  AuditSeverity,
  NotificationChannel,
  ContentOrigin,
  ContentStatus,
  ContentType,
  ContentValidationState,
  Locale,
  // Phase 6 — Social Publishing.
  SocialProvider,
  SocialConnectionStatus,
  PublishJobStatus,
  PublishFailureClass,
  PublishAttemptOutcome,
} from '@prisma/client';
