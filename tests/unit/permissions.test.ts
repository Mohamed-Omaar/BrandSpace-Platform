import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  ROLE_DEFINITIONS,
  WORKSPACE_PERMISSIONS,
  assertRealmsAreDisjoint,
  assertRolePermissionsAreValid,
} from '@brandspace/shared';

describe('permission catalogue', () => {
  it('has unique keys', () => {
    const keys = ALL_PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the workspace and platform realms disjoint', () => {
    expect(() => assertRealmsAreDisjoint()).not.toThrow();
    const workspaceKeys = new Set(WORKSPACE_PERMISSIONS.map((p) => p.key));
    for (const p of PLATFORM_PERMISSIONS) expect(workspaceKeys.has(p.key)).toBe(false);
  });

  it('prefixes every platform permission with "platform."', () => {
    for (const p of PLATFORM_PERMISSIONS) expect(p.key.startsWith('platform.')).toBe(true);
  });

  it('never prefixes a workspace permission with "platform."', () => {
    for (const p of WORKSPACE_PERMISSIONS) expect(p.key.startsWith('platform.')).toBe(false);
  });

  it('declares a scope for every permission', () => {
    for (const p of ALL_PERMISSIONS) {
      expect(['platform', 'workspace', 'brand', 'campaign']).toContain(p.minScope);
    }
  });
});

describe('role definitions', () => {
  it('never mixes permissions across realms', () => {
    expect(() => assertRolePermissionsAreValid()).not.toThrow();
  });

  it('covers all nine customer roles and all five platform roles', () => {
    const workspaceRoles = ROLE_DEFINITIONS.filter((r) => r.realm === 'workspace');
    const platformRoles = ROLE_DEFINITIONS.filter((r) => r.realm === 'platform');
    expect(workspaceRoles).toHaveLength(9);
    expect(platformRoles).toHaveLength(5);
  });

  it('gives every role an Arabic and an English name', () => {
    for (const role of ROLE_DEFINITIONS) {
      expect(role.nameEn.length).toBeGreaterThan(0);
      expect(role.nameAr.length).toBeGreaterThan(0);
      // The Arabic name must actually be Arabic script, not a copied English string.
      expect(/[؀-ۿ]/.test(role.nameAr)).toBe(true);
    }
  });

  it('reserves ownership transfer and deletion to the Workspace Owner alone', () => {
    for (const role of ROLE_DEFINITIONS) {
      if (role.key === 'workspace_owner') continue;
      expect(role.permissionKeys).not.toContain('workspace.transfer_ownership');
      expect(role.permissionKeys).not.toContain('workspace.delete');
    }
  });

  it('gives the read-only Viewer the narrowest workspace access', () => {
    const readOnlyViewer = ROLE_DEFINITIONS.find((r) => r.key === 'client_viewer');
    expect(readOnlyViewer?.permissionKeys).toEqual(['workspace.read']);
  });

  /*
   * §18's rename, guarded.
   *
   * "Client Viewer" was agency-shop language for a role that is simply
   * read-only. The LABEL changed; the key and the grants must not, because
   * `client_viewer` is written into membership rows and asserted by the RBAC
   * and isolation suites. This test fails if a future edit renames the key, or
   * quietly widens the role while relabelling it.
   */
  it('renames the read-only role in the interface without touching its key or its grants', () => {
    const role = ROLE_DEFINITIONS.find((r) => r.key === 'client_viewer');
    expect(role, 'the stored RBAC key client_viewer must not be renamed').toBeDefined();
    expect(role?.permissionKeys).toEqual(['workspace.read']);
    expect(role?.nameEn).not.toMatch(/client/i);
    expect(role?.nameAr).not.toContain('عميل');
  });

  it('reserves platform user management to the Platform Owner alone', () => {
    for (const role of ROLE_DEFINITIONS) {
      if (role.key === 'platform_owner') continue;
      expect(role.permissionKeys).not.toContain('platform.user.manage');
    }
  });

  it('grants no platform role a workspace permission', () => {
    const workspaceKeys = new Set(WORKSPACE_PERMISSIONS.map((p) => p.key));
    for (const role of ROLE_DEFINITIONS.filter((r) => r.realm === 'platform')) {
      for (const key of role.permissionKeys) expect(workspaceKeys.has(key)).toBe(false);
    }
  });
});
