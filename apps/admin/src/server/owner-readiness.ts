import type { IntegrationView } from '@brandspace/integrations';

/**
 * IS BRANDSPACE READY FOR CUSTOMERS? — derived, never stored (D-311).
 *
 * The owner's first-run setup is not a checklist somebody ticks. Every answer
 * here is computed from the platform's actual state on each request: the
 * integration views the Integrations Hub already builds (active configuration
 * version, masked credential presence, the newest connection check) and the
 * ACTIVE `plans` version. Visiting a form completes nothing; saving a key
 * completes nothing until the connection has been tested and the provider
 * activated.
 *
 * PURE. No database, no framework: the data is loaded by the caller and the
 * decisions are made here, so every branch is unit-tested.
 */

export type ReadinessAreaKey = 'ai' | 'email' | 'storage' | 'payment' | 'social' | 'plans';

export type AreaState =
  /** Real, active, complete and its last connection check passed. */
  | 'ready'
  /** Active and working, but a development stand-in — never for real customers. */
  | 'test_double'
  /** Something is switched on and is not working as it should. */
  | 'needs_attention'
  /** Nothing is set up. */
  | 'setup_required'
  /** It was set up and has been switched off. */
  | 'disabled'
  /** The reader's role may not see this — said, never guessed. */
  | 'withheld';

export type AreaReason =
  | 'ok'
  | 'test_double'
  | 'refused'
  | 'incomplete'
  | 'failed'
  | 'untested'
  | 'none_active'
  | 'switched_off'
  | 'no_permission'
  | 'no_sellable_plan';

export interface ReadinessArea {
  readonly key: ReadinessAreaKey;
  /** Required before real customers can be served (the registry's own flag). */
  readonly required: boolean;
  readonly state: AreaState;
  readonly reason: AreaReason;
  /** The provider doing the work, when one is active. */
  readonly provider: { readonly en: string; readonly ar: string } | null;
  /** Where the owner fixes it — a path after `/console`. */
  readonly href: string;
}

/**
 * One integration category's state, from the Hub's own views.
 *
 * ORDER MATTERS and is the point: a provider that cannot be selected in this
 * environment is a problem before anything else; an incomplete one before an
 * untested one; and "Connected" is said only after a real check passed — a
 * saved key that nobody has tested is not a connection (§23 of the contract).
 */
export function integrationAreaState(
  views: readonly IntegrationView[],
): Pick<ReadinessArea, 'state' | 'reason' | 'provider'> {
  const active = views.filter((view) => view.enabled);
  if (active.length === 0) {
    const wasSetUp = views.some(
      (view) =>
        view.credentials.some((credential) => credential.present) ||
        Object.values(view.settings).some((value) => value.trim() !== ''),
    );
    return wasSetUp
      ? { state: 'disabled', reason: 'switched_off', provider: null }
      : { state: 'setup_required', reason: 'none_active', provider: null };
  }

  // A real provider speaks for the category ahead of a stand-in, and a
  // selectable one ahead of a refused one.
  const ranked = [...active].sort((a, b) => rank(a) - rank(b));
  const lead = ranked[0] as IntegrationView;
  const provider = { en: lead.displayNameEn, ar: lead.displayNameAr };

  if (lead.selectionRefusal !== null)
    return { state: 'needs_attention', reason: 'refused', provider };
  if (!lead.configurationComplete) {
    return { state: 'needs_attention', reason: 'incomplete', provider };
  }
  if (lead.connection === 'failed') return { state: 'needs_attention', reason: 'failed', provider };
  if (lead.developmentOnly) return { state: 'test_double', reason: 'test_double', provider };
  if (lead.connection !== 'ok') return { state: 'needs_attention', reason: 'untested', provider };
  return { state: 'ready', reason: 'ok', provider };
}

function rank(view: IntegrationView): number {
  return (view.selectionRefusal === null ? 0 : 2) + (view.developmentOnly ? 1 : 0);
}

/** The shape of a plan this module needs — a subset of `PlanDetail`. */
export interface SellablePlanInput {
  readonly status: string;
  readonly visibility: string;
  readonly prices: readonly unknown[];
}

/** A plan can be sold when it is active, public and priced in some currency. */
export function isSellable(plan: SellablePlanInput): boolean {
  return plan.status === 'active' && plan.visibility === 'public' && plan.prices.length > 0;
}

export function plansAreaState(
  plans: readonly SellablePlanInput[],
): Pick<ReadinessArea, 'state' | 'reason' | 'provider'> {
  return plans.some(isSellable)
    ? { state: 'ready', reason: 'ok', provider: null }
    : { state: 'setup_required', reason: 'no_sellable_plan', provider: null };
}

export const WITHHELD: Pick<ReadinessArea, 'state' | 'reason' | 'provider'> = {
  state: 'withheld',
  reason: 'no_permission',
  provider: null,
};

/**
 * The verdict: ready only when every REQUIRED area is `ready`. A stand-in is
 * not ready for real customers however well it works, and a withheld area is
 * not assumed fine — the verdict is then `unknown` rather than a guess.
 */
export function readinessVerdict(areas: readonly ReadinessArea[]): {
  readonly status: 'ready' | 'not_ready' | 'unknown';
  readonly remaining: number;
} {
  const required = areas.filter((area) => area.required);
  const remaining = required.filter(
    (area) => area.state !== 'ready' && area.state !== 'withheld',
  ).length;
  if (remaining > 0) return { status: 'not_ready', remaining };
  if (required.some((area) => area.state === 'withheld')) return { status: 'unknown', remaining };
  return { status: 'ready', remaining: 0 };
}

/** The Simple-mode integration route for a category: its guided setup. */
export function areaHref(key: ReadinessAreaKey): string {
  if (key === 'plans') return '/plans';
  if (key === 'ai') return '/ai';
  return `/integrations?category=${key}`;
}
