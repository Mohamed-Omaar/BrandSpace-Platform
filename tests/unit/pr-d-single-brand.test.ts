import { describe, expect, it } from 'vitest';
import {
  brandsCanGrow,
  isSingleBrand,
} from '../../apps/dashboard/src/server/brand-allowance-model';

/**
 * D-501 — THE BETA'S ONE BRAND, BY CONFIGURATION. Allowed one brand and
 * holding it: a plain card, nothing offers another. Raise the allowance (and
 * multi-brand is on) and the brand menu with "+ Add a brand" is back.
 */
describe('one brand in the beta', () => {
  it('is single at an allowance of one with one brand', () => {
    expect(isSingleBrand({ used: 1, allowed: 1, multiBrand: true })).toBe(true);
    expect(isSingleBrand({ used: 1, allowed: 1, multiBrand: false })).toBe(true);
    expect(isSingleBrand({ used: 0, allowed: 1, multiBrand: true })).toBe(true);
  });

  it('is not single once the allowance is raised, or with brands already beyond it', () => {
    expect(isSingleBrand({ used: 1, allowed: 2, multiBrand: true })).toBe(false);
    expect(isSingleBrand({ used: 1, allowed: null, multiBrand: true })).toBe(false);
    expect(isSingleBrand({ used: 2, allowed: 1, multiBrand: true })).toBe(false);
  });

  it('grows only with an allowance above one AND multi-brand on — what the server asks', () => {
    expect(brandsCanGrow({ used: 1, allowed: 2, multiBrand: true })).toBe(true);
    expect(brandsCanGrow({ used: 1, allowed: null, multiBrand: true })).toBe(true);
    expect(brandsCanGrow({ used: 1, allowed: 1, multiBrand: true })).toBe(false);
    expect(brandsCanGrow({ used: 1, allowed: 2, multiBrand: false })).toBe(false);
    expect(brandsCanGrow({ used: 1, allowed: 2 })).toBe(false);
  });
});
