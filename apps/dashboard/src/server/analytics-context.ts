import 'server-only';
import {
  AnalyticsExportService,
  AnalyticsQueryService,
  TenantAnalyticsPolicySource,
  createAnalyticsRegistry,
  type AnalyticsPolicy,
} from '@brandspace/analytics';
import {
  AutomationEngine,
  TenantAutomationPolicySource,
  type AutomationPolicy,
} from '@brandspace/automation';
import { CampaignService } from '@brandspace/content';
import { CUSTOMER_REALM } from '@brandspace/auth';
import { cookies } from 'next/headers';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { currentEnvironment, inWorkspace, type ScopedServices } from './customer-context';

/**
 * Phase 7 wiring for the customer dashboard.
 *
 * WHAT THIS APP MAY DO AND WHAT IT MAY NOT — the same seam Phase 6 drew.
 *
 * READING ANALYTICS IS ORDINARY TENANT WORK and happens here, directly: totals,
 * series, comparisons, top posts, the export, campaigns, automation rules and
 * their run history. Every one of them runs on the TENANT identity under RLS,
 * with BrandScope applied as a query predicate.
 *
 * ANYTHING THAT CALLS THE AI GATEWAY DOES NOT. `analytics.explain`,
 * `strategy.generate`, the Copilot and a confirmed automation's external action
 * all need the PLATFORM identity that F-07 keeps out of the app closest to a
 * browser bundle. Those four run in `apps/api` and this file calls them over
 * HTTP with the customer's own session — exactly as Brand Brain chat and the
 * Content Studio already do.
 *
 * THAT BOUNDARY IS ENFORCED BY CONSTRUCTION, NOT BY A COMMENT: nothing built
 * here is given a gateway, so no surface in this app can spend a credit even if
 * a future call site asks.
 *
 * EVERY POLICY VALUE COMES FROM VERSIONED CONFIGURATION, through
 * `entitlement_catalogue_snapshot` — the projection the Configuration Service
 * writes on activation and the tenant role may read and may not write. Two
 * copies of a setting are two settings (CLAUDE.md §2.2).
 */

const log = createLogger({ context: { component: 'dashboard.analytics' } });

export interface AnalyticsServices extends ScopedServices {
  policy(): Promise<AnalyticsPolicy>;
  /** Totals, series, comparisons and top posts. Reads only. */
  queries(): Promise<AnalyticsQueryService>;
  /** Tenant-safe CSV. Bounded by the activated window and row ceilings. */
  exports(): Promise<AnalyticsExportService>;
  campaigns(): CampaignService;
  automationPolicy(): Promise<AutomationPolicy>;
  /**
   * The automation engine, wired with NO PORTS.
   *
   * Authoring and reading rules need none — and an engine in this app that could
   * notify, submit or schedule would be this app performing actions the worker
   * owns. The absence is the boundary, and it is a construction rather than a
   * convention.
   */
  automations(): Promise<AutomationEngine>;
}

export async function inAnalytics<T>(
  workspaceId: string,
  fn: (services: AnalyticsServices) => Promise<T>,
): Promise<T> {
  return inWorkspace(workspaceId, async (scoped) => {
    let cachedPolicy: AnalyticsPolicy | null = null;
    const policy = async (): Promise<AnalyticsPolicy> => {
      cachedPolicy ??= await new TenantAnalyticsPolicySource(
        scoped.db,
        currentEnvironment(),
      ).load();
      return cachedPolicy;
    };

    let cachedAutomationPolicy: AutomationPolicy | null = null;
    const automationPolicy = async (): Promise<AutomationPolicy> => {
      cachedAutomationPolicy ??= await new TenantAutomationPolicySource(
        scoped.db,
        currentEnvironment(),
      ).load();
      return cachedAutomationPolicy;
    };

    return fn({
      ...scoped,
      policy,
      automationPolicy,
      queries: async () =>
        new AnalyticsQueryService({
          db: scoped.db,
          workspaceId,
          policy: await policy(),
          /*
           * THE REGISTRY IS BUILT HERE TOO, and for one reason: the screen has to
           * be able to say "this platform does not publish that figure", which is
           * a CAPABILITY question rather than a data question. It resolves no
           * credential and makes no external call — reading a capability is not
           * reaching a provider.
           */
          registry: createAnalyticsRegistry({ environment: currentEnvironment() }),
        }),
      exports: async () =>
        new AnalyticsExportService({
          db: scoped.db,
          workspaceId,
          policy: await policy(),
        }),
      campaigns: () => new CampaignService({ db: scoped.db, workspaceId }),
      automations: async () =>
        new AutomationEngine({
          db: scoped.db,
          workspaceId,
          policy: await automationPolicy(),
          // NO PORTS. See the interface comment: authoring needs none, and an
          // engine here that could act would be this app doing the worker's job.
          ports: {},
        }),
    });
  });
}

/**
 * Call an `apps/api` Phase 7 route with the customer's own session.
 *
 * ONE CREDENTIAL IS FORWARDED AND NOTHING ELSE — the session cookie, as a bearer
 * token. Not the cookie jar, not the client's headers, not its origin: a helper
 * that replayed arbitrary headers would be a request-forgery primitive.
 *
 * THE PATH IS A CONSTANT AT EVERY CALL SITE. A target that came out of a form
 * field would let a browser aim this credential at any route the API exposes.
 */
export async function callPhase7Api(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; payload: unknown }> {
  const base = process.env['BRANDSPACE_API_URL'];
  if (!base) {
    log.warn('BRANDSPACE_API_URL is not configured; AI features are unavailable');
    return { ok: false, status: 503, payload: { error: { code: 'INTERNAL' } } };
  }
  const store = await cookies();
  const token = store.get(CUSTOMER_REALM.cookieName)?.value;
  if (!token) return { ok: false, status: 401, payload: { error: { code: 'UNAUTHENTICATED' } } };

  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body ?? {}),
    });
    const payload: unknown = await upstream.json().catch(() => ({ error: { code: 'INTERNAL' } }));
    return { ok: upstream.ok, status: upstream.status, payload };
  } catch (error: unknown) {
    // A network failure reaching the API. Logged with internals, answered with a
    // code — the browser never sees a hostname or a stack.
    log.error('phase 7 upstream failed', { path, ...internalErrorFields(error) });
    return { ok: false, status: 502, payload: { error: { code: 'INTERNAL' } } };
  }
}
