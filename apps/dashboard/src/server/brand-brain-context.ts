import 'server-only';
import { notFound } from 'next/navigation';
import {
  AREA_DEFINITIONS,
  BrandIngestionService,
  BrandKnowledgeService,
  ExtractorRegistry,
  TenantBrandBrainPolicySource,
  computeBrandCompletion,
  createObjectStore,
  defaultExtractors,
  localizedFrom,
  type AreaCompletion,
  type BrandBrainPolicy,
  type CatalogueReader,
  type ObjectStore,
} from '@brandspace/brand-brain';

import type { BrandKnowledgeArea } from '@brandspace/database';
import { assertBrandInScope, brandInScope, brandScopeFilter } from '@brandspace/shared';
import { currentEnvironment, inWorkspace, type ScopedServices } from './customer-context';

/**
 * Brand Brain wiring for the customer dashboard.
 *
 * EVERY POLICY VALUE COMES FROM VERSIONED CONFIGURATION, AND NONE OF THEM IS
 * WRITTEN DOWN IN THIS APP.
 *
 * This file used to return a literal object — 25 MB, 200 documents, 180 days,
 * 90 days — under a comment explaining that they were "the same defaults the
 * configuration schema declares". They were, and that was the problem: two
 * copies of a setting are two settings. An owner who shortened the retention
 * window in Platform Admin would have changed nothing a customer could see, and
 * the chat notice would have gone on promising ninety days. CLAUDE.md §2.2.
 *
 * HOW IT CROSSES THE BOUNDARY. `configuration_version` is platform-owned: every
 * privilege is revoked from the tenant role, and F-07 keeps the platform
 * database identity out of this app, which is the surface closest to a browser
 * bundle. So the policy arrives the way entitlements, plans, feature flags and
 * credit policy already do — through `entitlement_catalogue_snapshot`, the
 * global catalogue the Configuration Service projects on activation and the
 * tenant role may read and may not write. A CHECK constraint on that table
 * decides which domains may ever appear in it. Nothing in this app reads a
 * configuration table or resolves a credential.
 *
 * The tenant side, throughout. Everything runs on `brandspace_app` inside
 * `inWorkspace`, so RLS applies to every statement.
 */

export type { BrandBrainPolicy };

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
  // APP_ENV, not NODE_ENV: every built app has NODE_ENV=production, including
  // the one the E2E suite serves. See createObjectStore for the full reasoning.
  sharedStore ??= createObjectStore({ appEnv: process.env['APP_ENV'] ?? 'development' });
  return sharedStore;
}

/**
 * Brand Brain policy for one workspace, read from the projection.
 *
 * Takes the SCOPED client, so the read happens inside the workspace transaction
 * the caller already opened rather than opening a second one. The catalogue is a
 * global table with no tenant column — identical rows for every workspace — so
 * reading it there is a plain lookup, not a cross-tenant reach.
 */
export async function brandBrainPolicy(db: CatalogueReader): Promise<BrandBrainPolicy> {
  return new TenantBrandBrainPolicySource(db, currentEnvironment()).load();
}

export interface BrandBrainServices extends ScopedServices {
  readonly knowledge: BrandKnowledgeService;
  /**
   * Built ON DEMAND, and asynchronously.
   *
   * Ingestion needs an object store and the configured upload policy; reading
   * knowledge needs neither. Constructing it eagerly made every READ depend on
   * both, so the whole screen failed before it rendered a row when either was
   * unavailable. It is a function rather than a getter because resolving the
   * policy crosses a network boundary and a getter cannot await.
   */
  ingestion(): Promise<BrandIngestionService>;
  /** The configured policy, read from the tenant-readable catalogue. */
  policy(): Promise<BrandBrainPolicy>;
}

export async function inBrandBrain<T>(
  workspaceId: string,
  fn: (services: BrandBrainServices) => Promise<T>,
): Promise<T> {
  return inWorkspace(workspaceId, async (scoped) =>
    fn({
      ...scoped,
      knowledge: new BrandKnowledgeService({ db: scoped.db, workspaceId }),
      policy: () => brandBrainPolicy(scoped.db),
      ingestion: async () => {
        const resolved = await brandBrainPolicy(scoped.db);
        return new BrandIngestionService({
          db: scoped.db,
          workspaceId,
          store: objectStore(),
          policy: resolved.ingestion,
          // Built per call, because the extractors carry the configured limits
          // and those change when an owner activates a new version. pdf.js is
          // imported lazily inside `defaultExtractors`, so a request that never
          // reaches a PDF never loads it.
          extractors: new ExtractorRegistry(await defaultExtractors(resolved.extraction)),
        });
      },
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
  /**
   * The caller's membership scope. REQUIRED, so a new call site cannot forget
   * it: an optional parameter would default to unrestricted and the omission
   * would be invisible (F-74).
   */
  brandScope: readonly string[],
): Promise<{ id: string; name: string; slug: string }> {
  // BEFORE the query, not after. A scoped-out brand must be indistinguishable
  // from one that does not exist, and a read that happens first is a read that
  // happened (docs/SECURITY.md §4.2).
  if (!brandInScope(brandScope, brandId)) notFound();

  const brand = await inWorkspace(workspaceId, async ({ db }) =>
    db.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { id: true, name: true, slug: true },
    }),
  );
  if (!brand) notFound();
  return brand;
}

export { assertBrandInScope, brandScopeFilter };

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
