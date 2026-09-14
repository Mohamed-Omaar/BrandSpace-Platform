import {
  parseConfigPayload,
  type ConfigPayload,
  type ConfigurationService,
  type Environment,
} from '@brandspace/config';
import type { ChatPolicy } from './chat';
import type { ExtractionLimits } from './extraction';
import type { IngestionPolicy } from './ingestion';
import type { StalenessPolicy } from './knowledge';

/**
 * Brand Brain operational policy, resolved from VERSIONED CONFIGURATION.
 *
 * THIS FILE CONTAINS NO POLICY VALUE, and that is its whole point. CLAUDE.md
 * §2.2 puts upload rules, retention windows, freshness intervals and chunking
 * in owner-managed configuration, and Phase 5A broke that in the quietest
 * possible way: the API and the dashboard each carried their own copy of the
 * numbers, with a comment saying they "mirror" the schema. Two copies of a
 * setting are two settings. Changing the retention window in Platform Admin
 * would have changed nothing a customer could see, and the screen would have
 * gone on promising ninety days.
 *
 * Everything below is a RESHAPE of the `brand-brain` configuration document
 * into the shapes the services take. Every default lives in the schema
 * (`packages/config/src/domains.ts`), which is the single place an operator's
 * change lands, and `ConfigurationService.get` applies those defaults when no
 * version has been activated yet.
 *
 * WHO MAY CALL WHICH ENTRY POINT:
 *   - `resolveBrandBrainPolicy` needs a ConfigurationService, which needs the
 *     PLATFORM database identity. Only a platform surface may hold that
 *     (F-07 / eslint.config.mjs PLATFORM_SURFACE_APPS) — in practice `apps/api`.
 *   - The customer dashboard never touches `configuration_version`. It receives
 *     `customerBrandBrainPolicy()`'s projection over HTTP from that surface.
 */

export const BRAND_BRAIN_CONFIG_DOMAIN = 'brand-brain';

export interface BrandBrainPolicy {
  readonly ingestion: IngestionPolicy;
  readonly extraction: ExtractionLimits;
  readonly staleness: StalenessPolicy;
  readonly chat: ChatPolicy;
  /** An ingestion job older than this is stuck, and the sweep reconciles it. */
  readonly stuckAfterSeconds: number;
}

type BrandBrainConfig = ConfigPayload<'brand-brain'>;

/**
 * The configuration document, reshaped. A pure function, so a test can hand it
 * a document and assert the runtime behaviour that follows without a database.
 */
export function brandBrainPolicyFrom(document: BrandBrainConfig): BrandBrainPolicy {
  return {
    ingestion: {
      allowedMimeTypes: document.upload.allowedMimeTypes,
      maxFileBytes: document.upload.maxFileBytes,
      maxDocumentsPerBrand: document.upload.maxDocumentsPerBrand,
      maxAttempts: document.ingestion.maxAttempts,
      retryBackoffSeconds: document.ingestion.retryBackoffSeconds,
      chunkTargetChars: document.ingestion.chunkTargetChars,
      chunkOverlapChars: document.ingestion.chunkOverlapChars,
      maxChunksPerDocument: document.ingestion.maxChunksPerDocument,
      minimumCandidateConfidenceMilli: document.knowledge.minimumCandidateConfidenceMilli,
    },
    extraction: {
      maxPages: document.extraction.maxPages,
      maxTextChars: document.extraction.maxTextChars,
      maxArchiveEntries: document.extraction.maxArchiveEntries,
      maxArchiveBytes: document.extraction.maxArchiveBytes,
      maxCompressionRatio: document.extraction.maxCompressionRatio,
      timeoutMs: document.extraction.timeoutMs,
    },
    staleness: { reviewIntervalDays: document.knowledge.reviewIntervalDays },
    chat: {
      retentionDays: document.chat.retentionDays,
      maxContextItems: document.chat.maxContextItems,
      maxContextChunks: document.chat.maxContextChunks,
      maxContextChars: document.chat.maxContextChars,
    },
    stuckAfterSeconds: document.ingestion.stuckAfterSeconds,
  };
}

/** Read the active `brand-brain` document and reshape it. Platform surfaces only. */
export async function resolveBrandBrainPolicy(
  configuration: Pick<ConfigurationService, 'get'>,
  environment: Environment,
): Promise<BrandBrainPolicy> {
  return brandBrainPolicyFrom(await configuration.get(BRAND_BRAIN_CONFIG_DOMAIN, environment));
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
 * This is the same mechanism `TenantCatalogueSource` uses for entitlements,
 * plans and feature flags, for the same reason.
 */
export class TenantBrandBrainPolicySource {
  readonly #db: CatalogueReader;
  readonly #environment: Environment;

  constructor(db: CatalogueReader, environment: Environment) {
    this.#db = db;
    this.#environment = environment;
  }

  async load(): Promise<BrandBrainPolicy> {
    const row = await this.#db.entitlementCatalogueSnapshot.findUnique({
      where: {
        domain_environment: {
          domain: BRAND_BRAIN_CONFIG_DOMAIN,
          environment: this.#environment,
        },
      },
    });

    /*
     * NO SNAPSHOT MEANS NOTHING HAS BEEN ACTIVATED YET, not an error.
     *
     * Parsing `{}` yields the schema's own defaults — the same values
     * `ConfigurationService.get` returns on the platform side in the same
     * situation. The defaults live in exactly one place (the schema in
     * packages/config/src/domains.ts), which is the property that matters:
     * whatever an operator changes there or activates in Platform Admin is what
     * both sides see, with no second copy anywhere to drift.
     */
    return brandBrainPolicyFrom(parseConfigPayload(BRAND_BRAIN_CONFIG_DOMAIN, row?.payload ?? {}));
  }
}

/**
 * The slice of the tenant-scoped Prisma client this source needs.
 *
 * Structural rather than the full `PrismaClient`, so the dashboard can hand it
 * the scoped client it already has inside a workspace transaction.
 */
export interface CatalogueReader {
  readonly entitlementCatalogueSnapshot: {
    findUnique(args: {
      where: { domain_environment: { domain: string; environment: Environment } };
    }): Promise<{ payload: unknown } | null>;
  };
}
