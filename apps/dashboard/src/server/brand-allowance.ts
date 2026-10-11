import 'server-only';
import { cache } from 'react';
import { QUOTA_FEATURES } from '@brandspace/entitlements';
import { inBrandBrain } from './brand-brain-context';
import type { BrandAllowance } from './brand-allowance-model';

export { brandUsage, mayAddBrand, type BrandAllowance } from './brand-allowance-model';

/**
 * PR D (Shell 6) — THE BRAND MENU'S "Brands · used/allowed" (Main line 97).
 *
 * `used` is the workspace's live brands, counted under RLS; `allowed` is the
 * plan's brand quota from the entitlements engine — the same limit
 * `createBrandFor` consumes against, so the menu and the server never
 * disagree. `null` means the plan states no ceiling. Read only when the brand
 * menu is drawn (several brands), once per request.
 */

export const brandAllowance = cache(async (workspaceId: string): Promise<BrandAllowance | null> =>
  inBrandBrain(workspaceId, async ({ db, entitlements }) => ({
    used: await db.brand.count({ where: { workspaceId, deletedAt: null } }),
    allowed: await entitlements.limit(workspaceId, QUOTA_FEATURES.brands),
  })).catch(() => null),
);
