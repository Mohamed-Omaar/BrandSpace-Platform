/**
 * AI Content Studio — Phase 5 scope item 3 (docs/PRODUCT.md §5 module 7).
 *
 * The public surface. Nothing outside this package reaches into a module
 * directly, and no provider SDK is imported here at all — generation goes
 * through `@brandspace/ai-gateway`, which is the only package permitted to know
 * a provider exists.
 */
export { ContentStudioService, CONTENT_TOOLS, carouselOutlineInstruction } from './studio';
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

export { ContentLibraryService, READ_ONLY_CONTENT_STATUSES } from './library';
export { SLIDE_HEADLINE_MAX, SLIDES_MAX, normaliseSlides, readSlides } from './slides';
export type { Slide } from './slides';

/* Phase 2B-2 — post templates (prototype v90 E4 / B2). */
export {
  ContentTemplateService,
  TEMPLATES_MANAGE_PERMISSION,
  TEMPLATE_BODY_MAX,
  TEMPLATE_FIRST_COMMENT_MAX,
  TEMPLATE_HASHTAGS_MAX,
  TEMPLATE_NAME_MAX,
  applyTemplateToDraft,
  applyTemplateToGeneratedVariant,
  contentTemplateNotFound,
  generationDefaults,
  hashtagsIntoFirstComment,
  normaliseHashtags,
  templateNameTaken,
} from './templates';
export type { TemplateActor, TemplateFields, TemplateSource } from './templates';
export type { ContentLibraryOptions } from './library';

export {
  ContentCalendarService,
  RESCHEDULABLE_ITEM_STATUS,
  RESCHEDULABLE_SLOT_STATUSES,
  SLOT_BUSY_JOB_STATUSES,
  liveSlotWhere,
  scheduleUsageKey,
} from './calendar';
export { calendarCapacityLockKey, lockCalendarCapacity } from './calendar-capacity-lock';
export { WorkspaceTimezoneService, timezoneChangeEffects } from './timezone-change';
export type { TimezoneChangeActor, TimezoneChangeEffect } from './timezone-change';
export type {
  ApprovalGate,
  CalendarOptions,
  ChannelGate,
  CalendarSlotView,
  NextFreeSlotOutcome,
  NextFreeSlotRefusal,
  ScheduleInput,
  ScheduleQuota,
} from './calendar';

/* Phase 5B-3 — Approvals (docs/PRODUCT.md §5 module 14). */
export {
  ContentApprovalService,
  mayApproveForBrand,
  policyFromSnapshot,
  reviewReminderChoice,
} from './approvals';
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
  DEFAULT_POST_TIME,
  LOCAL_TIME_PATTERN,
  bestTimeFor,
  nextDayKey,
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
export { calendarMarkers, defaultPublishingTime, suggestedPostingTimes } from './calendar-markers';
export type { CalendarMarker, SuggestedTimeSource } from './calendar-markers';

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
  CHANNEL_DISCONNECTED_REASON,
  DECISION_NOTE_REQUIRED_REASON,
  SCHEDULE_IN_PAST_REASON,
  DAY_IS_FULL_REASON,
  DRAFT_LIMIT_REACHED_REASON,
  SCHEDULE_QUOTA_EXCEEDED_REASON,
  SOURCE_CAMPAIGN_UNAVAILABLE_REASON,
  decisionNoteRequired,
  alreadyScheduled,
  approvalRequiredBeforeScheduling,
  briefTooLong,
  calendarSlotNotFound,
  channelDisconnected,
  contentItemNotFound,
  contentVariantNotFound,
  dayIsFull,
  draftLimitReached,
  invalidScheduleTime,
  nothingToSchedule,
  scheduleQuotaExceeded,
  scheduleTooFarAhead,
  scheduleTooSoon,
  SLOT_MOVED_SINCE_REASON,
  slotMovedSince,
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
export {
  CAMPAIGN_ALREADY_ENDED_REASON,
  CAMPAIGN_NOT_PLANNED_REASON,
  CampaignService,
  PAUSABLE_CAMPAIGN_STATUSES,
  campaignNotFound,
  campaignVersionConflict,
} from './campaigns';
export {
  campaignDayKey,
  campaignResultsPeriod,
  daysUntilCampaignEnds,
  todayKeyIn,
} from './campaign-results';
export type { CampaignResultsPeriod } from './campaign-results';
/*
 * PHASE 8 — the media gate. Exported because BOTH the Studio and the publish
 * preflight use it: `ContentVariant.assetIds` is a uuid array and cannot carry
 * a composite foreign key, so the tenant boundary for media lives in this
 * service and must be the same one in both places.
 */
export { ContentMediaResolver, mediaNotFound, tooManyMedia } from './media';
export type { MediaResolverOptions, ResolvedMedia } from './media';
export type {
  CampaignActor,
  CampaignPauseRefusal,
  CampaignServiceOptions,
  CreateCampaignInput,
} from './campaigns';
export {
  MemberSuggestionService,
  PREFERENCE_SOURCE,
  TONE_KEYS,
  WORKFLOW_SOURCE,
  noticeWorkflows,
  type NoticedWorkflow,
  type WorkflowObservation,
  noticePreferences,
  preferenceInstructions,
  preferenceKeyOf,
  type NoticedPreference,
  type SuggestionDecision,
  type ToolObservation,
} from './suggestions';
