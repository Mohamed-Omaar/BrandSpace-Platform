import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  CUSTOMER_ROLE_KEYS,
  PLATFORM_ROLE_KEYS,
  ROLE_DEFINITIONS,
  WORKSPACE_PERMISSIONS,
  assertRealmsAreDisjoint,
  assertRolePermissionsAreValid,
} from '@brandspace/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * Phase 2B boundaries and the RBAC matrix.
 *
 * The probe-based suite in module-boundaries.test.ts proves the LINT RULE
 * rejects a forbidden import. This file asserts the stronger, less abstract
 * thing: the customer application's REAL source does not contain one. A rule
 * that is never violated and a rule that cannot be violated look identical
 * until somebody adds the import.
 */

/**
 * Every TypeScript source file under one app, walked from DISK.
 *
 * Deliberately not `git ls-files`: the index does not yet contain a new file
 * and still contains a deleted one, so a scan of the index can miss exactly the
 * file that introduced a violation. What ships is what is on disk.
 */
function sourceFiles(app: string): string[] {
  const root = path.join(repoRoot, 'apps', app, 'src');
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(full);
    }
  };

  walk(root);
  return found;
}

/**
 * Read a file that may have vanished since it was listed.
 *
 * WHY THIS IS NOT A WEAKENING. `module-boundaries.test.ts` proves the ESLint
 * boundaries are real by PLANTING `apps/dashboard/src/__boundary_probe.ts`,
 * running the linter against it and deleting it again. The two suites run in
 * the same pass, so this one can list a probe and then read it after the other
 * has removed it — an `ENOENT` that says nothing at all about the boundary
 * under test. (`brand-scope-predicate-gate.test.ts` was corrected for exactly
 * this, and this is the second instance of the same race.)
 *
 * A FILE THAT IS NO LONGER THERE CANNOT VIOLATE ANYTHING, so it is skipped
 * rather than failed. Every file that IS there is still read and still checked,
 * and the gate's own strength is asserted below by planting a violation and
 * confirming it is caught.
 */
function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

describe('the customer application cannot reach platform-only modules', () => {
  const files = sourceFiles('dashboard');

  it('has source files to check, so this is not vacuous', () => {
    // The customer app has well over a dozen source files; a scan that found
    // only a handful would be silently checking almost nothing.
    expect(files.length).toBeGreaterThan(12);
  });

  it.each([
    ['@brandspace/secrets', 'the Secret Service can decrypt every platform credential'],
    ['@brandspace/database/platform', 'the platform client has cross-tenant visibility'],
    ['platform-pool', 'the platform pool opens the cross-tenant connection'],
    ['platform-client', 'the platform client has cross-tenant visibility'],
  ])('imports %s nowhere (%s)', (specifier) => {
    for (const file of files) {
      const source = readIfPresent(file);
      if (source === null) continue;
      expect(source, `${path.relative(repoRoot, file)} imports ${specifier}`).not.toContain(
        `from '${specifier}'`,
      );
      expect(source).not.toContain(`require('${specifier}')`);
    }
  });

  it('never references the platform connection string', () => {
    for (const file of files) {
      const source = readIfPresent(file);
      if (source === null) continue;
      expect(source, path.relative(repoRoot, file)).not.toContain('DATABASE_PLATFORM_URL');
    }
  });

  it('never calls asPlatform()', () => {
    // The one audited cross-tenant entrance is not for tenant surfaces.
    for (const file of files) {
      const source = readIfPresent(file);
      if (source === null) continue;
      expect(source, path.relative(repoRoot, file)).not.toContain('asPlatform(');
    }
  });

  it('reaches customer data through the tenant-scoped seams only', () => {
    // A positive assertion, so the negatives above cannot be satisfied by the
    // app simply not talking to a database at all.
    const contextFile = readFileSync(
      path.join(repoRoot, 'apps/dashboard/src/server/customer-context.ts'),
      'utf8',
    );
    expect(contextFile).toContain("from '@brandspace/database'");
    expect(contextFile).toContain("import 'server-only'");
  });
});

describe('the Control Center still owns the platform surface', () => {
  it('is the app that holds the platform client', () => {
    const contextFile = readFileSync(
      path.join(repoRoot, 'apps/admin/src/server/platform-context.ts'),
      'utf8',
    );
    expect(contextFile).toContain('@brandspace/database/platform');
    expect(contextFile).toContain("import 'server-only'");
  });
});

