import 'server-only';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getPlatformClient, type PlatformPrismaClient } from '@brandspace/database/platform';
import {
  InvitationService,
  MembershipService,
  ApiEmailProvider,
  OutboxEmailProvider,
  PLATFORM_REALM,
  PlatformAuthService,
  SupportModeService,
  WorkspaceAdminService,
  type AuthenticatedPlatformActor,
  type EmailProvider,
} from '@brandspace/auth';
import { ConfigurationService } from '@brandspace/config';
import {
  BetaCohortService,
  CreditLedgerService,
  CreditService,
  EntitlementService,
  SubscriptionService,
  creditPolicyFrom,
  readPlanCatalogue,
  type CreditPolicy,
  type PlanDetail,
} from '@brandspace/entitlements';
import {
  BillingReconciler,
  commercePolicyFrom,
  creditLedgerPort,
  type CommercePolicy,
} from '@brandspace/billing';
import { AiUsageExplorer } from '@brandspace/ai-gateway';
import { SecretService } from '@brandspace/secrets';
import { IntegrationsService, type IntegrationDefinition } from '@brandspace/integrations';
import { currentEnvironment, isProduction } from '@brandspace/shared';

/**
 * Server-only platform context for the Control Center.
 *
 * `import 'server-only'` makes a client-component import a BUILD error, so the
 * platform connection string cannot reach a browser bundle even by accident
 * (F-07). Combined with the ESLint boundary rules and the pool's own runtime
 * guard, that is three independent controls on the same leak.
 *
 * Every service here is built on the PLATFORM pool. The tenant role has no
 * privileges on configuration, secret or session tables at all.
 */

/**
 * The platform-scoped client, obtained through the one approved seam in
 * packages/database. It fails closed when DATABASE_PLATFORM_URL is absent, so an
 * admin process without the platform credential can do nothing at all.
 */
function getPlatformPrisma(): PlatformPrismaClient {
  return getPlatformClient();
}

export function getSecretService(): SecretService {
  return new SecretService({ prisma: getPlatformPrisma() });
}

export function getConfigService(): ConfigurationService {
  return new ConfigurationService({ prisma: getPlatformPrisma() });
}

/**
 * The Integrations Hub — Phase 10 §2.
 *
 * IT OWNS NOTHING AND JOINS THREE THINGS: the configuration that selects a
 * provider, the MASKED credential metadata the Secret Service holds, and the
 * `integration_health_check` rows recording what happened last time we called.
 * Every one of those already required the platform identity, which is why this
 * lives here beside the others rather than being reachable from the dashboard.
 */
export function getIntegrationsService(): IntegrationsService {
  return new IntegrationsService({
    prisma: getPlatformPrisma(),
    configuration: getConfigService(),
    secrets: getSecretService(),
  });
}

/**
 * The setting values BrandSpace computes rather than asks for — correction §10.
 *
 * A WEBHOOK URL IS OURS. It is the address of a route in this product, so the
 * owner's job is to copy it into the provider's console, not to type it into
 * ours. Rendering it as an input would have been an invitation to point a
 * payment callback at somebody else's host, and `saveConfiguration` filters this
 * map by the registry's `generated` flag so a caller cannot smuggle an ordinary
 * setting through it.
 */
export function generatedSettingsFor(
  definition: IntegrationDefinition,
): Readonly<Record<string, string>> {
  const apiBaseUrl = (process.env['PUBLIC_API_BASE_URL'] ?? 'http://localhost:3003').replace(
    /\/+$/,
    '',
  );
  if (definition.category === 'payment') {
    return { webhookUrl: `${apiBaseUrl}/v1/billing/webhook/${definition.providerKey}` };
  }
  return {};
}

export function getPlatformAuth(): PlatformAuthService {
  return new PlatformAuthService({
    prisma: getPlatformPrisma(),
    // The TOTP seed lives in the vault, never in a column.
    resolveMfaSecret: async (secretRef) =>
      getSecretService().resolveSecret(secretRef, currentEnvironment()),
  });
}

/**
 * Phase 2B services. Every one is constructed on the PLATFORM pool and every
 * one re-checks the actor's permission inside the service — the page guard and
 * the action guard are convenience, not the control (R-02).
 */
export function getWorkspaceService(): WorkspaceAdminService {
  return new WorkspaceAdminService({ prisma: getPlatformPrisma() });
}

export function getMembershipService(): MembershipService {
  return new MembershipService({ prisma: getPlatformPrisma() });
}

