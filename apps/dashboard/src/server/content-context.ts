import 'server-only';
import {
  ContentLibraryService,
  TenantContentPolicySource,
  type CatalogueReader,
  type ContentPolicy,
} from '@brandspace/content';
import { currentEnvironment, inWorkspace, type ScopedServices } from './customer-context';

/**
 * AI Content Studio wiring for the customer dashboard.
 *
 * EVERY POLICY VALUE COMES FROM VERSIONED CONFIGURATION, AND NONE IS WRITTEN
 * DOWN IN THIS APP. Dialects, channels, character limits, the fan-out ceiling
 * and the retention floor arrive the way entitlements, plans, flags, credit
 * policy, `brand-brain` and `assets` already do — through
 * `entitlement_catalogue_snapshot`, the projection the Configuration Service
 * writes on activation and the tenant role may read and may not write. Two
 * copies of a setting are two settings, and Phase 5A is the record of what that
 * costs (CLAUDE.md §2.2).
 *
 * THERE IS DELIBERATELY NO GATEWAY HERE — the same seam the Brand Brain chat
 * crossed. The AI Gateway reads platform-owned `ai.*` configuration and settles
 * credits in its own transactions, so it needs the PLATFORM database identity,
 * and F-07 keeps that out of the surface closest to a browser bundle. So
 * `quote`, `generate` and the editing tools execute in `apps/api` and this app
 * calls them; everything that touches only tenant tables under RLS — browsing,
 * reading, saving a person's own edit, moving a draft through its states —
 * happens here, directly.
 *
 * That boundary is enforced by the TYPE, not by a comment: this file can only
 * build a `ContentLibraryService`, which has no `generate()` to call.
 */

export type { ContentPolicy };

/**
 * Content policy for one workspace, read from the projection.
 *
 * Takes the SCOPED client, so the read happens inside the workspace transaction
 * the caller already opened. The catalogue is a global table with no tenant
 * column — identical rows for every workspace — so reading it there is a plain
 * lookup rather than a cross-tenant reach.
 */
export async function contentPolicy(db: CatalogueReader): Promise<ContentPolicy> {
  return new TenantContentPolicySource(db, currentEnvironment()).load();
}

export interface ContentServices extends ScopedServices {
  /** The configured policy, read from the tenant-readable catalogue. */
  policy(): Promise<ContentPolicy>;
  /**
   * Built ON DEMAND, and asynchronously, because constructing it needs the
   * policy and resolving the policy crosses a network boundary. A getter cannot
   * await, and building it eagerly would make a page that only lists drafts
   * fail before it rendered a row when the catalogue was unavailable.
   */
  library(): Promise<ContentLibraryService>;
}

export async function inContentStudio<T>(
  workspaceId: string,
  fn: (services: ContentServices) => Promise<T>,
): Promise<T> {
  return inWorkspace(workspaceId, async (scoped) => {
    const policy = () => contentPolicy(scoped.db);
    return fn({
      ...scoped,
      policy,
      library: async () =>
        new ContentLibraryService({ db: scoped.db, workspaceId, policy: await policy() }),
    });
  });
}
