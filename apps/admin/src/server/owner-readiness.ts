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

export type ReadinessAreaKey =
  | 'ai'
  | 'email'
  | 'storage'
  | 'payment'
  | 'social'
  | 'plans'
  // PR F (e) — what a closed beta needs beyond the integrations.
  | 'scanner'
  | 'trial'
  | 'legal'
  | 'password'
  | 'sender'
  | 'postKinds'
  | 'industries';

/** The areas that are an integration provider, as opposed to a setting. */
export const INTEGRATION_AREA_KEYS: ReadonlySet<ReadinessAreaKey> = new Set([
  'ai',
  'email',
  'storage',
  'payment',
  'social',
  'scanner',
]);

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
  | 'withheld'
  /**
   * PR F (e) — acceptable for the closed beta by the owner's decision, NOT for
   * a public launch (scanning off, legal text awaiting review). Counted as
   * passing by the verdict, and said in so many words on the card.
   */
  | 'beta_only';

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
  | 'no_sellable_plan'
  // PR F (e)
  | 'ai_hidden'
  | 'social_hidden'
  | 'payments_off'
  | 'scanning_off'
  | 'scanner_mock'
  | 'scanner_scanii'
  | 'trial_missing'
  | 'trial_no_price'
  | 'trial_quota_unset'
  | 'trial_ok'
  | 'legal_missing'
  | 'legal_fixture'
  | 'legal_draft'
  | 'legal_reviewed'
  | 'password_short'
  | 'password_ok'
  | 'sender_missing'
  | 'sender_ok'
  | 'post_kinds_default'
  | 'post_kinds_ok'
  | 'industries_missing'
  | 'industries_ok';

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
  /**
   * PR F (e) — the facts behind the reason, in values rather than words
   * (a number of days, the quotas left unset, the sender's name). The card
   * fills them into its sentence; nothing here is translated.
   */
  readonly detail?: Readonly<Record<string, string>>;
}

type Derived = Pick<ReadinessArea, 'state' | 'reason' | 'provider' | 'detail'>;

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

/* ------------------------------------------------------------------------ */
/* PR F (e) — the closed beta's own rows                                     */
/* ------------------------------------------------------------------------ */

/**
 * AI and social, said for what they mean to a customer: while nothing is set
 * up, the controls that need them are hidden (Q8, Q9), not broken.
 */
export function withCustomerEffect(
  key: 'ai' | 'social',
  derived: Pick<ReadinessArea, 'state' | 'reason' | 'provider'>,
): Derived {
  if (derived.state !== 'setup_required' && derived.state !== 'disabled') return derived;
  return { ...derived, reason: key === 'ai' ? 'ai_hidden' : 'social_hidden' };
}

/** Payments switched off for the beta (Q6): not set up on purpose, not required. */
export function paymentsOffArea(): Derived {
  return { state: 'disabled', reason: 'payments_off', provider: null };
}

/** The malware scanner (`assets.scanning`), Q13. */
export function scannerAreaState(input: {
  readonly provider: string;
  readonly scaniiEndpoint: string | null;
  readonly production: boolean;
}): Derived {
  if (input.provider === 'none') {
    return { state: 'beta_only', reason: 'scanning_off', provider: null };
  }
  if (input.provider === 'scanii') {
    return input.scaniiEndpoint
      ? { state: 'ready', reason: 'scanner_scanii', provider: { en: 'Scanii', ar: 'Scanii' } }
      : {
          state: 'needs_attention',
          reason: 'incomplete',
          provider: { en: 'Scanii', ar: 'Scanii' },
        };
  }
  // `mock`: refused in production, where every upload would wait forever.
  return input.production
    ? { state: 'needs_attention', reason: 'scanner_mock', provider: null }
    : { state: 'test_double', reason: 'test_double', provider: null };
}

/** The quotas a trial plan must state; `null` on any of them means unlimited. */
const TRIAL_QUOTAS = [
  'seats',
  'brands',
  'workspaces',
  'socialAccounts',
  'scheduledPostsPerMonth',
  'storageGb',
  'analyticsRetentionDays',
] as const;

export interface TrialPlanInput {
  readonly key: string;
  readonly status: string;
  readonly tier: number;
  readonly trialDays: number;
  readonly trialCredits: number;
  readonly prices: readonly { readonly currency: string }[];
  readonly quotas: Readonly<Record<(typeof TRIAL_QUOTAS)[number], number | null>>;
}

/**
 * The trial a new workspace gets: the lowest-tier active plan with trial days
 * (the rule onboarding applies). It must have a price in the currency trials
 * are created in (the trial is otherwise skipped, Q6) and state every quota —
 * a `null` quota is "Unlimited", which the beta never means.
 */
