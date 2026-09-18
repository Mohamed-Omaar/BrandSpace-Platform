import { describe, expect, it } from 'vitest';
import { AppError } from '@brandspace/shared';
import {
  ALL_BRANDS,
  brandCookieValue,
  defaultBrandFor,
  parseBrandCookie,
  resolveSelection,
  safeReturnPath,
  type AccessibleBrand,
} from '../../apps/dashboard/src/server/brand-selection';
import { ROUTE_SCOPES, scopeForPath } from '../../apps/dashboard/src/server/route-scope';
import {
  brandProfileFrom,
  paletteFrom,
  typographyFrom,
} from '../../apps/dashboard/src/server/brand-profile';

/**
 * PHASE 8 — the decisions the Brand Context makes, asserted directly.
 *
 * WHY THESE ARE UNIT TESTS. Every rule below is about a request THE SCREEN
 * CANNOT PRODUCE: a cookie from another workspace, a `next` that leaves the
 * site, a form with a field missing. A browser can only demonstrate that the
 * screen behaves; these demonstrate what happens when something else asks.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const BRAND = '33333333-3333-4333-8333-333333333333';

describe('P8: the brand cookie proposes and never authorizes', () => {
  it('reads back what it wrote, for this workspace', () => {
    expect(parseBrandCookie(brandCookieValue(WORKSPACE, BRAND), WORKSPACE)).toBe(BRAND);
    expect(parseBrandCookie(brandCookieValue(WORKSPACE, ALL_BRANDS), WORKSPACE)).toBe(ALL_BRANDS);
  });

  it('IGNORES A COOKIE FROM ANOTHER WORKSPACE OUTRIGHT', () => {
    /*
     * THE POINT OF THE WORKSPACE HALF. Switching workspace must never carry a
     * brand across, and the reason this returns null rather than "not found" is
     * that NOTHING IS LOOKED UP: a switch cannot be used to ask whether a brand
     * id exists in the workspace being switched into.
     */
    expect(parseBrandCookie(brandCookieValue(OTHER_WORKSPACE, BRAND), WORKSPACE)).toBeNull();
  });

  it('treats every unusable shape as "you have not chosen"', () => {
    for (const raw of [
      undefined,
      null,
      '',
      BRAND, // no workspace half at all
      `:${BRAND}`, // empty workspace half
      `${WORKSPACE}:`, // empty value
    ]) {
      expect(parseBrandCookie(raw, WORKSPACE)).toBeNull();
    }
  });

  it('keeps a value containing a colon intact', () => {
    // The split is on the FIRST colon, so a value that contains one is not
    // silently truncated into a different id.
    expect(parseBrandCookie(`${WORKSPACE}:a:b`, WORKSPACE)).toBe('a:b');
  });
});

describe('P8: the selector cannot be turned into an open redirect', () => {
  it('keeps a path of this application, in this locale', () => {
    expect(safeReturnPath('/en/content', 'en')).toBe('/en/content');
    expect(safeReturnPath('/ar/overview', 'ar')).toBe('/ar/overview');
  });

  it('refuses anything that leaves the site', () => {
    for (const hostile of [
      'https://evil.example/en/x',
      '//evil.example/en/x',
      '/\\evil.example',
      '/fr/content', // another locale's tree
      'en/content', // not absolute
      '',
    ]) {
      expect(safeReturnPath(hostile, 'en')).toBe('/en/overview');
    }
  });

  it('refuses a control character, which is a response-splitting attempt', () => {
    expect(safeReturnPath('/en/content\nLocation: https://evil.example', 'en')).toBe(
      '/en/overview',
    );
    expect(safeReturnPath('/en/content\r\nSet-Cookie: a=b', 'en')).toBe('/en/overview');
  });

  it('keeps the reader’s other filters and drops a stale explicit brand', () => {
    /*
     * THE `brand` PARAMETER GOES. The selector writes the STORED selection, and
     * an explicit `?brand=` out-ranks the cookie (D-191) — so leaving it in the
     * return path would send the reader back to a page that ignores the thing
     * they just chose.
     */
    expect(safeReturnPath('/en/content?status=DRAFT&brand=abc', 'en')).toBe(
      '/en/content?status=DRAFT',
    );
    expect(safeReturnPath('/en/content?brand=abc', 'en')).toBe('/en/content');
    expect(safeReturnPath('/en/assets?kind=IMAGE&sort=name', 'en')).toBe(
      '/en/assets?kind=IMAGE&sort=name',
    );
  });
});

