/**
 * WHO MAY SPEND AI CREDITS (Q18, D-315).
 *
 * Every action that spends credits needs its own feature permission — writing
 * a post needs `content.create`, a Brand Brain answer needs `brand_brain.chat`
 * — AND `copilot.use`. The feature key says the member may do the thing; the
 * second says the member may spend the workspace's credits doing it. A member
 * without `copilot.use` sees no credit-spending button and no credit balance.
 *
 * THIS IS NOT A SECOND PERMISSION PATH. It is the list of keys handed to the
 * one gate each surface already has (the API's `resolveCaller`, the
 * dashboard's session keys); nothing here decides anything on its own.
 *
 * WHAT IT DELIBERATELY DOES NOT COVER. Quotes spend nothing and stay on their
 * read keys. No worker, scheduler or automation path calls the AI gateway
 * today; an automation that one day does must add this key to its action's
 * permission, which the engine re-checks against the rule's creator at every
 * run.
 */
export const CREDIT_SPENDING_PERMISSION = 'copilot.use';

/** The keys a credit-spending action requires: its feature key and `copilot.use`. */
export function creditSpendingPermissions(featureKey: string): readonly string[] {
  return featureKey === CREDIT_SPENDING_PERMISSION
    ? [CREDIT_SPENDING_PERMISSION]
    : [featureKey, CREDIT_SPENDING_PERMISSION];
}

/** May a member holding `permissionKeys` start this credit-spending action? */
export function maySpendCredits(permissionKeys: readonly string[], featureKey: string): boolean {
  return creditSpendingPermissions(featureKey).every((key) => permissionKeys.includes(key));
}

/**
 * May this member see the credit balance? `credits.read` AND `copilot.use`
 * (Q18): the balance is shown to the people who spend it.
 */
export function mayReadCreditBalance(permissionKeys: readonly string[]): boolean {
  return (
    permissionKeys.includes('credits.read') && permissionKeys.includes(CREDIT_SPENDING_PERMISSION)
  );
}
