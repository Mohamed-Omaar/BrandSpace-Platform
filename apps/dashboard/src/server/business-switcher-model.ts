import type { WorkspaceAllowance } from '@brandspace/entitlements';

/**
 * WHAT THE BUSINESS SWITCHER OFFERS AT ITS FOOT (Q1, D-326) — a pure decision,
 * so the unit suite pins it rather than a screenshot.
 *
 *   - NOT AN OWNER (owns no workspace): nothing — only an owner creates one.
 *   - A PLAN THAT ALLOWS ONLY ONE: nothing at all, not even the usage (Q1: "on a
 *     plan that allows only 1 the option is not shown at all").
 *   - BELOW THE ALLOWANCE: the usage "used / allowed" and "+ New workspace".
 *   - AT OR OVER IT: the usage and an upgrade message instead.
 *
 * The same `WorkspaceAllowance` the server enforces in
 * `WorkspaceOnboardingService.create`, so the screen can never offer a
 * workspace the server would refuse, nor hide one it would allow.
 */
export type SwitcherFoot =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'create' | 'limit';
      readonly used: number;
      /** Null is unlimited. */
      readonly allowed: number | null;
    };

export function switcherFoot(allowance: WorkspaceAllowance): SwitcherFoot {
  if (allowance.used === 0) return { kind: 'none' };
  if (allowance.allowed === 1) return { kind: 'none' };
  return {
    kind: allowance.canCreate ? 'create' : 'limit',
    used: allowance.used,
    allowed: allowance.allowed,
  };
}
