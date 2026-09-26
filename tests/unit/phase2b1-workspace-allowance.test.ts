import { describe, expect, it } from 'vitest';
import {
  readPlanCatalogue,
  workspaceAllowance,
  type OwnedWorkspaceFact,
} from '@brandspace/entitlements';

/**
 * Q1 / A2 / G7 (D-326) — THE WORKSPACE ALLOWANCE, AS A PURE RULE.
 *
 * Every number here is a FIXTURE plan written by the test, standing in for
 * configuration an owner activates in the Control Center (AC-04.3).
 */

const plans = readPlanCatalogue({
  plans: [
    { key: 'one', tier: 1, quotas: { workspaces: 1 } },
    { key: 'two', tier: 2, quotas: { workspaces: 2 } },
    { key: 'five', tier: 3, quotas: { workspaces: 5 } },
    { key: 'open', tier: 4, quotas: { workspaces: null } },
  ],
});

let counter = 0;
function owned(
  planKey: string | null,
  subscriptionStatus: string | null,
  extra: Partial<OwnedWorkspaceFact> = {},
): OwnedWorkspaceFact {
  counter += 1;
  return {
    workspaceId: `ws-${counter}`,
    status: 'ACTIVE',
    deletedAt: null,
    planKey,
    subscriptionStatus,
    ...extra,
  };
}

describe('Q1 · the workspace allowance', () => {
  it('lets anyone create their first workspace', () => {
    expect(workspaceAllowance([], plans)).toEqual({ used: 0, allowed: 0, canCreate: true });
  });

  it('is the highest workspaces quota among the plans the owner is on', () => {
    const result = workspaceAllowance([owned('one', 'ACTIVE'), owned('two', 'ACTIVE')], plans);
    expect(result).toEqual({ used: 2, allowed: 2, canCreate: false });
    expect(workspaceAllowance([owned('two', 'PAST_DUE')], plans)).toEqual({
      used: 1,
      allowed: 2,
      canCreate: true,
    });
  });

  it('a plan with no stated quota is unlimited, like every other quota', () => {
    expect(workspaceAllowance([owned('open', 'ACTIVE'), owned('one', 'ACTIVE')], plans)).toEqual({
      used: 2,
      allowed: null,
      canCreate: true,
    });
  });

  it('a CANCELLED or EXPIRED subscription contributes nothing', () => {
    expect(workspaceAllowance([owned('five', 'CANCELLED')], plans)).toMatchObject({
      allowed: 0,
      canCreate: false,
    });
    expect(workspaceAllowance([owned('five', 'EXPIRED'), owned('two', 'ACTIVE')], plans)).toEqual({
      used: 2,
      allowed: 2,
      canCreate: false,
    });
  });

  it('a TRIALING plan counts only while the owner has no ACTIVE or PAST_DUE workspace (G7)', () => {
    // Trial only: the trial plan is the allowance.
    expect(workspaceAllowance([owned('five', 'TRIALING')], plans)).toMatchObject({ allowed: 5 });
    // A paid workspace exists: the trial of a new workspace never raises it.
    expect(workspaceAllowance([owned('two', 'ACTIVE'), owned('five', 'TRIALING')], plans)).toEqual({
      used: 2,
      allowed: 2,
      canCreate: false,
    });
  });

  /*
   * OWNER DECISION (PR #47 review item 1, amends D-326): a workspace with no
   * plan and no subscription contributes NOTHING. It never grants Unlimited.
   */
  it('an owner whose only workspace has no plan cannot create a second one', () => {
    expect(workspaceAllowance([owned(null, null)], plans)).toEqual({
      used: 1,
      allowed: 0,
      canCreate: false,
    });
  });

  it('a plan-less workspace adds no allowance, with or without a subscription row', () => {
    expect(workspaceAllowance([owned(null, null), owned(null, null)], plans)).toEqual({
      used: 2,
      allowed: 0,
      canCreate: false,
    });
    expect(workspaceAllowance([owned(null, 'ACTIVE')], plans)).toMatchObject({
      allowed: 0,
      canCreate: false,
    });
    // A plan key the active catalogue no longer contains contributes nothing.
    expect(workspaceAllowance([owned('retired', 'ACTIVE')], plans)).toMatchObject({
      allowed: 0,
      canCreate: false,
    });
  });

  it('with a valid planned workspace, only its plan contributes; plan-less ones still count as used', () => {
    expect(
      workspaceAllowance([owned('five', 'ACTIVE'), owned(null, null), owned(null, null)], plans),
    ).toEqual({ used: 3, allowed: 5, canCreate: true });
    expect(workspaceAllowance([owned('two', 'ACTIVE'), owned(null, null)], plans)).toEqual({
      used: 2,
      allowed: 2,
      canCreate: false,
    });
  });

  it('a plan-less workspace pending deletion still counts until it is DELETED', () => {
    const pending = owned(null, null);
    expect(workspaceAllowance([owned('two', 'ACTIVE'), pending], plans)).toEqual({
      used: 2,
      allowed: 2,
      canCreate: false,
    });
    const gone = owned(null, null, { deletedAt: new Date(), status: 'DELETED' });
    expect(workspaceAllowance([owned('two', 'ACTIVE'), gone], plans)).toEqual({
      used: 1,
      allowed: 2,
      canCreate: true,
    });
  });

  it('counts a workspace pending deletion until it is DELETED', () => {
    const pending = owned('two', 'ACTIVE');
    expect(workspaceAllowance([pending, owned('one', 'ACTIVE')], plans)).toMatchObject({
      used: 2,
      canCreate: false,
    });
    const gone = owned('two', 'ACTIVE', { deletedAt: new Date(), status: 'DELETED' });
    expect(workspaceAllowance([gone, owned('two', 'ACTIVE')], plans)).toEqual({
      used: 1,
      allowed: 2,
      canCreate: true,
    });
    const statusOnly = owned('two', 'ACTIVE', { status: 'DELETED' });
    expect(workspaceAllowance([statusOnly], plans).used).toBe(0);
  });
});