describe('P8: every route declares its scope in one place', () => {
  it('answers the three kinds for the routes that have them', () => {
    expect(scopeForPath('/members')).toBe('workspace');
    expect(scopeForPath('/brand-brain')).toBe('brand');
    expect(scopeForPath('/assets')).toBe('brand-or-all');
  });

  it('matches the LONGEST prefix, so a child can differ from its parent', () => {
    // `/settings` is workspace-scoped and Brand Profile underneath it is not.
    expect(scopeForPath('/settings')).toBe('workspace');
    expect(scopeForPath('/settings/brand')).toBe('brand');
    // And a child with no entry of its own inherits its parent.
    expect(scopeForPath('/content/compose')).toBe('brand-or-all');
  });

  it('makes an UNDECLARED route inert rather than wrong', () => {
    // The fallback reads no brand at all, so a route somebody forgets to
    // declare cannot silently acquire an aggregate or a requirement.
    expect(scopeForPath('/something-nobody-declared')).toBe('workspace');
  });

  it('declares nothing twice and nothing empty', () => {
    for (const [path, scope] of Object.entries(ROUTE_SCOPES)) {
      expect(path.startsWith('/')).toBe(true);
      expect(['workspace', 'brand', 'brand-or-all']).toContain(scope);
    }
  });
});

describe('P8: the brand profile decoder fails closed', () => {
  const form = (entries: Record<string, string | string[]>): FormData => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) {
      for (const one of Array.isArray(value) ? value : [value]) data.append(key, one);
    }
    return data;
  };

  const complete = {
    name: 'Northwind',
    industry: 'Retail',
    description: 'A shop.',
    websiteUrl: 'https://northwind.example',
    defaultLocale: 'EN',
    headingFont: 'Inter',
    bodyFont: 'Inter',
    colorPalette: '#7935FE, #FFDD15',
    primaryLogoAssetId: '',
    secondaryLogoAssetId: '',
  };

  it('accepts a complete form', () => {
    const decoded = brandProfileFrom(form(complete));
    expect(decoded.name).toBe('Northwind');
    expect(decoded.colorPalette).toEqual(['#7935FE', '#FFDD15']);
    expect(decoded.typography).toEqual({ heading: 'Inter', body: 'Inter' });
    expect(decoded.primaryLogoAssetId).toBeNull();
  });

  it('A BLANK FIELD CLEARS AND A MISSING FIELD REFUSES', () => {
    // Present and empty: somebody deleting a value they had.
    expect(brandProfileFrom(form({ ...complete, industry: '' })).industry).toBeNull();
    // Absent: a request that did not come from the screen. Every control this
    // form renders is carried by every real submission.
    const { industry: _dropped, ...withoutIndustry } = complete;
    expect(() => brandProfileFrom(form(withoutIndustry))).toThrow(AppError);
  });

  it('always includes the default locale among the supported ones', () => {
    const decoded = brandProfileFrom(form({ ...complete, defaultLocale: 'AR' }));
    expect(decoded.supportedLocales).toContain('AR');
    const both = brandProfileFrom(form({ ...complete, supportedLocales: ['AR', 'EN'] }));
    expect([...both.supportedLocales].sort()).toEqual(['AR', 'EN']);
  });

  it('refuses a website that is not an http(s) address', () => {
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://x/y']) {
      expect(() => brandProfileFrom(form({ ...complete, websiteUrl: hostile }))).toThrow(AppError);
    }
    // And an EMPTY one is a person clearing the field, not an attack.
    expect(brandProfileFrom(form({ ...complete, websiteUrl: '' })).websiteUrl).toBeNull();
  });

  it('refuses anything in the palette that is not a colour', () => {
    for (const bad of ['red', '#12', 'rgb(1,2,3)', '#1234567']) {
      expect(() => brandProfileFrom(form({ ...complete, colorPalette: bad }))).toThrow(AppError);
    }
  });

  it('de-duplicates the palette and bounds it', () => {
    const decoded = brandProfileFrom(form({ ...complete, colorPalette: '#fff, #FFF, #fff' }));
    // Case is preserved as typed; identical strings collapse.
    expect(decoded.colorPalette.length).toBeLessThanOrEqual(2);
    const many = Array.from({ length: 13 }, (_, i) => `#00000${i.toString(16)}`).join(',');
    expect(() => brandProfileFrom(form({ ...complete, colorPalette: many }))).toThrow(AppError);
  });

  it('refuses an asset id that is not an id', () => {
    expect(() => brandProfileFrom(form({ ...complete, primaryLogoAssetId: 'not-a-uuid' }))).toThrow(
      AppError,
    );
    expect(
      brandProfileFrom(form({ ...complete, primaryLogoAssetId: BRAND })).primaryLogoAssetId,
    ).toBe(BRAND);
  });

  it('refuses a name that is not a name', () => {
    expect(() => brandProfileFrom(form({ ...complete, name: ' ' }))).toThrow(AppError);
    expect(() => brandProfileFrom(form({ ...complete, name: 'x'.repeat(121) }))).toThrow(AppError);
  });
});