export function getInvitationService(): InvitationService {
  return new InvitationService({ prisma: getPlatformPrisma() });
}

export function getSupportModeService(): SupportModeService {
  return new SupportModeService({ prisma: getPlatformPrisma() });
}

export function getEntitlementService(): EntitlementService {
  return new EntitlementService({
    prisma: getPlatformPrisma(),
    config: getConfigService(),
    environment: currentEnvironment(),
  });
}

/**
 * The entitlement service WITH the ledger attached (A-3).
 *
 * Assigning a plan grants the credits that plan promises, in the same
 * transaction as the subscription. That needs the ledger, and the ledger needs
 * the `credits` policy, which is an async read — so this is a separate,
 * awaited factory rather than a widening of the synchronous one above. Every
 * read-only caller keeps the cheap constructor.
 */
export async function getPlanAssignmentService(): Promise<EntitlementService> {
  return new EntitlementService({
    prisma: getPlatformPrisma(),
    config: getConfigService(),
    environment: currentEnvironment(),
    ledger: await getCreditLedgerService(),
  });
}

export function getCreditService(): CreditService {
  return new CreditService({ prisma: getPlatformPrisma() });
}

/**
 * Phase 3 services.
 *
 * The credit LEDGER needs the `credits` policy domain, because expiry, rollover
 * and the low-balance thresholds are configuration the owner sets. Reading it
 * per request rather than caching it here is deliberate: an activated policy
 * change must take effect without a restart.
 */
export async function getCreditLedgerService(): Promise<CreditLedgerService> {
  return new CreditLedgerService({
    prisma: getPlatformPrisma(),
    policy: await getCreditPolicy(),
  });
}

/** The active `credits` document, or the inert default. */
export async function getCreditPolicy(): Promise<CreditPolicy> {
  /*
   * THE SHARED READER, not a copy of it. This screen and the financial
   * maintenance sweep must agree about what the owner configured, and they
   * cannot if each parses the document itself.
   */
  const payload = await getConfigService().get('credits', currentEnvironment());
  return creditPolicyFrom(payload as Record<string, unknown>);
}

export function getSubscriptionService(): SubscriptionService {
  return new SubscriptionService({ prisma: getPlatformPrisma() });
}

export function getBetaCohortService(): BetaCohortService {
  return new BetaCohortService({ prisma: getPlatformPrisma() });
}

/**
 * Read-only access to AI request history, usage and cost.
 *
 * The explorer authorizes on `platform.ai.usage.read` itself rather than
 * trusting the page that constructed it: a page guard and a service guard are
 * two independent controls, and only one of them survives a refactor.
 */
export function getAiUsageExplorer(): AiUsageExplorer {
  return new AiUsageExplorer({ prisma: getPlatformPrisma() });
}

/**
 * How the Control Center sends email.
 *
 * IT DELEGATES RATHER THAN RESOLVING, even though this process holds
 * `SECRET_VAULT_KEK` and could resolve the provider itself. The reason is not
 * capability, it is arithmetic: two resolvers are two answers to "which
 * provider is live", and they drift the first time one is changed. The API owns
 * the answer (apps/api/src/email-provider.ts) and this asks it.
 *
 * THE TRUSTED CHANNEL DECIDES, NOT THE ENVIRONMENT LABEL — the same rule the
 * dashboard follows, for the same reason: a staging deployment wired exactly
 * like production must exercise the path production takes, not a table.
 * Without `INTERNAL_SERVICE_TOKEN` and outside production it stays the outbox,
 * so an operator suspending a workspace locally gets a row they can read rather
 * than a network call they have to run an API for.
 */
export function getEmailProvider(): EmailProvider {
  const delegationConfigured = (process.env['INTERNAL_SERVICE_TOKEN'] ?? '').trim() !== '';
  if (isProduction() || delegationConfigured) return new ApiEmailProvider();
  return new OutboxEmailProvider(getPlatformPrisma());
}

export { getPlatformPrisma };

/**
 * Resolve the current platform actor from the request cookie.
 *
 * THE server-side gate. Returns null for: no cookie, unknown session, expired,
 * revoked, MFA not yet verified, inactive user, or a role that may not reach
 * the Control Center.
 */
export async function getPlatformActor(): Promise<AuthenticatedPlatformActor | null> {
  const store = await cookies();
  const token = store.get(PLATFORM_REALM.cookieName)?.value;
  if (!token) return null;
  return getPlatformAuth().resolveActor(token);
}

