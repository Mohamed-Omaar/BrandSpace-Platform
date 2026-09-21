import { describe, expect, it } from 'vitest';
import { switchLocalePath } from '../../apps/dashboard/src/i18n/locale-path';

/**
 * SWITCHING LANGUAGE KEEPS THE READER WHERE THEY WERE.
 *
 * THE DEFECT THESE EXIST FOR. The shell built the switcher's href from
 * `activePath`, which is the NAV ITEM's path rather than the route. Every case
 * below is one the old expression got wrong:
 *
 *   /en/content/compose?item=abc  ->  /ar/content          (composer lost)
 *   /en/assets?tag=x&cursor=y     ->  /ar/assets           (filters lost)
 *   /en/campaigns/<id>            ->  /ar/overview         (unrelated page)
 *
 * The third is the worst of the three: twelve routes pass no `activePath` at
 * all, so changing language moved the reader to a page they had not asked for.
 */
describe('switching locale preserves the logical page', () => {
  it('KEEPS A NESTED ROUTE, rather than collapsing to its nav section', () => {
    expect(switchLocalePath('/en/content/compose', 'ar', '/ar/overview')).toBe(
      '/ar/content/compose',
    );
  });

  it('KEEPS THE QUERY STRING — the filters, the cursor and the selected row', () => {
    expect(
      switchLocalePath('/en/assets?tag=spring&cursor=abc123&asset=42', 'ar', '/ar/overview'),
    ).toBe('/ar/assets?tag=spring&cursor=abc123&asset=42');
  });

  it('keeps a dynamic segment, so a record stays open', () => {
    expect(
      switchLocalePath('/ar/campaigns/9f1b2c3d-0000-4000-8000-000000000001', 'en', '/en/overview'),
    ).toBe('/en/campaigns/9f1b2c3d-0000-4000-8000-000000000001');
  });

  it('round-trips: there and back is where you started', () => {
    const start = '/en/content/compose?item=abc&tab=preview';
    const there = switchLocalePath(start, 'ar', '/ar/overview');
    expect(switchLocalePath(there, 'en', '/en/overview')).toBe(start);
  });

  it('handles the locale root itself', () => {
    expect(switchLocalePath('/en', 'ar', '/ar/overview')).toBe('/ar');
    expect(switchLocalePath('/en/', 'ar', '/ar/overview')).toBe('/ar');
  });

  it('FALLS BACK RATHER THAN GUESSING when the path carries no known locale', () => {
    // Not a route this switcher belongs on. Inventing a target would send the
    // reader somewhere arbitrary; the caller's fallback is the better answer.
    expect(switchLocalePath('/api/health', 'ar', '/ar/overview')).toBe('/ar/overview');
    expect(switchLocalePath('', 'ar', '/ar/overview')).toBe('/ar/overview');
    expect(switchLocalePath(null, 'ar', '/ar/overview')).toBe('/ar/overview');
    expect(switchLocalePath(undefined, 'ar', '/ar/overview')).toBe('/ar/overview');
    // A path that is not absolute did not come from the middleware.
    expect(switchLocalePath('content/compose', 'ar', '/ar/overview')).toBe('/ar/overview');
  });

  it('does not treat a path segment that merely looks like a locale as one', () => {
    // `enrolments` starts with "en"; the segment has to BE the locale.
    expect(switchLocalePath('/enrolments/list', 'ar', '/ar/overview')).toBe('/ar/overview');
  });
});
