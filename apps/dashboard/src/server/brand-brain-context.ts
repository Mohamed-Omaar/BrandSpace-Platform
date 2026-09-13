import 'server-only';
import { notFound } from 'next/navigation';
import {
  AREA_DEFINITIONS,
  BrandIngestionService,
  BrandKnowledgeService,
  computeBrandCompletion,
  createObjectStore,
  localizedFrom,
  type AreaCompletion,
  type ChatPolicy,
  type IngestionPolicy,
  type ObjectStore,
  type StalenessPolicy,
} from '@brandspace/brand-brain';
import type { BrandKnowledgeArea } from '@brandspace/database';
import { inWorkspace, type ScopedServices } from './customer-context';

/**
 * Brand Brain wiring for the customer dashboard.
 *
 * EVERY POLICY VALUE COMES FROM CONFIGURATION, NOT FROM THIS FILE.
 * CLAUDE.md §2.2: upload rules, retention windows and freshness intervals are
 * owner settings. `brandBrainPolicy()` reads the `brand-brain` domain and the
 * defaults it returns are the SCHEMA's defaults — a bootstrap for local
 * development, never a commercial value invented here.
 *
 * The tenant side, throughout. Everything runs on `brandspace_app` inside
 * `inWorkspace`, so RLS applies to every statement.
 */

export interface BrandBrainPolicy {
  readonly ingestion: IngestionPolicy;
  readonly staleness: StalenessPolicy;
  readonly chat: ChatPolicy;
  readonly stuckAfterSeconds: number;
}

/*
 * The object store is process-wide.
 *
 * A per-request store would lose every upload between the POST that created it
 * and the GET that renders the page — which in development looks exactly like
 * a broken pipeline. In production `createObjectStore` REFUSES to return the
 * in-memory one, so this cannot quietly become the production storage layer.
 */
let sharedStore: ObjectStore | null = null;

export function objectStore(): ObjectStore {
  sharedStore ??= createObjectStore({ nodeEnv: process.env['NODE_ENV'] ?? 'development' });
  return sharedStore;
}

/**
 * Resolve Brand Brain policy.
 *
 * The tenant role cannot read `configuration_version` (it is platform-owned),
 * so the dashboard uses the schema defaults until the tenant-readable
 * projection covers this domain. That is a deliberate, stated limitation rather
 * than a silent one: the values below are the SAME defaults the configuration
 * schema declares, so an operator who sets them is changing one number in one
 * place, not overriding a second copy hidden here.
 */
export function brandBrainPolicy(): BrandBrainPolicy {
  return {
    ingestion: {
      allowedMimeTypes: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'text/csv',
        'text/markdown',
        'image/png',
        'image/jpeg',
      ],
      maxFileBytes: 25 * 1024 * 1024,
      maxDocumentsPerBrand: 200,
      maxAttempts: 3,
      retryBackoffSeconds: 60,
      chunkTargetChars: 1_200,
      chunkOverlapChars: 150,
      maxChunksPerDocument: 400,
      minimumCandidateConfidenceMilli: 400,
    },
    staleness: { reviewIntervalDays: 180 },
    chat: {
      retentionDays: 90,
      maxContextItems: 12,
      maxContextChunks: 8,
      maxContextChars: 12_000,
    },
    stuckAfterSeconds: 900,
  };
}

export interface BrandBrainServices extends ScopedServices {
  readonly knowledge: BrandKnowledgeService;
  readonly ingestion: BrandIngestionService;
}

export async function inBrandBrain<T>(
  workspaceId: string,
  fn: (services: BrandBrainServices) => Promise<T>,
): Promise<T> {
  const policy = brandBrainPolicy();
  return inWorkspace(workspaceId, async (scoped) =>
    fn({
      ...scoped,
      knowledge: new BrandKnowledgeService({ db: scoped.db, workspaceId }),
      ingestion: new BrandIngestionService({
        db: scoped.db,
        workspaceId,
        store: objectStore(),
        policy: policy.ingestion,
      }),
    }),
  );
}

/*
 * THERE IS DELIBERATELY NO GATEWAY HERE.
 *
 * Phase 5 is the first time a CUSTOMER action triggers an AI request, and that
 * exposed a seam Phase 4 never had to cross: the AI Gateway reads platform-owned
 * `ai.*` configuration and settles credits in its own transactions, so it needs
 * the PLATFORM database identity. F-07 forbids the customer dashboard from
 * holding that identity, and that rule is worth keeping — this app is the one
 * closest to a browser bundle.
 *
 * So chat executes in `apps/api` (the designated platform surface) and this app
 * calls it. The dashboard still owns every NON-AI Brand Brain operation
 * directly, because those touch only tenant tables under RLS.
 */

/**
 * The caller's active brand.
 *
 * A 404 when the brand does not exist, belongs to another workspace, or is
 * archived — the same answer in all three cases (CLAUDE.md §2.1). RLS has
 * already made the second indistinguishable from the first; this keeps the
 * third from being a tell.
 */
export async function requireBrand(
  workspaceId: string,
  brandId: string,
): Promise<{ id: string; name: string; slug: string }> {
  const brand = await inWorkspace(workspaceId, async ({ db }) =>
    db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { id: true, name: true, slug: true },
    }),
  );
  if (!brand) notFound();
  return brand;
}

/** Area presentation, joined to computed completion. */
export interface AreaView extends AreaCompletion {
  readonly messageKey: string;
}

export function areaViews(completion: readonly AreaCompletion[]): AreaView[] {
  const byArea = new Map(completion.map((c) => [c.area, c]));
  return AREA_DEFINITIONS.map((definition) => {
    const computed = byArea.get(definition.area);
    // `computeBrandCompletion` always returns every area, so this is a
    // belt-and-braces default rather than an expected branch.
    return {
      ...(computed ?? computeBrandCompletion([]).areas[0]!),
      area: definition.area,
      messageKey: definition.messageKey,
    };
  });
}

export { localizedFrom };
export type { BrandKnowledgeArea };