export function trialAreaState(plans: readonly TrialPlanInput[], currency: string): Derived {
  const trial =
    [...plans]
      .filter((plan) => plan.status === 'active' && plan.trialDays > 0)
      .sort((a, b) => a.tier - b.tier)[0] ?? null;
  if (!trial) return { state: 'setup_required', reason: 'trial_missing', provider: null };
  const detail = {
    plan: trial.key,
    days: String(trial.trialDays),
    credits: String(trial.trialCredits),
    currency,
  };
  if (!trial.prices.some((price) => price.currency.toUpperCase() === currency.toUpperCase())) {
    return { state: 'needs_attention', reason: 'trial_no_price', provider: null, detail };
  }
  const unset = TRIAL_QUOTAS.filter((quota) => trial.quotas[quota] === null);
  if (unset.length > 0) {
    return {
      state: 'needs_attention',
      reason: 'trial_quota_unset',
      provider: null,
      detail: { ...detail, quotas: unset.join(', ') },
    };
  }
  return { state: 'ready', reason: 'trial_ok', provider: null, detail };
}

export interface LegalDocumentInput {
  readonly key: string;
  readonly version: string;
  readonly required: boolean;
  readonly reviewed: boolean;
}

/**
 * The documents sign-up asks a person to accept (Q11). A `fixture-` version
 * is test data and never ready; a draft not yet reviewed by a lawyer is fine
 * for the closed beta only; reviewed is ready.
 */
export function legalAreaState(documents: readonly LegalDocumentInput[]): Derived {
  const required = documents.filter((document) => document.required);
  if (required.length === 0)
    return { state: 'setup_required', reason: 'legal_missing', provider: null };
  const detail = { versions: [...new Set(required.map((d) => d.version))].join(', ') };
  if (required.some((document) => document.version.startsWith('fixture-'))) {
    return { state: 'needs_attention', reason: 'legal_fixture', provider: null, detail };
  }
  if (required.some((document) => !document.reviewed)) {
    return { state: 'beta_only', reason: 'legal_draft', provider: null, detail };
  }
  return { state: 'ready', reason: 'legal_reviewed', provider: null, detail };
}

/** The password floor sign-up enforces; 12 is the beta's value. */
export const BETA_MIN_PASSWORD_LENGTH = 12;

export function passwordAreaState(minPasswordLength: number): Derived {
  const detail = { length: String(minPasswordLength), wanted: String(BETA_MIN_PASSWORD_LENGTH) };
  return minPasswordLength >= BETA_MIN_PASSWORD_LENGTH
    ? { state: 'ready', reason: 'password_ok', provider: null, detail }
    : { state: 'needs_attention', reason: 'password_short', provider: null, detail };
}

/** The name every email is sent under (`integrations.email` → `fromName`). */
export function senderAreaState(fromName: string | null): Derived {
  const name = fromName?.trim() ?? '';
  return name
    ? { state: 'ready', reason: 'sender_ok', provider: null, detail: { name } }
    : { state: 'needs_attention', reason: 'sender_missing', provider: null };
}

/**
 * The post kinds each channel accepts (`publishing.providers.*.postKinds`).
 * With no activated publishing document every channel is on the schema's
 * single default kind, which is not a decision anybody made.
 */
export function postKindsAreaState(
  configured: boolean,
  providers: Readonly<Record<string, { readonly postKinds: readonly string[] }>>,
): Derived {
  const detail = {
    kinds: Object.entries(providers)
      .map(([key, provider]) => `${key}: ${provider.postKinds.join('/')}`)
      .join(' · '),
  };
  return configured
    ? { state: 'ready', reason: 'post_kinds_ok', provider: null, detail }
    : { state: 'needs_attention', reason: 'post_kinds_default', provider: null, detail };
}

/** The industries onboarding offers (`onboarding.industries`), Q12. */
export function industriesAreaState(count: number): Derived {
  return count > 0
    ? { state: 'ready', reason: 'industries_ok', provider: null, detail: { count: String(count) } }
    : { state: 'needs_attention', reason: 'industries_missing', provider: null };
}

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
  // PR F (e): `beta_only` passes — the owner accepted it for the closed beta.
  const remaining = required.filter(
    (area) => area.state !== 'ready' && area.state !== 'withheld' && area.state !== 'beta_only',
  ).length;
  if (remaining > 0) return { status: 'not_ready', remaining };
  if (required.some((area) => area.state === 'withheld')) return { status: 'unknown', remaining };
  return { status: 'ready', remaining: 0 };
}

/** The Simple-mode integration route for a category: its guided setup. */
export function areaHref(key: ReadinessAreaKey): string {
  if (key === 'plans' || key === 'trial') return '/plans';
  if (key === 'ai') return '/ai';
  if (key === 'scanner') return '/configuration?domain=assets';
  if (key === 'legal' || key === 'password' || key === 'industries') {
    return '/configuration?domain=onboarding';
  }
  if (key === 'sender') return '/integrations?category=email';
  if (key === 'postKinds') return '/configuration?domain=publishing';
  return `/integrations?category=${key}`;
}
