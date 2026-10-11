import type { SwitcherFoot } from './business-switcher-model';

/**
 * PR D (Auth 6) — WHAT THE WORKSPACE LIST SHOWS UNDER ITS ROWS, from the same
 * allowance the rail's switcher shows and the server enforces (D-326):
 *
 *   - within the allowance: "Create workspace", with "used/allowed" when there
 *     is a ceiling (`Auth.dc.html` line 106, `wl.can`);
 *   - at it: the note that the plan's workspaces are all in use (`wl.full`) —
 *     never an upgrade prompt, since payments are off for the beta (Q6);
 *   - otherwise (not an owner, a one-workspace plan, no allowance): nothing.
 */
export type WorkspacesFoot =
  | { readonly kind: 'create'; readonly usage: string | null }
  | { readonly kind: 'limit'; readonly used: number; readonly allowed: number }
  | null;

export function workspacesFoot(foot: SwitcherFoot | null): WorkspacesFoot {
  if (!foot) return null;
  if (foot.kind === 'create') {
    return { kind: 'create', usage: foot.allowed === null ? null : `${foot.used}/${foot.allowed}` };
  }
  if (foot.kind === 'limit') {
    return { kind: 'limit', used: foot.used, allowed: foot.allowed ?? foot.used };
  }
  return null;
}
