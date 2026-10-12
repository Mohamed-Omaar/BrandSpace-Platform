import { describe, expect, it } from 'vitest';
import { homeCreditGrant } from '../../apps/dashboard/src/server/home-prototype';

/**
 * PR F (f) — Home's credits card reads "of {trial grant}" during the trial,
 * so "200 of 500" (a 200-credit trial measured against a 500-credit monthly
 * grant it never had) cannot appear, whatever the configuration.
 */
describe("Home's credits: of N", () => {
  it('during the trial, N is what the trial granted — never the monthly grant', () => {
    expect(homeCreditGrant({ pinnedMonthlyCredits: 500, status: 'TRIALING' }, 500, 200)).toBe(200);
    expect(homeCreditGrant({ pinnedMonthlyCredits: 0, status: 'TRIALING' }, 500, 200)).toBe(200);
  });

  it('a trial that granted nothing has no N (balance only, no bar)', () => {
    expect(homeCreditGrant({ pinnedMonthlyCredits: 500, status: 'TRIALING' }, 500, 0)).toBeNull();
    expect(
      homeCreditGrant({ pinnedMonthlyCredits: 500, status: 'TRIALING' }, 500, null),
    ).toBeNull();
  });

  it('a paid period keeps the monthly grant', () => {
    expect(homeCreditGrant({ pinnedMonthlyCredits: 500, status: 'ACTIVE' }, 300, 200)).toBe(500);
  });
});
