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
  comparePrecedence,
  mayOverwrite,
  memoryRank,
  originRank,
  sortByPrecedence,
} from './precedence';
export type { OverwriteDecision, PrecedenceSubject } from './precedence';

export { computeAreaCompletion, computeBrandCompletion } from './completion';
export type {
  AreaCompletion,
  AreaCounts,
  AreaStatus,
  AttentionReason,
  BrandCompletion,
} from './completion';

export {
  MAX_BODY_CHARS,
  MAX_CHAT_MESSAGE_CHARS,
  MAX_REASON_CHARS,
  MAX_TITLE_CHARS,
  areaSchema,
  chatMessageSchema,
  createKnowledgeItemSchema,
  itemKeySchema,
  localizedTextSchema,
  paginationSchema,
  reviewCandidateSchema,
  rollbackSchema,
  updateKnowledgeItemSchema,
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
  knowledgeNotFound,
  storageLimitReached,
  unsupportedFileType,
  versionNotFound,
} from './errors';

export { BrandKnowledgeService, localizedFrom } from './knowledge';
export type { KnowledgeActor, KnowledgeServiceOptions, StalenessPolicy } from './knowledge';

export { InMemoryObjectStore, buildStorageKey, checksumOf, createObjectStore } from './storage';
export type { ObjectStore, StoredObject } from './storage';

export {
  ExtractionFailedError,
  ExtractionUnsupportedError,
  ExtractorRegistry,
  KeywordFactExtractor,
  PlainTextExtractor,
  chunkText,
  defaultExtractors,
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
export { DocxExtractor, PptxExtractor } from './extract-ooxml';
export { PdfExtractor } from './extract-pdf';
export { checkSignature, detectFormat } from './file-signature';
export type { DetectedFormat, SignatureCheck } from './file-signature';

export { BrandIngestionService, findUnclaimedIngestionJobs } from './ingestion';
export type {
  IngestionPolicy,
  IngestionServiceOptions,
  ProcessResult,
  UploadInput,
} from './ingestion';

export {
  BrandBrainRetriever,
  cosineSimilarity,
  fenceUntrusted,
  indexVector,
  neutralizeInjection,
  tokenize,
} from './retrieval';
export type {
  Citation,
  RetrievalContext,
  RetrievalOptions,
  RetrievedChunk,
  RetrievedItem,
} from './retrieval';

export { purgeExpiredChatContent } from './chat';
export { BrandBrainChatService } from './chat';
export type { ChatPolicy, ChatServiceOptions, ChatTurn } from './chat';

export {
  BRAND_BRAIN_CONFIG_DOMAIN,
  TenantBrandBrainPolicySource,
  brandBrainPolicyFrom,
  resolveBrandBrainPolicy,
} from './policy';
export type { BrandBrainPolicy, CatalogueReader } from './policy';