describe('the permission registry stays coherent', () => {
  it('keeps the realms disjoint', () => {
    expect(() => assertRealmsAreDisjoint()).not.toThrow();
  });

  it('never lets a role reference the other realm', () => {
    expect(() => assertRolePermissionsAreValid()).not.toThrow();
  });

  it('has no duplicate permission keys', () => {
    const keys = ALL_PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('defines every Phase 2B permission', () => {
    const keys = ALL_PERMISSIONS.map((p) => p.key);
    for (const key of [
      'billing.read',
      'billing.manage',
      'credits.read',
      'platform.workspace.update',
      'platform.workspace.invite',
      'platform.plan.assign',
      'platform.entitlement.override',
      'platform.credit.adjust',
    ]) {
      expect(keys).toContain(key);
    }
  });

  it('gives every role a definition', () => {
    for (const key of [...CUSTOMER_ROLE_KEYS, ...PLATFORM_ROLE_KEYS]) {
      expect(ROLE_DEFINITIONS.find((r) => r.key === key)).toBeDefined();
    }
  });
});

/**
 * The customer RBAC matrix, transcribed from docs/SECURITY.md §4.3.
 *
 * Table-driven so a role that quietly gains an authority fails HERE, in a fast
 * unit test, rather than being discovered in production. Only the unambiguous
 * (✅ / ➖) cells are asserted; the conditional ones are recorded as ungranted
 * in F-15 and are asserted as ungranted below.
 */
describe('the customer role matrix matches the Blueprint', () => {
  const grants = (roleKey: string): readonly string[] =>
    ROLE_DEFINITIONS.find((r) => r.key === roleKey)?.permissionKeys ?? [];

  it('only the Owner may transfer ownership or delete the workspace', () => {
    for (const key of ['workspace.transfer_ownership', 'workspace.delete']) {
      expect(grants('workspace_owner')).toContain(key);
      for (const role of CUSTOMER_ROLE_KEYS.filter((r) => r !== 'workspace_owner')) {
        expect(grants(role), `${role} must not hold ${key}`).not.toContain(key);
      }
    }
  });

  it('only the Owner may change the plan', () => {
    expect(grants('workspace_owner')).toContain('billing.manage');
    for (const role of CUSTOMER_ROLE_KEYS.filter((r) => r !== 'workspace_owner')) {
      expect(grants(role)).not.toContain('billing.manage');
    }
  });

  it('the Admin may view billing but not change it', () => {
    expect(grants('workspace_admin')).toContain('billing.read');
    expect(grants('workspace_admin')).not.toContain('billing.manage');
  });

  it('only Owner and Admin may manage membership', () => {
    for (const key of ['member.invite', 'member.remove', 'member.assign_role']) {
      expect(grants('workspace_owner')).toContain(key);
      expect(grants('workspace_admin')).toContain(key);
      for (const role of CUSTOMER_ROLE_KEYS.filter(
        (r) => r !== 'workspace_owner' && r !== 'workspace_admin',
      )) {
        expect(grants(role), `${role} must not hold ${key}`).not.toContain(key);
      }
    }
  });

  it('content and marketing roles cannot manage membership, billing or settings', () => {
    for (const role of ['marketing_manager', 'content_creator', 'copywriter', 'designer']) {
      for (const key of [
        'member.invite',
        'member.remove',
        'member.assign_role',
        'billing.manage',
        'workspace.update',
        'workspace.delete',
      ]) {
        expect(grants(role), `${role} must not hold ${key}`).not.toContain(key);
      }
    }
  });

  it('read-only roles hold no mutating permission at all', () => {
    /*
     * "MUTATING" MEANS CHANGES STATE OR CAUSES AN EFFECT — which is what makes
     * a role read-only. Two keys are exempted, and both exemptions are about
     * the RULE rather than about a role we wish to widen:
     *
     *   - `audit.read` is a read whose `action` is not spelled "read".
     *   - `analytics.export` writes an audit row and changes NOTHING ELSE. It
     *     takes out exactly what the caller could already see on the screen, so
     *     it cannot disclose anything a read could not. Taking the numbers out
     *     is the Analyst's entire job, and a role that can read a chart but not
     *     save it is a role nobody would use.
     *
     * Everything that spends credits or causes an effect stays on the list, and
     * `analytics.explain`, `copilot.use`, `strategy.manage` and
     * `automation.manage` are all on it.
     */
    const readOnlyExempt = ['audit.read', 'analytics.export'];
    const mutating = WORKSPACE_PERMISSIONS.filter(
      (p) => !['read'].includes(p.action) && !readOnlyExempt.includes(p.key),
    ).map((p) => p.key);

    /*
     * `approver` LEFT THIS LIST IN PHASE 5, AND THE TEST IS SHARPER FOR IT.
     *
     * It was read-only only because nothing it could approve existed yet.
     * D-65 makes approving an extracted candidate a human decision with a named
     * owner, and the role whose entire purpose is judging proposals has to be
     * able to make it. Its exact grant is pinned in its own test below rather
     * than left to a blanket rule, so widening it stays a deliberate act.
     *
     * `analyst` and `client_viewer` remain strictly read-only — including no
     * `brand_brain.chat`, because a chat turn spends credits and writes a
     * conversation. It is a mutation wearing a question mark, and a read-only
     * role must not be able to spend money.
     */
    /*
     * ONE NAMED EXEMPTION, FOR ONE ROLE (Q12). `notes.manage` split note triage
     * (resolve, assign, due date, importance) out of `content.read`, which the
     * Analyst already held and used for exactly that. Keeping it means the
     * split changed nothing for the Analyst; it changes no content, spends
     * nothing and publishes nothing. The Viewer gets NO exemption: it may only
     * comment.
     */
    const exemptFor: Readonly<Record<string, readonly string[]>> = {
      analyst: ['notes.manage'],
      client_viewer: [],
    };
    for (const role of ['analyst', 'client_viewer']) {
      for (const key of mutating) {
        if (exemptFor[role]?.includes(key)) continue;
        expect(grants(role), `${role} must not hold ${key}`).not.toContain(key);
      }
    }
    expect(grants('analyst')).toContain('notes.manage');
    expect(grants('client_viewer')).not.toContain('notes.manage');

    /*
     * AND THE PHASE 7 KEYS, NAMED RATHER THAN INFERRED. Every one of these
     * either spends credits or changes something, so a read-only role holding
     * one would be a read-only role that can spend money — the same reasoning
     * that withholds `brand_brain.chat`. Named explicitly so that renaming a
     * permission's `action` cannot quietly drop it off the blanket list above.
     */
    for (const key of [
      'analytics.explain',
      'copilot.use',
      'strategy.manage',
      'automation.manage',
    ]) {
      expect(grants('analyst'), `analyst must not hold ${key}`).not.toContain(key);
      expect(grants('client_viewer'), `client_viewer must not hold ${key}`).not.toContain(key);
    }

    /*
     * D-62 / D-130: the Viewer's grant is EXACT, and Phase 7 added nothing to
     * it. Q12's second release (D-323) added `content.read` — a read — and
     * nothing else.
     */
    expect(grants('client_viewer')).toEqual(['workspace.read', 'content.read']);
  });

  it('approver may review extracted knowledge, and may do nothing else to it', () => {
    // Pinned exactly, not as a superset: approving what a document proposed is
    // a different act from authoring brand knowledge, and the review record
    // only means something while the two are kept apart.
    expect(grants('approver')).toContain('brand_brain.review');
    for (const key of [
      'brand_brain.edit',
      'brand_brain.upload',
      'brand_brain.delete',
      'brand_brain.chat',
      'brand.manage',
      'member.invite',
      'billing.manage',
      'workspace.update',
    ]) {
      expect(grants('approver'), `approver must not hold ${key}`).not.toContain(key);
    }
  });

  it('the read-only Viewer sees the workspace and its content, and nothing else (Q12, D-323)', () => {
    expect(grants('client_viewer')).toEqual(['workspace.read', 'content.read']);
  });
});

describe('the platform role matrix matches the Blueprint', () => {
  const grants = (roleKey: string): readonly string[] =>
    ROLE_DEFINITIONS.find((r) => r.key === roleKey)?.permissionKeys ?? [];

  it('only Owner and Admin may create a workspace or grant an override', () => {
    for (const key of [
      'platform.workspace.create',
      'platform.workspace.update',
      'platform.entitlement.override',
    ]) {
      expect(grants('platform_owner')).toContain(key);
      expect(grants('platform_admin')).toContain(key);
      for (const role of ['support_agent', 'billing_manager', 'operations_viewer']) {
        expect(grants(role), `${role} must not hold ${key}`).not.toContain(key);
      }
    }
  });

  it('the Billing Manager may assign plans and move credits, and nothing else', () => {
    expect(grants('billing_manager')).toContain('platform.plan.assign');
    expect(grants('billing_manager')).toContain('platform.credit.adjust');
    for (const key of [
      'platform.workspace.create',
      'platform.entitlement.override',
      'platform.secret.read',
      'platform.secret.manage',
      'platform.configuration.manage',
      'platform.support_mode.enter',
    ]) {
      expect(grants('billing_manager'), `billing_manager must not hold ${key}`).not.toContain(key);
    }
  });

  it('the Support Agent may enter support mode and read, and nothing else', () => {
    expect(grants('support_agent')).toEqual([
      'platform.workspace.read',
      'platform.support_mode.enter',
    ]);
  });

  it('the Operations Viewer holds no mutating permission', () => {
    for (const key of grants('operations_viewer')) {
      expect(key.endsWith('.read')).toBe(true);
    }
  });

  it('no role but the Owner may manage platform users', () => {
    expect(grants('platform_owner')).toContain('platform.user.manage');
    for (const role of PLATFORM_ROLE_KEYS.filter((r) => r !== 'platform_owner')) {
      expect(grants(role)).not.toContain('platform.user.manage');
    }
  });

  it('no role gains a permission from another realm', () => {
    const workspaceKeys = new Set(WORKSPACE_PERMISSIONS.map((p) => p.key));
    for (const role of PLATFORM_ROLE_KEYS) {
      for (const key of grants(role)) {
        expect(workspaceKeys.has(key), `${role} holds workspace permission ${key}`).toBe(false);
      }
    }
  });
});
