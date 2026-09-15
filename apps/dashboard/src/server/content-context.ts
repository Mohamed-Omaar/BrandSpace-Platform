import 'server-only';
import {
  ContentCalendarService,
  ContentLibraryService,
  TenantContentPolicySource,
  type CatalogueReader,
  type ContentPolicy,
  type ScheduleQuota,
} from '@brandspace/content';
import { QUOTA_FEATURES } from '@brandspace/entitlements';
import { isAppError } from '@brandspace/shared';
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
  /**
   * The calendar, built on the SAME policy and the SAME scoped client.
   *
   * It needs one thing the library does not — the workspace's IANA zone — and
   * it reads it from the workspace row rather than taking it from a caller: a
   * timezone that arrived in a request body would let a crafted POST schedule a
   * post in a zone the workspace does not use.
   */
  calendar(): Promise<ContentCalendarService>;
}

export async function inContentStudio<T>(
  workspaceId: string,
  fn: (services: ContentServices) => Promise<T>,
): Promise<T> {
  return inWorkspace(workspaceId, async (scoped) => {
    const policy = () => contentPolicy(scoped.db);
    /*
     * AC-14.5 — the plan's monthly scheduled-post ceiling, resolved through the
     * ENTITLEMENTS ENGINE rather than counted here.
     *
     * D-10 puts the limit in the plan (`limit.scheduled_posts`), resolved
     * through plan, override, flag and default in that precedence. A second
     * implementation of that precedence is a second answer, which is the
     * mistake `inAssetLibrary` already records for `limit.storage_gb`.
     */
    const quota: ScheduleQuota = {
      limit: async () =>
        scoped.entitlements.limit(workspaceId, QUOTA_FEATURES.scheduledPostsPerMonth),
      consume: async (idempotencyKey) => {
        try {
          await scoped.usage.consume({
            workspaceId,
            featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
            limitValue: await scoped.entitlements.limit(
              workspaceId,
              QUOTA_FEATURES.scheduledPostsPerMonth,
            ),
            period: 'month',
            idempotencyKey,
          });
          return true;
        } catch (error: unknown) {
          // A refusal is a QUOTA_EXCEEDED from the usage service, and it is the
          // only failure this boolean is allowed to swallow. Anything else — a
          // connection fault, a conflicting key — is a real error and must not
          // be reported to the caller as "the plan is full".
          if (isAppError(error) && error.code === 'QUOTA_EXCEEDED') return false;
          throw error;
        }
      },
      refund: async (idempotencyKey) => {
        await scoped.usage.refund({
          workspaceId,
          featureKey: QUOTA_FEATURES.scheduledPostsPerMonth,
          period: 'month',
          idempotencyKey,
        });
      },
    };

    return fn({
      ...scoped,
      policy,
      library: async () =>
        new ContentLibraryService({ db: scoped.db, workspaceId, policy: await policy() }),
      calendar: async () => {
        const workspace = await scoped.db.workspace.findUniqueOrThrow({
          where: { id: workspaceId },
          select: { timezone: true },
        });
        return new ContentCalendarService({
          db: scoped.db,
          workspaceId,
          policy: await policy(),
          timezone: workspace.timezone,
          quota,
        });
      },
    });
  });
}
