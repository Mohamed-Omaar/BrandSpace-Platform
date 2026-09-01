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

  it('gives Client Viewer the narrowest workspace access', () => {
    const clientViewer = ROLE_DEFINITIONS.find((r) => r.key === 'client_viewer');
    expect(clientViewer?.permissionKeys).toEqual(['workspace.read']);
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
