/**
 * The two session realms — docs/SECURITY.md §3, D-04.
 *
 * A customer session and a platform session differ in cookie name, signing key,
 * token audience and session store. A customer session presented to Admin is not
 * merely rejected by policy: it is signed with a different key and carries a
 * different audience, so it cannot be verified there at all.
 */

export const REALMS = ['customer', 'platform'] as const;
export type Realm = (typeof REALMS)[number];

export interface RealmConfig {
  readonly realm: Realm;
  /** `__Host-` prefix requires Secure, path=/, and no Domain attribute. */
  readonly cookieName: string;
  /** JWT/session audience. Verification fails across realms. */
  readonly audience: string;
  /** Which env var holds this realm's signing key. Never the key itself. */
  readonly secretEnvVar: 'CUSTOMER_SESSION_SECRET' | 'PLATFORM_SESSION_SECRET';
  readonly sessionTtlSeconds: number;
  readonly absoluteTtlSeconds: number;
  readonly sameSite: 'lax' | 'strict';
  /** D-27: mandatory 2FA for every platform role. */
  readonly requiresMfa: boolean;
}

export const CUSTOMER_REALM: RealmConfig = {
  realm: 'customer',
  cookieName: '__Host-bs_customer_session',
  audience: 'brandspace:customer',
  secretEnvVar: 'CUSTOMER_SESSION_SECRET',
  sessionTtlSeconds: 60 * 60 * 12,
  absoluteTtlSeconds: 60 * 60 * 24 * 30,
  sameSite: 'lax',
  requiresMfa: false,
};

export const PLATFORM_REALM: RealmConfig = {
  realm: 'platform',
  cookieName: '__Host-bs_platform_session',
  audience: 'brandspace:platform',
  secretEnvVar: 'PLATFORM_SESSION_SECRET',
  // Shorter sessions: an admin compromise has the largest blast radius.
  sessionTtlSeconds: 60 * 60 * 4,
  absoluteTtlSeconds: 60 * 60 * 12,
  sameSite: 'strict',
  requiresMfa: true,
};

export const REALM_CONFIGS: Record<Realm, RealmConfig> = {
  customer: CUSTOMER_REALM,
  platform: PLATFORM_REALM,
};

/** The realms must never share a cookie name, audience, or signing key source. */
export function assertRealmsAreSeparated(): void {
  if (CUSTOMER_REALM.cookieName === PLATFORM_REALM.cookieName) {
    throw new Error('Session realms must not share a cookie name.');
  }
  if (CUSTOMER_REALM.audience === PLATFORM_REALM.audience) {
    throw new Error('Session realms must not share a token audience.');
  }
  if (CUSTOMER_REALM.secretEnvVar === PLATFORM_REALM.secretEnvVar) {
    throw new Error('Session realms must not share a signing key.');
  }
}
