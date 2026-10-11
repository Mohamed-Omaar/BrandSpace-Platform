/**
 * PR D (Shell 6) — the brand menu's allowance, as plain values: the
 * workspace's live brands and the plan's brand quota (`null` = no stated
 * ceiling). Read by `brand-allowance.ts`; pure, so the rules are unit-tested.
 */
export interface BrandAllowance {
  readonly used: number;
  readonly allowed: number | null;
}

/** "2/3", or "2" when the plan states no ceiling. */
export function brandUsage(allowance: BrandAllowance): string {
  return allowance.allowed === null
    ? String(allowance.used)
    : `${allowance.used}/${allowance.allowed}`;
}

/** Whether "+ Add a brand" can add one, or should say the plan's limit. */
export function mayAddBrand(allowance: BrandAllowance): boolean {
  return allowance.allowed === null || allowance.used < allowance.allowed;
}
