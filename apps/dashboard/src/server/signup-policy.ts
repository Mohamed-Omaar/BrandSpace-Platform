import 'server-only';
import { getPrisma, withoutTenantContext } from '@brandspace/database';
import { TenantOnboardingPolicySource, type OnboardingPolicy } from '@brandspace/onboarding';
import { currentEnvironment } from './customer-context';

/**
 * The signup half of the onboarding policy, with NO workspace in hand.
 *
 * THE PASSWORD RULES ARE NEEDED BEFORE A WORKSPACE EXISTS (P6-03a). Four
 * surfaces set a password — sign-up, password reset, invitation acceptance and
 * their two server actions — and none of them has a tenant context to read one
 * through. Reset and invitation are reached from an emailed link by somebody
 * who is not signed in and belongs to no workspace yet.
 *
 * ONE READER, FOUR CALLERS, WHICH IS THE POINT. The sign-up page loaded this
 * inline and the other three hard-coded `12` instead. That is not a tidiness
 * complaint: it meant an operator lowering the configured minimum changed
 * nothing a customer could see on three of the four screens, and the fourth
 * accepted a password the domain then refused to hash. A single accessor is
 * what stops a caller holding a different opinion about a number CLAUDE.md
 * §2.2 puts in configuration.
 *
 * ITS OWN MODULE RATHER THAN `commerce-context`, so the unauthenticated auth
 * path does not pull the billing, entitlements and invoice import graph in to
 * ask one question.
 *
 * NOTHING HERE IS PLATFORM ADMIN'S. Platform accounts have their own rules and
 * mandatory MFA (D-27), and no part of this reaches them.
 */
export async function signupPolicy(): Promise<OnboardingPolicy['signup']> {
  const policy = await withoutTenantContext(
    async (db) => new TenantOnboardingPolicySource(db, currentEnvironment()).load(),
    { prisma: getPrisma() },
  );
  return policy.signup;
}