/**
 * Require an authenticated actor, optionally with a specific permission.
 *
 * Throws rather than returning null, so a page that forgets to handle the null
 * case fails closed instead of rendering as if authorised.
 */
export async function requirePlatformActor(
  permissionKey?: string,
): Promise<AuthenticatedPlatformActor> {
  const actor = await getPlatformActor();
  if (!actor) {
    throw new PlatformAccessError('UNAUTHENTICATED', 'Platform authentication required.');
  }
  if (permissionKey && !actor.permissionKeys.includes(permissionKey)) {
    throw new PlatformAccessError('FORBIDDEN', `Missing platform permission: ${permissionKey}`);
  }
  return actor;
}

/**
 * Page-level guard.
 *
 * Same fail-closed decision as `requirePlatformActor`, expressed as the two
 * outcomes a PAGE should produce:
 *
 *   - no usable session  -> redirect to sign-in. The console layout redirects
 *     too, but a page renders in parallel with its layout, so a page that only
 *     threw would log a stack trace on every signed-out request and bury real
 *     errors in noise.
 *   - authenticated, but missing the permission -> 404, shaped exactly like a
 *     page that does not exist. Telling someone which admin pages they are
 *     merely not allowed to see is itself information (CLAUDE.md §2.1).
 *
 * Server actions keep `requirePlatformActor`: they must not redirect, because
 * their callers turn failures into a message for the operator.
 */
export async function requirePageActor(
  locale: string,
  permissionKey?: string,
): Promise<AuthenticatedPlatformActor> {
  const actor = await getPlatformActor().catch(() => null);
  if (!actor) redirect(`/${locale}/login`);
  if (permissionKey && !actor.permissionKeys.includes(permissionKey)) notFound();
  return actor;
}

/**
 * The actor shape the domain services require.
 *
 * One conversion in one place, so no call site can quietly drop
 * `permissionKeys` and hand a service an actor it cannot authorize.
 */
export function serviceActor(actor: AuthenticatedPlatformActor): {
  platformUserId: string;
  roleKey: string;
  mfaVerified: boolean;
  permissionKeys: readonly string[];
} {
  return {
    platformUserId: actor.platformUserId,
    roleKey: actor.roleKey,
    mfaVerified: actor.mfaVerified,
    permissionKeys: actor.permissionKeys,
  };
}

export class PlatformAccessError extends Error {
  constructor(
    readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
    this.name = 'PlatformAccessError';
  }
}

/**
 * Re-exported from `@brandspace/shared` so every caller in this app keeps its
 * existing import. The DEFINITION moved: it used to live here, and in eleven
 * other files, each a private copy of the same four lines (Phase 10 §18).
 */
export { currentEnvironment };

/**
 * The billing inbox, for an operator — current execution Phase 3.
 *
 * REPLAY ONLY, AND THAT IS ENFORCED BY CONSTRUCTION. No provider registry is
 * supplied, so this reconciler cannot verify a signature and cannot accept a
 * delivery; it can only re-apply an event the platform already received and
 * already verified. The Control Center therefore never holds a webhook signing
 * secret (F-07) while still being able to finish a stuck payment.
 *
 * THE LEDGER PORT IS THE SAME ONE `apps/api` USES — one function wide, "grant
 * these credits, once, inside the transaction I am already in" (D-196). A
 * replayed pack purchase grants exactly what the original would have.
 */
export function getBillingReconciler(): BillingReconciler {
  return new BillingReconciler({
    credits: creditLedgerPort(new CreditLedgerService({ prisma: getPlatformPrisma() })),
  });
}

/** The activated commercial catalogue. Read per call: an activation must take effect. */
export async function getCommercePolicy(): Promise<CommercePolicy> {
  const document = await getConfigService().get('commerce', currentEnvironment());
  return commercePolicyFrom(document as Record<string, unknown>);
}

/** The activated plan catalogue and the version a settlement pins against. */
export async function getPlanCatalogue(): Promise<{
  plans: readonly PlanDetail[];
  versionId: string | null;
}> {
  const environment = currentEnvironment();
  const configuration = getConfigService();
  const [document, versionId] = await Promise.all([
    configuration.get('plans', environment),
    configuration.activeVersionId('plans', environment),
  ]);
  return {
    plans: readPlanCatalogue(document as Record<string, unknown>),
    versionId,
  };
}
