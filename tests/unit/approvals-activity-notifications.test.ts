import { describe, expect, it } from 'vitest';
import { resolveActivityScope } from '@brandspace/activity';
import { mayApproveForBrand } from '@brandspace/content';
import { NOTIFICATION_TEMPLATE_KEYS, NOTIFICATION_TEMPLATES } from '@brandspace/notifications';
import { CONFIG_DOMAINS, defaultPayload } from '@brandspace/config';
import { ROLE_DEFINITIONS, WORKSPACE_PERMISSIONS, brandInScope } from '@brandspace/shared';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * Phase 5B-3's pure logic, measured without a database.
 *
 * WHAT IS WORTH TESTING HERE is the part a reader of the code has to take on
 * trust otherwise: that the activity grades in docs/SECURITY.md §4.3 are the
 * grades the resolver produces, that the roles carry exactly the keys the matrix
 * gives them, that the configuration defaults are what D-121 and D-122 say, and
 * that no notification can be produced that the dashboard cannot render in both
 * languages.
 */

const perms = (role: string): readonly string[] =>
  ROLE_DEFINITIONS.find((r) => r.key === role)?.permissionKeys ?? [];

describe('the activity-log scope resolver (docs/SECURITY.md §4.3)', () => {
  /*
   * PHASE 5B-3 GRADES `audit.read` RATHER THAN REPLACING IT. The key has existed
   * since Phase 1 and already carried the ✅ and 🟡-brand rows; the milestone
   * adds `audit.read_workspace` above it and `audit.read_own` below it.
   */
  const viewer = { userId: 'u1', brandScope: ['b1', 'b2'] };

  it('grades the Owner and the Admin as WORKSPACE-wide', () => {
    for (const role of ['workspace_owner', 'workspace_admin']) {
      expect(
        resolveActivityScope({ ...viewer, permissionKeys: perms(role) }).kind,
        `${role} should see the whole workspace`,
      ).toBe('workspace');
    }
  });

  it('grades the Marketing Manager and the Analyst as BRAND-scoped', () => {
    for (const role of ['marketing_manager', 'analyst']) {
      const scope = resolveActivityScope({ ...viewer, permissionKeys: perms(role) });
      expect(scope.kind, `${role} should be brand-scoped`).toBe('brand');
      if (scope.kind === 'brand') expect(scope.brandIds).toEqual(['b1', 'b2']);
    }
  });

  it('grades the creator roles and the Approver as OWN', () => {
    for (const role of ['content_creator', 'copywriter', 'designer', 'approver']) {
      const scope = resolveActivityScope({ ...viewer, permissionKeys: perms(role) });
      expect(scope.kind, `${role} should see only its own actions`).toBe('own');
      if (scope.kind === 'own') expect(scope.userId).toBe('u1');
    }
  });

  it('grades the Viewer (read-only) as NONE', () => {
    expect(resolveActivityScope({ ...viewer, permissionKeys: perms('client_viewer') }).kind).toBe(
      'none',
    );
  });

  it('MOST PRIVILEGED WINS where a role somehow holds more than one key', () => {
    expect(
      resolveActivityScope({
        ...viewer,
        permissionKeys: ['audit.read_own', 'audit.read', 'audit.read_workspace'],
      }).kind,
    ).toBe('workspace');
    expect(
      resolveActivityScope({
        ...viewer,
        permissionKeys: ['audit.read_own', 'audit.read'],
      }).kind,
    ).toBe('brand');
  });

  it('an EMPTY brandScope is UNRESTRICTED — the platform rule, not a local one', () => {
    /*
     * THIS TEST PREVIOUSLY ASSERTED THE OPPOSITE, and was wrong.
     *
     * `brandInScope()` and `brandScopeFilter()` have meant the same thing since
     * Phase 2B: a membership listing no brands is scoped to ALL of the
     * workspace's brands, and a membership listing brands is scoped to those.
     * Reading an empty list as "no brands" failed closed — but wrongly, and out
     * of step with every other reader of the same field, so an unrestricted
     * Marketing Manager or Analyst would have seen an empty activity log.
     *
     * `brandIds: null` is that case, stated in the type so a consumer cannot
     * quietly treat it as an empty `IN ()`.
     */
    const scope = resolveActivityScope({
      userId: 'u1',
      brandScope: [],
      permissionKeys: ['audit.read'],
    });
    expect(scope.kind).toBe('brand');
    if (scope.kind === 'brand') expect(scope.brandIds).toBeNull();
  });

  it('a RESTRICTED scope carries its brands, so the rule is not "always unrestricted"', () => {
    const scope = resolveActivityScope({
      userId: 'u1',
      brandScope: ['b1'],
      permissionKeys: ['audit.read'],
    });
    expect(scope.kind).toBe('brand');
    if (scope.kind === 'brand') expect(scope.brandIds).toEqual(['b1']);
  });

  it('agrees with `brandInScope()` about what an empty scope means', () => {
    // The two must not drift: one rule, asserted against the other.
    expect(brandInScope([], 'any-brand')).toBe(true);
    const scope = resolveActivityScope({
      userId: 'u1',
      brandScope: [],
      permissionKeys: ['audit.read'],
    });
    expect(scope.kind === 'brand' && scope.brandIds === null).toBe(true);
  });
});