describe('P8: the stored JSON shapes are read defensively', () => {
  it('reads a palette and drops anything that is not a colour', () => {
    expect(paletteFrom(['#7935FE', 'red', 42, null])).toEqual(['#7935FE']);
    expect(paletteFrom(null)).toEqual([]);
    expect(paletteFrom('#7935FE')).toEqual([]);
  });

  it('reads typography without assuming the column holds an object', () => {
    expect(typographyFrom({ heading: 'Inter', body: '' })).toEqual({
      heading: 'Inter',
      body: null,
    });
    expect(typographyFrom(null)).toEqual({ heading: null, body: null });
    expect(typographyFrom(['Inter'])).toEqual({ heading: null, body: null });
  });
});

describe('P8: a creation surface starts on a brand or asks, and never guesses', () => {
  const one: AccessibleBrand = { id: BRAND, name: 'One', slug: 'one', status: 'ACTIVE' };
  const two: AccessibleBrand = {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Two',
    slug: 'two',
    status: 'ACTIVE',
  };

  function contextFor(brands: readonly AccessibleBrand[], selected: string | null) {
    // A brand-or-all route, because the aggregate is the case that differs.
    return resolveSelection(brands, { scope: 'brand-or-all', requested: selected, stored: null });
  }

  it('takes the selected brand', () => {
    expect(defaultBrandFor(contextFor([one, two], BRAND))).toBe(BRAND);
  });

  /*
   * THE REGRESSION THIS EXISTS FOR. A workspace with ONE brand and nothing
   * selected resolves to the aggregate on a brand-or-all route — and the
   * composer, reading the aggregate as "no brand", disabled generation for the
   * commonest customer there is. "All brands" over one brand names that brand.
   */
  it('takes the sole accessible brand when the context is the aggregate', () => {
    expect(defaultBrandFor(contextFor([one], ALL_BRANDS))).toBe(BRAND);
    expect(defaultBrandFor(contextFor([one], null))).toBe(BRAND);
  });

  it('asks when the aggregate covers a real choice', () => {
    expect(defaultBrandFor(contextFor([one, two], ALL_BRANDS))).toBeNull();
  });

  it('has nothing to offer when the member can act on no brand', () => {
    expect(defaultBrandFor(contextFor([], null))).toBeNull();
  });
});
