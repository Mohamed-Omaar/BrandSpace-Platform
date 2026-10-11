/**
 * PR D (Shell 6) — the brand menu's allowance, as plain values: the
 * workspace's live brands, the plan's brand quota (`null` = no stated
 * ceiling) and whether several brands are on at all (the multi-brand
 * feature, D-327). Read by `brand-allowance.ts`; pure, so the rules are
 * unit-tested.
 */
export interface BrandAllowance {
  readonly used: number;
  readonly allowed: number | null;
  /** The D-327 feature; absent means not read, and is taken as off. */
  readonly multiBrand?: boolean | undefined;
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

/**
 * THE BETA'S ONE BRAND (D-501). A workspace allowed one brand that holds it:
 * the rail shows the brand as a plain label, and nothing anywhere offers to
 * add another. The allowance is configuration (Control Center → Plans), so
 * raising it brings the menu back with no release.
 */
export function isSingleBrand(allowance: BrandAllowance): boolean {
  return allowance.allowed === 1 && allowance.used <= 1;
}

/**
 * Whether a workspace with one brand may grow to more: the rail's card is then
 * the brand menu, with "Brands · used/allowed" and "+ Add a brand". Both the
 * multi-brand feature and an allowance above one are needed — the same two
 * the server asks before creating a brand (`createBrandFor`).
 */
export function brandsCanGrow(allowance: BrandAllowance): boolean {
  return (
    !isSingleBrand(allowance) &&
    allowance.multiBrand === true &&
    (allowance.allowed === null || allowance.allowed > 1)
  );
}