describe('who may approve (D-121, resolving U-06)', () => {
  const off = {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
  };

  it('the permission alone is enough, whatever the brand says', () => {
    for (const role of ['workspace_owner', 'workspace_admin', 'marketing_manager', 'approver']) {
      expect(
        mayApproveForBrand({ roleKey: role, permissionKeys: perms(role), policy: off }),
        `${role} holds content.approve per docs/SECURITY.md §4.3`,
      ).toBe(true);
    }
  });

  it('the roles the matrix marks ➖ cannot approve', () => {
    for (const role of ['content_creator', 'copywriter', 'designer', 'analyst']) {
      expect(
        mayApproveForBrand({ roleKey: role, permissionKeys: perms(role), policy: off }),
        `${role} is marked ➖ for Approve / reject`,
      ).toBe(false);
    }
  });

  it('the Viewer is lifted ONLY by the brand switch, and only for that brand', () => {
    const viewerKeys = perms('client_viewer');
    expect(
      mayApproveForBrand({ roleKey: 'client_viewer', permissionKeys: viewerKeys, policy: off }),
    ).toBe(false);
    expect(
      mayApproveForBrand({
        roleKey: 'client_viewer',
        permissionKeys: viewerKeys,
        policy: { ...off, clientApprovalEnabled: true },
      }),
    ).toBe(true);
  });

  it('THE VIEWER ROLE ITSELF IS NOT WIDENED — D-58 and D-121 together', () => {
    /*
     * The whole reason the grant lives in the brand's policy rather than in the
     * permission bag: `client_viewer` still holds `workspace.read` and nothing
     * else, so no Viewer anywhere else gains anything.
     */
    expect(perms('client_viewer')).toEqual(['workspace.read']);
  });
});

describe('the approval role assignments match docs/SECURITY.md §4.3', () => {
  it('"Approve / reject" ✅ is exactly four roles, plus the Viewer by policy', () => {
    const approvers = ROLE_DEFINITIONS.filter(
      (r) => r.realm === 'workspace' && r.permissionKeys.includes('content.approve'),
    ).map((r) => r.key);
    expect(approvers.sort()).toEqual(
      ['approver', 'marketing_manager', 'workspace_admin', 'workspace_owner'].sort(),
    );
  });

  it('the Approver reviews but does not AUTHOR', () => {
    const approver = perms('approver');
    expect(approver).toContain('content.approve');
    expect(approver).not.toContain('content.edit');
    expect(approver).not.toContain('content.create');
    expect(approver).not.toContain('content.submit');
  });

  it('a role that can APPROVE cannot also change the policy that governs approving', () => {
    /*
     * The escalation this separation prevents: `approvals.policy.manage` can
     * turn self-approval ON, so a role holding both could grant itself the right
     * to approve its own work. Only the Owner and the Admin hold the switch.
     */
    const policyManagers = ROLE_DEFINITIONS.filter(
      (r) => r.realm === 'workspace' && r.permissionKeys.includes('approvals.policy.manage'),
    ).map((r) => r.key);
    expect(policyManagers.sort()).toEqual(['workspace_admin', 'workspace_owner']);
    expect(perms('marketing_manager')).toContain('content.approve');
    expect(perms('marketing_manager')).not.toContain('approvals.policy.manage');
  });

  it('every new permission is declared in the catalogue', () => {
    const declared = new Set(WORKSPACE_PERMISSIONS.map((p) => p.key));
    for (const key of [
      'content.approve',
      'approvals.policy.manage',
      'audit.read_own',
      'audit.read_workspace',
    ]) {
      expect(declared.has(key), `${key} must be declared`).toBe(true);
    }
  });
});

