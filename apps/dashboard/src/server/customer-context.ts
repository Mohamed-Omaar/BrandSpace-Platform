import 'server-only';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
  getPrisma,
  withWorkspace,
  type PrismaClient,
  type TenantScopedClient,
} from '@brandspace/database';
import {
  CUSTOMER_REALM,
  CustomerAuthService,
  InvitationService,
  MembershipService,
  ApiEmailProvider,
  OutboxEmailProvider,
  type AuthenticatedCustomer,
  type CustomerWorkspaceContext,
  type AbuseCeilings,
  type EmailProvider,
} from '@brandspace/auth';
import {
  CreditLedgerService,
  CreditService,
  EntitlementService,
  SubscriptionService,
  TenantCatalogueSource,
  UsageService,
} from '@brandspace/entitlements';
import { currentEnvironment, isProduction, requestContext } from '@brandspace/shared';
import { permissionDenied } from './denial';
import { KNOWN_PAGE_PERMISSIONS, type KnownPage } from './known-routes';

/**
 * Server-only customer context.
 *
 * THE TENANT SIDE. Everything here runs on the TENANT database identity
 * (`brandspace_app`), which has no privilege on any platform-owned table and no
 * cross-tenant visibility. The customer application cannot import
 * `@brandspace/secrets` or the platform client at all — an ESLint rule and a
 * unit test both refuse it (F-07).
 *
 * `import 'server-only'` makes a client-component import a build error, so none
 * of this can be pulled into a browser bundle.
 */

function prisma() {
  return getPrisma();
}

export function getCustomerAuth(ceilings?: AbuseCeilings): CustomerAuthService {
  return new CustomerAuthService({ prisma: prisma(), ...(ceilings ? { ceilings } : {}) });
}

/**
 * The caller's address and device, for the surface a browser actually uses.
 *
 * THIS IS THE HALF THAT WAS MISSING. Every customer sign-in, password reset and
 * MFA challenge in the running product goes through a server action, and not one
 * of them passed an address or a user agent — so `audit_event.ip`,
 * `audit_event.userAgent` and `password_reset_token.ip` were null on every row
 * the product ever wrote, while the parallel API routes (which no browser calls)
 * passed them. An operator investigating a takeover had a time and nothing else.
 *
 * READ FROM THE FORWARDED CHAIN BY HOP COUNT, never from its leftmost entry: a
 * Next.js server action is reached through the same proxy as everything else,
 * and the entry a client puts there itself must never become the identity a rate
 * limiter counts.
 */
export async function requestOrigin(): Promise<{
  ip: string | undefined;
  userAgent: string | undefined;
}> {
  const bag = await headers();
  return requestContext({
    headers: bag,
    // Next.js does not expose the socket peer to a server action. With no
    // trusted hops configured, `requestContext` therefore reports no address —
    // which is honest, and which the limiter treats as "skip this dimension"
    // rather than as one shared bucket for everybody.
    socketAddress: undefined,
  });
}

/**
 * Run `fn` with the tenant context bound, and with the workspace-scoped
 * services built on the SCOPED client.
 *
 * THIS IS THE ONLY WAY the customer application reads or writes workspace data.
 * Everything inside runs in a transaction that has set `app.workspace_id`, so
 * PostgreSQL RLS applies to every statement — including any raw SQL. A `where`
 * clause somebody forgets is not what keeps tenants apart here.
 *
 * The services detect that they are already inside a transaction and run their
 * work inline rather than opening a nested one, so atomicity is preserved
 * without a second code path.
 */
export interface ScopedServices {
  readonly db: TenantScopedClient;
  readonly invitations: InvitationService;
  readonly memberships: MembershipService;
  readonly entitlements: EntitlementService;
  readonly credits: CreditService;
  /** Phase 3: the customer's own buckets, subscription and quota counters. */
  readonly ledger: CreditLedgerService;
  readonly subscriptions: SubscriptionService;
  readonly usage: UsageService;
  /**
   * The outbox, on the SCOPED client.
   *
   * A workspace-scoped message carries the workspace's id, and the RLS policy
   * requires the matching context to write it — so the send belongs inside the
   * workspace, not beside it. Sending on the unscoped client silently produced
   * no row: `WITH CHECK` refused it and the failure surfaced as a generic
   * error long after the invitation had already been created.
   */
  readonly email: EmailProvider;
}

