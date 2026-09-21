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

  /**
   * `content.create` IS THE RIGHT TO CREATE A DRAFT, NOT THE RIGHT TO SPEND
   * (D-231).
   *
   * It was described as "Generate content with AI (spends credits)" because
   * generation was the only way a `content_item` could come into being. Phase 2
   * added manual authoring — no model, no reservation, no ledger entry — under
   * this same key, and a description that tells an operator every use of a
   * permission moves money, when half of them do not, is how a role gets
   * withheld from somebody who needed it.
   *
   * THE GRANTS ARE PINNED, so relabelling can never be the cover for widening.
   * This correction changed what the key SAYS and nothing about who holds it.
   */
  it('describes content.create by what it creates, and does not claim it always spends', () => {
    const permission = WORKSPACE_PERMISSIONS.find((p) => p.key === 'content.create');
    expect(permission).toBeDefined();
    expect(permission?.description).not.toMatch(/spends credits/i);
    expect(permission?.description).toMatch(/draft/i);

    const holders = ROLE_DEFINITIONS.filter((role) =>
      role.permissionKeys.includes('content.create'),
    ).map((role) => role.key);
    expect(holders).toEqual([
      'workspace_owner',
      'workspace_admin',
      'marketing_manager',
      'content_creator',
      'copywriter',
    ]);
  });

  /**
   * And the keys that DO always spend still say so, so the correction above is
   * a narrowing of one claim rather than the removal of a useful warning.
   */
  it('keeps the spending warning on the permissions that always spend', () => {
    for (const key of ['analytics.explain', 'copilot.use']) {
      const permission = WORKSPACE_PERMISSIONS.find((p) => p.key === key);
      expect(permission, key).toBeDefined();
      expect(permission?.description, key).toMatch(/spends credits/i);
    }
  });
});
