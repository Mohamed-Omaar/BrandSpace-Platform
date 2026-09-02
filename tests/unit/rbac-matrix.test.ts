import { describe, expect, it } from 'vitest';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_KEYS,
  ROLE_DEFINITIONS,
  assertRolePermissionsAreValid,
} from '@brandspace/shared';

/**
 * The platform RBAC matrix, asserted as data.
 *
 * The independent review found every secret and configuration action gated on
 * `platform.workspace.read` — "View any workspace" — which support, billing and
 * operations roles all hold. Reading a customer's workspace and rotating a
 * production API key were the same authority.
 *
 * This test pins the matrix so a future role edit that quietly re-widens it
 * fails here, in a fast unit test, with the whole table visible.
 */

function permissionsFor(roleKey: string): readonly string[] {
  const definition = ROLE_DEFINITIONS.find((d) => d.key === roleKey);
  if (!definition) throw new Error(`No role definition for ${roleKey}`);
  return definition.permissionKeys;
}

const CONFIG_WRITE = ['platform.configuration.manage', 'platform.configuration.activate'];
const SECRET_ANY = ['platform.secret.read', 'platform.secret.manage'];

describe('the platform permission catalogue', () => {
  it('separates configuration read, edit and activation', () => {
    const keys = PLATFORM_PERMISSIONS.map((p) => p.key);
    expect(keys).toContain('platform.configuration.read');
    expect(keys).toContain('platform.configuration.manage');
    expect(keys).toContain('platform.configuration.activate');
  });

  it('separates secret metadata from secret management', () => {
    const keys = PLATFORM_PERMISSIONS.map((p) => p.key);
    expect(keys).toContain('platform.secret.read');
    expect(keys).toContain('platform.secret.manage');
  });

  it('keeps every role internally consistent', () => {
    expect(() => assertRolePermissionsAreValid()).not.toThrow();
  });
});

describe('least privilege per platform role', () => {
  it('gives the Platform Owner everything', () => {
    const owner = permissionsFor('platform_owner');
    for (const permission of PLATFORM_PERMISSIONS) {
      expect(owner).toContain(permission.key);
    }
  });

  it('gives the Platform Admin everything except managing platform users', () => {
    const admin = permissionsFor('platform_admin');
    expect(admin).not.toContain('platform.user.manage');
    expect(admin).toContain('platform.configuration.activate');
    expect(admin).toContain('platform.secret.manage');
  });

  it.each(['support_agent', 'billing_manager', 'operations_viewer'])(
    '%s can never write configuration',
    (roleKey) => {
      const keys = permissionsFor(roleKey);
      for (const write of CONFIG_WRITE) {
        expect(keys, `${roleKey} must not hold ${write}`).not.toContain(write);
      }
    },
  );

  it.each(['support_agent', 'billing_manager', 'operations_viewer'])(
    '%s holds no secret permission at all',
    (roleKey) => {
      const keys = permissionsFor(roleKey);
      for (const secret of SECRET_ANY) {
        expect(keys, `${roleKey} must not hold ${secret}`).not.toContain(secret);
      }
    },
  );

  it('lets the Operations Viewer read configuration and nothing more', () => {
    expect(permissionsFor('operations_viewer')).toEqual([
      'platform.workspace.read',
      'platform.audit.read',
      'platform.configuration.read',
    ]);
  });

  it('gives the Support Agent no configuration access of any kind', () => {
    const keys = permissionsFor('support_agent');
    expect(keys.filter((k) => k.startsWith('platform.configuration.'))).toEqual([]);
  });

  it('never lets platform.workspace.read imply a configuration or secret write', () => {
    for (const roleKey of PLATFORM_ROLE_KEYS) {
      const keys = permissionsFor(roleKey);
      if (!keys.includes('platform.workspace.read')) continue;
      if (keys.includes('platform.configuration.manage')) {
        // Only roles that were deliberately given the write permission.
        expect(['platform_owner', 'platform_admin']).toContain(roleKey);
      }
      if (keys.includes('platform.secret.manage')) {
        expect(['platform_owner', 'platform_admin']).toContain(roleKey);
      }
    }
  });
});
