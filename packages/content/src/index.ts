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
  contentToolRequestSchema,
} from './requests';
export type { ContentGenerateRequest, ContentQuoteRequest, ContentToolRequest } from './requests';

export { ContentLibraryService } from './library';
export type { ContentLibraryOptions } from './library';

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
  resolveContentExpiry,
} from './retention';
export type { AiOutputRetentionDeclaration, RetentionInput } from './retention';

export { countCharacters, validateVariant } from './validation';
export type { VariantValidation } from './validation';

export { parseGeneratedContent } from './schemas';
export type { GeneratedContent } from './schemas';

export { purgeExpiredContent } from './purge';
export type { ContentPurgeResult } from './purge';

export {
  briefTooLong,
  contentItemNotFound,
  contentVariantNotFound,
  draftLimitReached,
  transitionNotAllowed,
  unsupportedDialect,
  unsupportedPlatform,
} from './errors';