export async function inWorkspace<T>(
  workspaceId: string,
  fn: (services: ScopedServices) => Promise<T>,
): Promise<T> {
  return withWorkspace(
    workspaceId,
    async (db) => {
      // The scoped client is a PrismaClient minus the connection-lifecycle and
      // transaction methods, which is exactly the surface these services use.
      // The services detect the absence of `$transaction` and run inline.
      const scoped = db as unknown as PrismaClient;
      return fn({
        db,
        invitations: new InvitationService({ prisma: scoped }),
        memberships: new MembershipService({ prisma: scoped }),
        entitlements: new EntitlementService({
          prisma: scoped,
          // NOT the Configuration Service: `configuration_version` is
          // platform-owned and the tenant role has no privilege on it. This
          // source reads `entitlement_catalogue_snapshot` instead — the
          // projection the Configuration Service writes on activation, holding
          // only the three customer-visible domains (D-44).
          catalogueSource: new TenantCatalogueSource(scoped, currentEnvironment()),
          environment: currentEnvironment(),
        }),
        credits: new CreditService({ prisma: scoped }),
        // Phase 3. The customer's own view of its buckets, subscription and
        // quota counters — all tenant-owned, all read through the same scoped
        // client and therefore through RLS.
        ledger: new CreditLedgerService({ prisma: scoped }),
        subscriptions: new SubscriptionService({ prisma: scoped }),
        usage: new UsageService({ prisma: scoped }),
        email: customerEmailProvider(scoped),
      });
    },
    { prisma: prisma() },
  );
}

/**
 * How this process sends email.
 *
 * TWO IMPLEMENTATIONS, AND THE SPLIT IS THE SECURITY BOUNDARY.
 *
 * This process cannot send for real: the active provider's credential is sealed
 * under `SECRET_VAULT_KEK`, a key domain it deliberately does not hold (D-136,
 * F-07). So when real delivery is wanted it ASKS the API, which does hold it.
 * Nothing about the calling flow changes — `ApiEmailProvider` is an
 * `EmailProvider` like any other.
 *
 * WHAT DECIDES IS THE TRUSTED CHANNEL, NOT THE ENVIRONMENT LABEL, and that is
 * a correction rather than a convenience. Keying this on `isProduction()` alone
 * meant no non-production deployment could ever exercise real delivery — the
 * end-to-end suite included, which is precisely where the chain should be
 * proven before it carries a customer's verification link. A staging
 * environment configured exactly like production would have quietly written to
 * a table instead of sending.
 *
 * So: `INTERNAL_SERVICE_TOKEN` present means somebody deliberately wired this
 * process to the API's delivery surface, and it uses it. Absent, outside
 * production, it stays the outbox — which is every ordinary development
 * checkout, so local mail remains deterministic, offline and inspectable in a
 * table rather than depending on a running API.
 *
 * PRODUCTION NEVER TAKES THE OUTBOX BRANCH, token or no token. Without the
 * token `ApiEmailProvider` refuses with a message naming what is missing, which
 * is the diagnosis an operator needs; falling through to `OutboxEmailProvider`
 * would produce its own production refusal about a completely different thing.
 */
function customerEmailProvider(client: PrismaClient): EmailProvider {
  const delegationConfigured = (process.env['INTERNAL_SERVICE_TOKEN'] ?? '').trim() !== '';
  if (isProduction() || delegationConfigured) return new ApiEmailProvider();
  return new OutboxEmailProvider(client);
}

/**
 * The provider for messages that have NO workspace — password resets, which
 * must answer identically whether or not an account exists and therefore cannot
 * resolve one. Workspace-scoped mail goes through `inWorkspace().email`.
 */
export function getUnscopedEmailProvider(): EmailProvider {
  return customerEmailProvider(prisma());
}

/**
 * Resolve the signed-in customer, or null.
 *
 * A PLATFORM session token presented here resolves to null because its hash is
 * not in `customer_session` — the realms share no store, so this is not a check
 * that could be forgotten (docs/SECURITY.md §3).
 */
export async function getCustomer(): Promise<AuthenticatedCustomer | null> {
  const token = await getSessionToken();
  if (!token) return null;
  return getCustomerAuth().resolve(token);
}

/** The raw session token from the cookie. Never logged, never rendered. */
export async function getSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(CUSTOMER_REALM.cookieName)?.value ?? null;
}

/**
 * Default post-auth destination.
 *
 * A verified customer with no workspace is still onboarding; sending them to
 * the workspace picker only creates a dead-end empty state.
 */
