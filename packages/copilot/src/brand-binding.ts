import { brandInScope } from '@brandspace/shared';

/**
 * A BRAND-SCOPED STEP MAY NAME EXACTLY ONE BRAND: THE CONVERSATION'S.
 *
 * THE DEFECT THIS FILE CLOSES (A2). A session is admitted against one brand
 * (P7-R1), and every step was then checked only for "is this brand somewhere in
 * the caller's BrandScope?". For the ordinary customer — a founder with two
 * brands, an in-house team that manages both — the answer for the OTHER brand is
 * YES. So a model that misread "post about the launch" while sitting in Brand A's
 * conversation could put the draft on Brand B, and every check in the platform
 * would agree it was allowed.
 *
 * That is not a tenancy leak: the caller genuinely holds both brands. It is
 * worse in a quieter way — the assistant acting on the wrong brand while the
 * screen, the history and the audit trail all say Brand A. Nobody reviews an
 * action that looks authorized.
 *
 * SO SCOPE IS NECESSARY AND NOT SUFFICIENT. The rule is an equality against the
 * session's own brand, and the live scope is asked as well, because the two
 * answer different questions: WHICH brand this conversation is about, and
 * whether this person may still touch it at all. A narrowed BrandScope must stop
 * a plan built before the narrowing, and an equality alone would not.
 *
 * A GENERAL SESSION FAILS CLOSED. When a session is bound to no brand there is
 * no brand a step may name, so every brand-scoped tool is unavailable — the
 * orchestrator does not offer them to the model, and this refuses them if one
 * arrives anyway. The alternative — letting an unbound conversation pick a brand
 * out of the caller's scope — is exactly the "the assistant acted on the wrong
 * brand" failure with no conversation context to even argue about afterwards.
 */
export function stepBrandPermitted(input: {
  /** The brand the SESSION (and therefore the plan) is bound to. */
  readonly sessionBrandId: string | null;
  /** The brand the step's own arguments name. */
  readonly stepBrandId: string;
  /** The caller's LIVE scope, re-read at this moment. */
  readonly brandScope: readonly string[];
}): boolean {
  if (!input.sessionBrandId) return false;
  if (!input.stepBrandId) return false;
  if (input.stepBrandId !== input.sessionBrandId) return false;
  return brandInScope(input.brandScope, input.stepBrandId);
}
