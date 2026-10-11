import { describe, expect, it } from 'vitest';
import { workspacesFoot } from '../../apps/dashboard/src/server/workspaces-foot';

/**
 * PR D (Auth 6) — the workspace list's foot follows the rail switcher's
 * allowance (D-326): a create row within it, a note at it, nothing otherwise.
 */
describe('the workspace list foot', () => {
  it('offers "Create workspace" with the usage when there is a ceiling', () => {
    expect(workspacesFoot({ kind: 'create', used: 1, allowed: 3 })).toEqual({
      kind: 'create',
      usage: '1/3',
    });
  });

  it('offers it without a usage when the allowance has no ceiling', () => {
    expect(workspacesFoot({ kind: 'create', used: 4, allowed: null })).toEqual({
      kind: 'create',
      usage: null,
    });
  });

  it('says the plan’s workspaces are all in use at the limit', () => {
    expect(workspacesFoot({ kind: 'limit', used: 2, allowed: 2 })).toEqual({
      kind: 'limit',
      used: 2,
      allowed: 2,
    });
  });

  it('shows nothing for a non-owner, a one-workspace plan or no allowance', () => {
    expect(workspacesFoot({ kind: 'none' })).toBeNull();
    expect(workspacesFoot({ kind: 'unavailable' })).toBeNull();
    expect(workspacesFoot(null)).toBeNull();
  });
});