export async function customerLandingPath(locale: string, token: string): Promise<string> {
  const workspaces = await getCustomerAuth()
    .listWorkspaces(token, { includePendingDeletion: true, includeMfaRequired: true })
    .catch(() => []);
  return workspaces.length === 0 ? `/${locale}/onboarding/workspace` : `/${locale}/workspaces`;
}

/** The signed-in customer, or a redirect to sign-in. */
export async function requireCustomer(locale: string): Promise<AuthenticatedCustomer> {
  const customer = await getCustomer().catch(() => null);
  if (!customer) redirect(`/${locale}/sign-in`);
  return customer;
}

export interface WorkspaceSession {
  readonly customer: AuthenticatedCustomer;
  readonly workspace: CustomerWorkspaceContext;
  /** The session token, so a caller can re-derive scope without re-reading. */
  readonly token: string;
}

/**
 * Require an authenticated customer AND a selected workspace they still belong
 * to, optionally holding a specific permission.
 *
 * The workspace is taken from the SESSION, never from the URL or a form field,
 * and membership is re-verified on every request. A missing permission is a
 * 404, not a 403: telling someone which pages exist but are closed to them is
 * itself information (docs/SECURITY.md §2.3).
 */
export async function requireWorkspace(
  locale: string,
  /**
   * One key, or every key of a list — a credit-spending action passes
   * `creditSpendingPermissions(<feature key>)` (Q18).
   */
  permissionKey?: string | readonly string[],
): Promise<WorkspaceSession> {
  const customer = await requireCustomer(locale);
  const token = (await getSessionToken()) ?? '';
  // `listWorkspaces` REFUSES a token that matches no live session rather than
  // returning an empty list, so a session revoked between `requireCustomer` and
  // here lands on sign-in instead of on "you are a member of nothing".
  const available = await getCustomerAuth()
    .listWorkspaces(token, { includePendingDeletion: true, includeMfaRequired: true })
    .catch(() => null);
  if (available === null) redirect(`/${locale}/sign-in`);

  if (available.length === 0) {
    // A member of nothing — every workspace suspended, archived, or membership
    // removed. There is a page for exactly this, and it is not an error.
    redirect(`/${locale}/no-workspace`);
  }
  const workspace = customer.activeWorkspaceId
    ? available.find((w) => w.workspaceId === customer.activeWorkspaceId)
    : undefined;
  if (!workspace) redirect(`/${locale}/workspaces`);

  /*
   * A8 (D-328): A WORKSPACE PENDING DELETION IS CLOSED TO EVERY MEMBER. Every
   * page and every action lands on the screen that says when it will be
   * deleted — where an owner may cancel — before any permission is checked
   * or anything is read or written. An action's redirect is re-thrown by its
   * own `isRedirectError` guard, so nothing it would have done happens.
   */
  if (workspace.deletionScheduledFor) redirect(`/${locale}/deletion-pending`);

  /*
   * G4 / Q23 (D-333): A WORKSPACE THAT REQUIRES TWO-STEP VERIFICATION is
   * closed to a member who has not turned it on — every page and every action
   * sends them to set it up first, before anything is read or written. The
   * API answers 404 for the same member: `listWorkspaces` leaves the
   * workspace out unless asked, which only this gate does.
   */
  if (workspace.requireMfa && !customer.mfaEnabled) redirect(`/${locale}/mfa-setup`);

  if (!holdsEvery(workspace, permissionKey)) notFound();
  return { customer, workspace, token };
}

/**
 * A page on the known navigation list, as this member may see it (E2, Q5).
 *
 * `allowed: false` is not an error: the page renders `NoAccessPage` — "No
 * access to this page" inside the normal shell, answered 200 — because the
 * route is one the member already knows exists. Only routes in
 * `KNOWN_PAGE_PERMISSIONS` can be asked for; everything else, and every
 * record inside these pages, keeps the 404 `requireWorkspace` gives.
 */
export type PageAccess =
  | { readonly allowed: true; readonly session: WorkspaceSession }
  | {
      readonly allowed: false;
      readonly session: WorkspaceSession;
      readonly route: KnownPage;
      readonly permissionKey: string;
    };

export async function requireWorkspacePage(locale: string, route: KnownPage): Promise<PageAccess> {
  const session = await requireWorkspace(locale);
  const permissionKey = KNOWN_PAGE_PERMISSIONS[route];
  return holdsPermission(session.workspace, permissionKey)
    ? { allowed: true, session }
    : { allowed: false, session, route, permissionKey };
}

