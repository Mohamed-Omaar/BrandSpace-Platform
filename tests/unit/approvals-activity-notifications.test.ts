import { describe, expect, it } from 'vitest';
import { resolveActivityScope } from '@brandspace/activity';
import { mayApproveForBrand } from '@brandspace/content';
import { NOTIFICATION_TEMPLATE_KEYS, NOTIFICATION_TEMPLATES } from '@brandspace/notifications';
import { CONFIG_DOMAINS, defaultPayload, parseConfigPayload } from '@brandspace/config';
import { ROLE_DEFINITIONS, WORKSPACE_PERMISSIONS, brandInScope } from '@brandspace/shared';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * Phase 5B-3's pure logic, measured without a database.
 *
 * WHAT IS WORTH TESTING HERE is the part a reader of the code has to take on
 * trust otherwise: that the activity grades in docs/SECURITY.md §4.3 are the
 * grades the resolver produces, that the roles carry exactly the keys the matrix
 * gives them, that the configuration defaults are what D-62 and D-122 say, and
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

describe('who may approve — D-62: the permission, and nothing else', () => {
  it('the permission alone is enough', () => {
    for (const role of ['workspace_owner', 'workspace_admin', 'marketing_manager', 'approver']) {
      expect(
        mayApproveForBrand({ permissionKeys: perms(role) }),
        `${role} holds content.approve per docs/SECURITY.md §4.3`,
      ).toBe(true);
    }
  });

  it('the roles the matrix marks ➖ cannot approve', () => {
    for (const role of ['content_creator', 'copywriter', 'designer', 'analyst']) {
      expect(
        mayApproveForBrand({ permissionKeys: perms(role) }),
        `${role} is marked ➖ for Approve / reject`,
      ).toBe(false);
    }
  });

  it('THE VIEWER CANNOT APPROVE, AND NOTHING CAN LIFT IT', () => {
    /*
     * D-62 supersedes D-121. There was a per-brand switch that admitted
     * `client_viewer` as a reviewer; the MVP has no Client Portal, no client
     * hand-off and no external reviewer surface for it to belong to, so the
     * Viewer is strictly read-only and the switch is gone.
     *
     * THE STRONGEST FORM THIS ASSERTION CAN TAKE is that there is no argument
     * to pass. `mayApproveForBrand` no longer accepts a role key or a policy,
     * so a brand setting has no channel through which to reach it — which is
     * why this test cannot be written as "and false when the switch is off".
     */
    expect(mayApproveForBrand({ permissionKeys: perms('client_viewer') })).toBe(false);

    // Nor by any combination of permissions the Viewer actually holds.
    for (const key of perms('client_viewer')) {
      expect(mayApproveForBrand({ permissionKeys: [key] }), `${key} must not approve`).toBe(false);
    }

    // `content.approve` is the ONLY key that opens it.
    expect(mayApproveForBrand({ permissionKeys: ['content.approve'] })).toBe(true);
  });

  it('THE VIEWER ROLE IS EXACTLY `workspace.read` + `content.read` — D-58, D-62, Q12 (D-323)', () => {
    /*
     * Pinned exactly, not merely "does not contain content.approve": the point
     * of D-62 is that Viewer is READ-ONLY, so any addition to this list is a
     * decision somebody has to make deliberately and this test has to be
     * edited to record. Q12's second release (D-323) is that decision:
     * `content.read`, so the Viewer reads content and approvals — and still
     * approves nothing.
     */
    expect(perms('client_viewer')).toEqual(['workspace.read', 'content.read']);
    expect(perms('client_viewer')).not.toContain('content.approve');
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

  it('D-62 — Viewer approval is not merely off by default, it cannot be on', () => {
    /*
     * The schema pins it: `z.literal(false)`. A configuration version that
     * tried to activate the reserved field is REFUSED at validation rather
     * than activated and quietly ignored — which is what "inert" has to mean
     * for it to be worth anything.
     */
    expect(payload.approvals.clientApprovalEnabled).toBe(false);
    const withGrant = {
      ...payload,
      approvals: { ...payload.approvals, clientApprovalEnabled: true },
    };
    expect(() => parseConfigPayload('content', withGrant)).toThrow();
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
        // B-3 — an edit withdrew the review the reviewer was asked for.
        'approval.withdrawn_after_edit',
        // Phase 6 — Social Publishing. Three, not one per state: a queued post
        // becoming a publishing post is not news, and notifying on every
        // transition is how an inbox stops being read.
        'publishing.connection_needs_reauth',
        'publishing.failed',
        'publishing.published',
        /*
         * Phase 7 — Analytics & Copilot. Three, and each one exists because
         * somebody has to DO something:
         *
         *   - an anomaly is a finding a person should look at,
         *   - an automation waiting on a human confirmation is blocked until
         *     one arrives, and an unnoticed confirmation request is an
         *     automation that silently never ran,
         *   - an automation blocked by authorization means a rule somebody
         *     wrote has stopped working and nothing else would say so.
         *
         * There is deliberately NO "analytics refreshed" template: a successful
         * routine pull is not news, and notifying on it is how an inbox stops
         * being read.
         */
        'analytics.anomaly_detected',
        'automation.blocked',
        'automation.confirmation_required',
        'brand_brain.learning_proposed',
        /*
         * Phase 6 (P6-12) — what a NOTIFY rule sends. It used to reuse
         * `automation.confirmation_required`, so a plain "tell me when content
         * is approved" rule announced that something was waiting for a
         * confirmation. The one notice that must never cry wolf now has the
         * template to itself.
         */
        'automation.notice',
        /*
         * Prototype v94 Phase 2B-1, A8 (D-328) — the owner's deletion request.
         * The members lose access while it waits, and are owed the reason and
         * the date; and they are told again if it is taken back.
         */
        'workspace.deletion_cancelled',
        'workspace.deletion_requested',
        /*
         * Prototype v94 Phase 2B-1, G5 / Q22 (D-334) — a time-zone change left
         * a post's local time in the past, so it went back to planned. Its
         * author has to choose a new time, and nothing else would say so.
         */
        'calendar.unplanned_by_timezone_change',
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
