import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_REALM,
  PLATFORM_REALM,
  assertRealmsAreSeparated,
  hasPermission,
  isCustomerActor,
  isPlatformActor,
  type CustomerActor,
  type PlatformActor,
} from '@brandspace/auth';

/**
 * "Do not expose Platform Admin authentication to customer sessions."
 * docs/SECURITY.md §3 and D-04.
 */

describe('session realm separation', () => {
  it('uses different cookie names', () => {
    expect(CUSTOMER_REALM.cookieName).not.toBe(PLATFORM_REALM.cookieName);
  });

  it('uses different token audiences, so a token cannot be replayed across realms', () => {
    expect(CUSTOMER_REALM.audience).not.toBe(PLATFORM_REALM.audience);
  });

  it('reads its signing key from a different environment variable', () => {
    expect(CUSTOMER_REALM.secretEnvVar).not.toBe(PLATFORM_REALM.secretEnvVar);
  });

  it('requires MFA on the platform realm and not the customer realm (D-27)', () => {
    expect(PLATFORM_REALM.requiresMfa).toBe(true);
    expect(CUSTOMER_REALM.requiresMfa).toBe(false);
  });

  it('gives the platform realm a shorter session, since its blast radius is larger', () => {
    expect(PLATFORM_REALM.sessionTtlSeconds).toBeLessThan(CUSTOMER_REALM.sessionTtlSeconds);
    expect(PLATFORM_REALM.absoluteTtlSeconds).toBeLessThan(CUSTOMER_REALM.absoluteTtlSeconds);
  });

  it('uses __Host- prefixed cookies in both realms', () => {
    expect(CUSTOMER_REALM.cookieName.startsWith('__Host-')).toBe(true);
    expect(PLATFORM_REALM.cookieName.startsWith('__Host-')).toBe(true);
  });

  it('passes its own separation assertion', () => {
    expect(() => assertRealmsAreSeparated()).not.toThrow();
  });
});

describe('actor discrimination', () => {
  const customer: CustomerActor = {
    kind: 'customer',
    realm: 'customer',
    userId: 'u1',
    workspaceId: 'w1',
    membershipId: 'm1',
    roleKey: 'workspace_owner',
    permissionKeys: ['workspace.read'],
    brandScope: null,
  };
  const platform: PlatformActor = {
    kind: 'platform',
    realm: 'platform',
    platformUserId: 'p1',
    roleKey: 'platform_owner',
    permissionKeys: ['platform.workspace.read'],
    mfaVerified: true,
  };

  it('distinguishes the two actor kinds', () => {
    expect(isCustomerActor(customer)).toBe(true);
    expect(isPlatformActor(customer)).toBe(false);
    expect(isPlatformActor(platform)).toBe(true);
    expect(isCustomerActor(platform)).toBe(false);
  });

  it('does not grant a customer any platform permission', () => {
    expect(hasPermission(customer, 'platform.workspace.read')).toBe(false);
  });

  it('does not grant a platform actor a workspace permission implicitly', () => {
    expect(hasPermission(platform, 'workspace.read')).toBe(false);
  });
});
