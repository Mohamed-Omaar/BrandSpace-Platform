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
  areaDefinition,
  isBrandKnowledgeArea,
} from './areas';
export type { AreaDefinition } from './areas';

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
