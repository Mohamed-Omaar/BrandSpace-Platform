import { describe, expect, it } from 'vitest';
import { brandTypography } from '@brandspace/creative';

/**
 * D-301 — the brand's type reaches the image prompt in the shape Brand
 * Profile actually stores it. The generation route read `{ heading, body }`
 * as an array and so sent no typography at all.
 */
describe('D-301 · brandTypography', () => {
  it('reads the profile shape, heading first', () => {
    expect(brandTypography({ heading: 'Playfair', body: 'Inter' })).toEqual(['Playfair', 'Inter']);
  });

  it('drops a missing or blank face, and a repeated one', () => {
    expect(brandTypography({ heading: 'Inter', body: 'Inter' })).toEqual(['Inter']);
    expect(brandTypography({ heading: ' ', body: null })).toEqual([]);
  });

  it('still reads the older array shape', () => {
    expect(brandTypography(['Inter', 3, 'Cairo'])).toEqual(['Inter', 'Cairo']);
  });

  it('invents nothing from nothing', () => {
    expect(brandTypography(null)).toEqual([]);
    expect(brandTypography('Inter')).toEqual([]);
  });
});
