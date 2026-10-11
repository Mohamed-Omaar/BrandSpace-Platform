import { describe, expect, it } from 'vitest';
import { brandUsage, mayAddBrand } from '../../apps/dashboard/src/server/brand-allowance-model';

/**
 * PR D (Shell 6) — "Brands in this workspace · used/allowed" and whether
 * "+ Add a brand" adds or says the plan's limit.
 */
describe('the brand menu allowance', () => {
  it('reads used/allowed, or the count alone without a stated ceiling', () => {
    expect(brandUsage({ used: 2, allowed: 3 })).toBe('2/3');
    expect(brandUsage({ used: 2, allowed: null })).toBe('2');
  });

  it('adds below the ceiling and says the limit at it', () => {
    expect(mayAddBrand({ used: 2, allowed: 3 })).toBe(true);
    expect(mayAddBrand({ used: 3, allowed: 3 })).toBe(false);
    expect(mayAddBrand({ used: 4, allowed: 3 })).toBe(false);
    expect(mayAddBrand({ used: 9, allowed: null })).toBe(true);
  });
});