describe('the approvals configuration defaults', () => {
  const payload = defaultPayload('content') as {
    approvals: {
      requireApprovalBeforeScheduling: boolean;
      allowSelfApproval: boolean;
      clientApprovalEnabled: boolean;
      maxNoteLength: number;
      maxCyclesPerItem: number;
    };
  };

  it('D-122 — self-approval is DENIED by default', () => {
    expect(payload.approvals.allowSelfApproval).toBe(false);
  });

  it('D-121 — Viewer approval is OFF by default', () => {
    expect(payload.approvals.clientApprovalEnabled).toBe(false);
  });

  it('the platform-wide gate stays OFF, so no existing workspace is stranded', () => {
    expect(payload.approvals.requireApprovalBeforeScheduling).toBe(false);
  });

  it('the bounds are configuration, not literals in the service', () => {
    expect(payload.approvals.maxNoteLength).toBeGreaterThan(0);
    expect(payload.approvals.maxCyclesPerItem).toBeGreaterThan(0);
    expect(CONFIG_DOMAINS).toHaveProperty('content');
  });
});

describe('the notification catalogue is closed and fully translated', () => {
  it('declares only the events this milestone produces', () => {
    expect(NOTIFICATION_TEMPLATE_KEYS.sort()).toEqual(
      [
        'approval.approved',
        'approval.changes_requested',
        'approval.rejected',
        'approval.requested',
      ].sort(),
    );
  });

  it('EVERY template has both an Arabic and an English string', () => {
    /*
     * The row stores a KEY and the reader's locale picks the sentence, so a
     * template with no string in one language would render as its own key to
     * half the workspace. CLAUDE.md §6 point 5, enforced rather than reviewed.
     */
    for (const key of NOTIFICATION_TEMPLATE_KEYS) {
      const messageKey = `notifications.template.${key}` as keyof typeof messages.en;
      expect(messages.en[messageKey], `${key} needs an English string`).toBeTruthy();
      expect(messages.ar[messageKey], `${key} needs an Arabic string`).toBeTruthy();
      expect(messages.ar[messageKey]).not.toBe(messages.en[messageKey]);
    }
  });

  it('no template carries body text, only a severity', () => {
    for (const key of NOTIFICATION_TEMPLATE_KEYS) {
      expect(Object.keys(NOTIFICATION_TEMPLATES[key])).toEqual(['severity']);
    }
  });
});

describe('every Phase 5B-3 string exists in BOTH languages', () => {
  it('has no Arabic key missing from English, or the reverse', () => {
    const arKeys = Object.keys(messages.ar);
    const enKeys = Object.keys(messages.en);
    expect(arKeys.filter((k) => !enKeys.includes(k))).toEqual([]);
    expect(enKeys.filter((k) => !arKeys.includes(k))).toEqual([]);
  });

  it('translates the new screens, rather than falling back to the key', () => {
    const prefixes = ['approvals.', 'activity.', 'notifications.', 'nav.approvals'];
    const keys = Object.keys(messages.en).filter((k) => prefixes.some((p) => k.startsWith(p)));
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) {
      const typed = key as keyof typeof messages.en;
      expect(messages.en[typed], `${key} EN`).toBeTruthy();
      expect(messages.ar[typed], `${key} AR`).toBeTruthy();
      // An Arabic "translation" identical to the English one is an untranslated
      // string wearing a key, except where the term is genuinely shared.
      if (!/^[A-Z_.]+$/.test(messages.en[typed])) {
        expect(messages.ar[typed], `${key} looks untranslated`).not.toBe(messages.en[typed]);
      }
    }
  });
});
