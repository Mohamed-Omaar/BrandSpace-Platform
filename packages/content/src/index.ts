/**
 * AI Content Studio — Phase 5 scope item 3 (docs/PRODUCT.md §5 module 7).
 *
 * The public surface. Nothing outside this package reaches into a module
 * directly, and no provider SDK is imported here at all — generation goes
 * through `@brandspace/ai-gateway`, which is the only package permitted to know
 * a provider exists.
 */
export { ContentStudioService, CONTENT_TOOLS } from './studio';
export type { ContentTool, GenerateInput, GenerationResult, StudioOptions } from './studio';

export {
  contentGenerateRequestSchema,
  contentQuoteRequestSchema,
  contentToolQuoteRequestSchema,
  contentToolRequestSchema,
} from './requests';
export type {
  ContentGenerateRequest,
  ContentQuoteRequest,
  ContentToolQuoteRequest,
  ContentToolRequest,
} from './requests';

export { ContentLibraryService } from './library';
export type { ContentLibraryOptions } from './library';

export { ContentCalendarService } from './calendar';
export type {
  ApprovalGate,
  CalendarOptions,
  CalendarSlotView,
  ScheduleInput,
  ScheduleQuota,
} from './calendar';

/* Phase 5B-3 — Approvals (docs/PRODUCT.md §5 module 14). */
export { ContentApprovalService, mayApproveForBrand, policyFromSnapshot } from './approvals';
export type {
  ApprovalActor,
  ApprovalNotifier,
  DenialSink,
  ApprovalOptions,
  ApprovalVerdict,
  ApprovalWithItem,
  ResolvedApprovalPolicy,
  EffectiveApprovalPolicy,
  ReviewSubject,
} from './approvals';

export {
  LOCAL_TIME_PATTERN,
  formatLocalTime,
  instantForIntent,
  isKnownTimeZone,
  monthRangeUtc,
  offsetMinutesAt,
  parseLocalTime,
  partsInZone,
  resolveZonedTime,
} from './timezone';
export type { LocalParts, ZonedResolution } from './timezone';

export {
  CONTENT_CONFIG_DOMAIN,
  TenantContentPolicySource,
  resolveContentPolicy,
} from './catalogue';
export type { CatalogueReader } from './catalogue';

export { contentPolicySchema, findPlatform, parseContentPolicy, resolveDialect } from './policy';
export type { ContentDialect, ContentPlatform, ContentPolicy } from './policy';

export {
  AI_OUTPUT_RETENTION_REGISTRY,
  RETENTION_EXCLUDED_TABLES,
  readRetentionFacts,
  resolveContentExpiry,
} from './retention';
export type {
  AiOutputRetentionDeclaration,
  RetentionInput,
  WorkspaceRetentionFacts,
} from './retention';

export { countCharacters, validateVariant } from './validation';
export type { VariantValidation } from './validation';

export { parseGeneratedContent } from './schemas';
export type { GeneratedContent } from './schemas';

export { purgeExpiredContent } from './purge';
export type { ContentPurgeResult } from './purge';

export {
  alreadyScheduled,
  approvalRequiredBeforeScheduling,
  briefTooLong,
  calendarSlotNotFound,
  contentItemNotFound,
  contentVariantNotFound,
  dayIsFull,
  draftLimitReached,
  invalidScheduleTime,
  nothingToSchedule,
  scheduleQuotaExceeded,
  scheduleTooFarAhead,
  scheduleTooSoon,
  transitionNotAllowed,
  unsupportedDialect,
  unsupportedPlatform,
} from './errors';

/*
 * Phase 7 — the Campaign domain.
 *
 * It lives in this package because docs/DATABASE.md §4.4b already settled the
 * ownership question: campaigns belong to the Social Calendar, and a campaign in
 * this product is a way of grouping content and reading its performance together
 * rather than a lifecycle of its own.
 */
export { CampaignService, campaignNotFound, campaignVersionConflict } from './campaigns';
/*
 * PHASE 8 — the media gate. Exported because BOTH the Studio and the publish
 * preflight use it: `ContentVariant.assetIds` is a uuid array and cannot carry
 * a composite foreign key, so the tenant boundary for media lives in this
 * service and must be the same one in both places.
 */
export { ContentMediaResolver, mediaNotFound, tooManyMedia } from './media';
export type { MediaResolverOptions, ResolvedMedia } from './media';
export type { CampaignActor, CampaignServiceOptions, CreateCampaignInput } from './campaigns';
