import 'server-only';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getPlatformClient, type PlatformPrismaClient } from '@brandspace/database/platform';
import {
  PLATFORM_REALM,
  PlatformAuthService,
  type AuthenticatedPlatformActor,
} from '@brandspace/auth';
import { ConfigurationService } from '@brandspace/config';
import { SecretService } from '@brandspace/secrets';

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

export function getPlatformAuth(): PlatformAuthService {
  return new PlatformAuthService({
    prisma: getPlatformPrisma(),
    // The TOTP seed lives in the vault, never in a column.
    resolveMfaSecret: async (secretRef) =>
      getSecretService().resolveSecret(secretRef, currentEnvironment()),
  });
}

export function currentEnvironment(): 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION' {
  const appEnv = process.env['APP_ENV'] ?? 'development';
  if (appEnv === 'production') return 'PRODUCTION';
  if (appEnv === 'staging') return 'STAGING';
  return 'DEVELOPMENT';
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