/**
 * THE ONE PERMISSION TEST every gate in this app asks: does the session's
 * role, as stored right now, grant this key? Pages, actions and route handlers
 * differ only in how they SAY no.
 */
export function holdsPermission(
  workspace: Pick<CustomerWorkspaceContext, 'permissionKeys'>,
  permissionKey: string,
): boolean {
  return workspace.permissionKeys.includes(permissionKey);
}

/** `holdsPermission` for each key given; no key at all means "any member". */
function holdsEvery(
  workspace: Pick<CustomerWorkspaceContext, 'permissionKeys'>,
  permissionKey: string | readonly string[] | undefined,
): boolean {
  const required = permissionKey === undefined ? [] : [permissionKey].flat();
  return required.every((key) => holdsPermission(workspace, key));
}

/**
 * `requireWorkspace` for a SERVER ACTION (A5, E6).
 *
 * Same session, same membership re-check, same permission test. The difference
 * is the refusal: a page answers a missing permission with 404 (the page is
 * not there for this member), but an action is posted from a screen the member
 * can already see, and a 404 thrown inside an action's `try` was being caught
 * and reported as "Something went wrong". This throws a FORBIDDEN that names
 * the permission, so the failure path can say which one (`actionErrorCode`).
 */
export async function requireWorkspaceAction(
  locale: string,
  permissionKey: string,
): Promise<WorkspaceSession> {
  const session = await requireWorkspace(locale);
  if (!holdsPermission(session.workspace, permissionKey)) {
    throw permissionDenied(permissionKey);
  }
  return session;
}

/**
 * The owner's name as the members see it — the "ask <owner>" in a denial
 * (E6). Read inside the tenant context: the `user` policy already lets a
 * member read the co-members of their own workspace, and nothing else.
 */
export async function workspaceOwnerName(workspaceId: string): Promise<string> {
  const owner = await withWorkspace(
    workspaceId,
    (db) =>
      db.workspace.findUnique({
        where: { id: workspaceId },
        select: { owner: { select: { name: true, email: true } } },
      }),
    { prisma: prisma() },
  );
  return owner?.owner.name?.trim() || owner?.owner.email || '';
}

/** How a member is named in a denial: their name, else their address. */
export function memberDisplayName(customer: Pick<AuthenticatedCustomer, 'name' | 'email'>): string {
  return customer.name?.trim() || customer.email;
}

/**
 * The same resolution as `requireWorkspace`, for a ROUTE HANDLER.
 *
 * WHY IT CANNOT REUSE `requireWorkspace`. That function redirects, which is
 * correct for a page and wrong for a fetch: a browser following a 307 to the
 * sign-in HTML instead of receiving a 401 turns an expired session into a
 * parse error. This returns null and lets the caller choose the status.
 *
 * EVERYTHING ELSE IS IDENTICAL, including the parts that matter: the workspace
 * comes from the SESSION and never from the URL or a body, membership is
 * re-verified on this request, and a missing permission resolves to null so the
 * caller answers 404 rather than 403 (docs/SECURITY.md §2.3).
 */
export async function resolveApiWorkspace(
  permissionKey?: string,
): Promise<WorkspaceSession | null> {
  const customer = await getCustomer().catch(() => null);
  if (!customer) return null;
  const token = (await getSessionToken()) ?? '';
  const available = await getCustomerAuth()
    .listWorkspaces(token)
    .catch(() => null);
  if (available === null || available.length === 0) return null;

  const workspace = customer.activeWorkspaceId
    ? available.find((w) => w.workspaceId === customer.activeWorkspaceId)
    : undefined;
  if (!workspace) return null;
  if (permissionKey && !holdsPermission(workspace, permissionKey)) return null;
  return { customer, workspace, token };
}

/** The membership-service actor shape, built in one place so none is partial. */
export function membershipActor(session: WorkspaceSession): {
  userId: string;
  roleKey: string;
  permissionKeys: readonly string[];
} {
  return {
    userId: session.customer.userId,
    roleKey: session.workspace.roleKey,
    permissionKeys: session.workspace.permissionKeys,
  };
}

/**
 * Re-exported from `@brandspace/shared` so every caller in this app keeps its
 * existing import. The DEFINITION moved: it used to live here, and in eleven
 * other files, each a private copy of the same four lines (Phase 10 §18).
 */
export { currentEnvironment };
