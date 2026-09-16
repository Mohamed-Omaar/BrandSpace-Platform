import { describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS, WORKSPACE_PERMISSIONS } from '@brandspace/shared';

/**
 * Who may do what in Phase 6 — asserted, not reviewed.
 *
 * THE MOST CONSEQUENTIAL KEY IN THE PRODUCT IS `integrations.manage`. At the end
 * of exercising it, BrandSpace can post to the world as the customer. So the
 * questions this file settles are: who holds it, who does not, and — the one
 * that has bitten this codebase before — whether a blanket grant silently
 * handed it to somebody the moment it was added.
 *
 * D-62 AND D-130 ARE THE BACKSTOP. `client_viewer` is strictly read-only for the
 * MVP: no publishing, no approving, no scheduling, no integrations, nothing.
 * That is asserted here in the strongest available form — its permission set is
 * EXACTLY one key.
 */

const roleFor = (key: string) => {
  const role = ROLE_DEFINITIONS.find((definition) => definition.key === key);
  if (!role) throw new Error(`role ${key} is missing`);
  return role;
};

const PHASE_6_KEYS = [
  'integrations.read',
  'integrations.manage',
  'publishing.read',
  'publishing.manage',
] as const;

describe('the Phase 6 permission catalogue', () => {
  it('declares four keys, split by how much trust each one is', () => {
    for (const key of PHASE_6_KEYS) {
      const definition = WORKSPACE_PERMISSIONS.find((p) => p.key === key);
      expect(definition, `${key} must be declared`).toBeTruthy();
      expect(definition?.minScope).toBe('workspace');
      expect(definition?.description.length).toBeGreaterThan(10);
    }
  });

  it('every Phase 6 key is workspace-realm — none is a platform authority', () => {
    /*
     * D-133: a PLATFORM-realm role must never be bound to a workspace
     * membership. Declaring a publishing key in the platform realm would be the
     * other way round — a customer capability living where only the Control
     * Center can reach it.
     */
    for (const key of PHASE_6_KEYS) {
      expect(WORKSPACE_PERMISSIONS.some((p) => p.key === key)).toBe(true);
    }
  });
});

describe('client_viewer is STRICTLY read-only (D-62, D-130)', () => {
  it('holds exactly one permission, and it is not a Phase 6 one', () => {
    const viewer = roleFor('client_viewer');
    expect(viewer.permissionKeys).toEqual(['workspace.read']);
  });

  it('CANNOT CONNECT, DISCONNECT, PUBLISH, CANCEL OR RETRY', () => {
    const viewer = roleFor('client_viewer');
    for (const key of PHASE_6_KEYS) {
      expect(viewer.permissionKeys, `viewer must not hold ${key}`).not.toContain(key);
    }
  });

  it('cannot even SEE which accounts are connected', () => {
    /*
     * Deliberate. The connected-accounts page states which external accounts a
     * brand controls, which is business information the narrowest role has no
     * need for — and the route requires `integrations.read`, so the refusal is
     * real rather than a hidden link.
     */
    expect(roleFor('client_viewer').permissionKeys).not.toContain('integrations.read');
  });
});

describe('read-only roles stay read-only', () => {
  it('the analyst may look and may not act', () => {
    const analyst = roleFor('analyst');
    expect(analyst.permissionKeys).toContain('integrations.read');
    expect(analyst.permissionKeys).toContain('publishing.read');
    // Both of the keys that cause an external effect are withheld.
    expect(analyst.permissionKeys).not.toContain('integrations.manage');
    expect(analyst.permissionKeys).not.toContain('publishing.manage');
  });

  it('the approver sees what became of what it approved, and nothing more', () => {
    const approver = roleFor('approver');
    expect(approver.permissionKeys).toContain('publishing.read');
    expect(approver.permissionKeys).not.toContain('integrations.manage');
    expect(approver.permissionKeys).not.toContain('publishing.manage');
  });
});

describe('connecting an account is not a content capability', () => {
  it('a content creator may schedule but MAY NOT authorize an account', () => {
    /*
     * The separation that matters most in this phase. Scheduling a post is a
     * content decision; granting a third party the right to post as the brand
     * is not, and bundling them would mean everyone who can write a caption can
     * also connect an account nobody reviewed.
     */
    const creator = roleFor('content_creator');
    expect(creator.permissionKeys).toContain('content.schedule');
    expect(creator.permissionKeys).toContain('integrations.read');
    expect(creator.permissionKeys).not.toContain('integrations.manage');
  });

  it('the marketing manager runs the brand end to end, including its accounts', () => {
    const manager = roleFor('marketing_manager');
    for (const key of PHASE_6_KEYS) {
      expect(manager.permissionKeys, `the manager needs ${key}`).toContain(key);
    }
  });

  it('the owner and the admin both hold every Phase 6 key', () => {
    for (const roleKey of ['workspace_owner', 'workspace_admin']) {
      const role = roleFor(roleKey);
      for (const key of PHASE_6_KEYS) {
        expect(role.permissionKeys, `${roleKey} needs ${key}`).toContain(key);
      }
    }
  });
});

describe('no role gained a Phase 6 key by accident', () => {
  it('every holder of integrations.manage is named here', () => {
    /*
     * A CLOSED LIST, because `workspace_admin` is defined as "everything except
     * three keys" and a blanket grant silently inherits every future
     * permission. That exact mistake was caught once before by
     * tests/unit/phase2b-boundaries.test.ts, and this is its Phase 6 equivalent
     * for the most dangerous key in the product.
     */
    const holders = ROLE_DEFINITIONS.filter(
      (role) => role.realm === 'workspace' && role.permissionKeys.includes('integrations.manage'),
    ).map((role) => role.key);
    expect(holders.sort()).toEqual(
      ['marketing_manager', 'workspace_admin', 'workspace_owner'].sort(),
    );
  });

  it('every holder of publishing.manage is named here', () => {
    const holders = ROLE_DEFINITIONS.filter(
      (role) => role.realm === 'workspace' && role.permissionKeys.includes('publishing.manage'),
    ).map((role) => role.key);
    expect(holders.sort()).toEqual(
      ['marketing_manager', 'workspace_admin', 'workspace_owner'].sort(),
    );
  });

  it('NO PLATFORM ROLE HOLDS A WORKSPACE PUBLISHING KEY', () => {
    // The realms are disjoint by construction; this asserts it stayed that way
    // when four keys were added (D-133).
    for (const role of ROLE_DEFINITIONS.filter((r) => r.realm === 'platform')) {
      for (const key of PHASE_6_KEYS) {
        expect(role.permissionKeys, `${role.key} must not hold ${key}`).not.toContain(key);
      }
    }
  });
});
