/**
 * Brand Brain — the intelligence and memory layer (docs/PRODUCT.md §6A,
 * D-63/D-64/D-65).
 *
 * The public surface. Nothing outside this package may reach a Brand Brain
 * table directly: the governance rules — human precedence, append-only
 * versioning, review before approval — are only guarantees if there is one way
 * in.
 */
export {
  AREA_DEFINITIONS,
  BRAND_KNOWLEDGE_AREAS,
  ORB_AREAS,
  ORB_SLOTS,
  areaDefinition,
  isBrandKnowledgeArea,
} from './areas';
export type { AreaDefinition, OrbSlot } from './areas';

export {
  BRAND_MEMORY_LAYERS,
  comparePrecedence,
  mayOverwrite,
  memoryRank,
  originRank,
  sortByPrecedence,
} from './precedence';
export type { OverwriteDecision, PrecedenceSubject } from './precedence';

export {
  closestKeyQuestion,
  computeAreaCompletion,
  computeBrandCompletion,
  questionsForBrand,
} from './completion';
export type {
  AreaCompletion,
  AreaCounts,
  AreaQuestions,
  AreaStatus,
  AttentionReason,
  BrandCompletion,
  KeyQuestion,
  MissingQuestion,
} from './completion';

export {
  MAX_BODY_CHARS,
  MAX_CHAT_MESSAGE_CHARS,
  MAX_REASON_CHARS,
  MAX_TITLE_CHARS,
  acceptConfidentSchema,
  areaSchema,
  chatMessageSchema,
  createKnowledgeItemSchema,
  itemKeySchema,
  localizedTextSchema,
  paginationSchema,
  reviewCandidateSchema,
  rollbackSchema,
  updateKnowledgeItemSchema,
  validUntilInputSchema,
} from './schemas';
export type {
  ChatMessageInput,
  CreateKnowledgeItemInput,
  LocalizedText,
  ReviewCandidateInput,
  RollbackInput,
  UpdateKnowledgeItemInput,
} from './schemas';

export {
  alreadyReviewed,
  brandNotFound,
  candidateNotFound,
  conversationNotFound,
  documentNotFound,
  duplicateUpload,
  fileTooLarge,
  humanPrecedenceViolation,
  knowledgeChangedSince,
  knowledgeNotFound,
  readAgainUnavailable,
  sourceRefused,
  storageLimitReached,
  unsupportedFileType,
  versionNotFound,
} from './errors';

export { BrandKnowledgeService, localizedFrom } from './knowledge';
export type {
  BrandKnowledgeCandidateSummary,
  BulkSkipReason,
  KnowledgeActor,
  KnowledgeServiceOptions,
  StalenessPolicy,
} from './knowledge';

export {
  FilesystemObjectStore,
  InMemoryObjectStore,
  buildStorageKey,
  checksumOf,
  createObjectStore,
  defaultObjectStoreDirectory,
} from './storage';
export type { ObjectStore, StoredObject } from './storage';

export {
  ExtractionFailedError,
  ExtractionUnsupportedError,
  ExtractorRegistry,
  KeywordFactExtractor,
  PlainTextExtractor,
  chunkText,
  defaultExtractors,
  extractorRegistryFor,
  strictUtf8,
} from './extraction';
export type {
  CandidateFact,
  Chunk,
  ChunkOptions,
  ExtractedText,
  ExtractionFailureReason,
  ExtractionInput,
  ExtractionLimits,
  FactExtractor,
  TextExtractor,
} from './extraction';
export { DocxExtractor, PptxExtractor, declaredOoxmlKind } from './extract-ooxml';
export type { OoxmlKind } from './extract-ooxml';
export { PdfExtractor } from './extract-pdf';
export { checkSignature, detectFormat } from './file-signature';
export type { DetectedFormat, SignatureCheck } from './file-signature';

export {
  BrandIngestionService,
  extractSourceDocument,
  findUnclaimedIngestionJobs,
} from './ingestion';
export type {
  ExtractionOutcome,
  IngestionPolicy,
  IngestionServiceOptions,
  ProcessResult,
  ReceiveOutcome,
  ReceiveResult,
  StartedIngestion,
  UploadInput,
  UploadRefusalReason,
} from './ingestion';

export {
  BrandBrainRetriever,
  cosineSimilarity,
  fenceUntrusted,
  indexVector,
  neutralizeInjection,
  score,
  tokenize,
  usableKnowledgeWhere,
} from './retrieval';
export type {
  Citation,
  GroundedFact,
  RetrievalContext,
  RetrievalOptions,
  RetrievedItem,
} from './retrieval';

export { removeSource, sourceKnowledge } from './sources';
export type {
  SourceFact,
  SourceKnowledge,
  SourcePending,
  SourceRemovalMode,
  SourceRemovalResult,
} from './sources';

export {
  BRAND_GOAL_SELECT,
  GOAL_KEY_PREFIX,
  brandBrainChangedSince,
  brandBrainEnabledForWriting,
  declaredPillarIdeas,
  declaredPillarKeys,
  groundingFor,
  keyQuestionAnswered,
  knowledgeSignatureFor,
  knowledgeSignatureOf,
  rewriteGroundingFor,
  usableFactsForDisplay,
  writingFactsInAreas,
  writingGoal,
} from './grounding';
export {
  calendarDate,
  isExpired,
  isoDateOf,
  knowledgeAsOf,
  knowledgeAsOfSafe,
  localDateIn,
  parseValidUntil,
  workspaceKnowledgeAsOf,
} from './validity';
export type { Grounding, GroundingPurpose, GroundingRequest, RewriteResolution } from './grounding';

export { purgeExpiredChatContent } from './chat';
export { BrandBrainChatService } from './chat';
export { askAnswerSchema, parseAskAnswer } from './chat';
export type { AskKind, ChatPolicy, ChatServiceOptions, ChatTurn, MissingKnowledge } from './chat';

export {
  BRAND_BRAIN_CONFIG_DOMAIN,
  TenantBrandBrainPolicySource,
  brandBrainPolicyFrom,
  resolveBrandBrainPolicy,
} from './policy';
export type { BrandBrainPolicy, CatalogueReader, QuestionsPolicy, ReviewPolicy } from './policy';

export { confidenceExplanation, confidenceLabel } from './review';
export type { ConfidenceExplanation, ConfidenceLabel, ConfidenceReason } from './review';

export {
  D10_CONTENT_STATUSES,
  D10_HOME_STATUSES,
  changeSignature,
  contentWithFactChanges,
  isFlagged,
  keepFactChange,
  loadCurrentUsage,
  recordKnowledgeUsage,
  refreshPlanFor,
  usageChangeFor,
  usageEntryOf,
  usedInPostsCounts,
  variantKnowledgeUsage,
} from './usage';
export type {
  FactView,
  UsageChange,
  UsageChangeKind,
  UsageRowState,
  UsageState,
  VariantUsageEntry,
} from './usage';
