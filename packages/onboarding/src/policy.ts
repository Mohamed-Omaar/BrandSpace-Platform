/**
 * The `onboarding` policy, read from activated configuration.
 *
 * WHY THE TYPE LIVES IN TWO PLACES. `@brandspace/auth` needs the signup half and
 * must not depend on the configuration service (it runs on the login path,
 * before any workspace or catalogue is known), so it declares the shape it
 * consumes. This is the READER — the one place that turns an activated document
 * into that shape — and the compiler checks they agree wherever both are used.
 *
 * NO COUNTRY, LOCALE, TIMEZONE OR CURRENCY (D-194). Onboarding ASKS for all
 * four. If the document carried a default for any of them, every customer who
 * clicked through would silently become whatever the owner typed once.
 */

import { parseConfigPayload } from '@brandspace/config';

export const ONBOARDING_CONFIG_DOMAIN = 'onboarding' as const;

export type Environment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';

export interface LocalizedText {
  readonly ar: string;
  readonly en: string;
}

export interface LegalDocumentRequirement {
  readonly key: string;
  readonly title: LocalizedText;
  readonly version: string;
  readonly url: LocalizedText | null;
  readonly required: boolean;
}

export interface IndustryDefinition {
  readonly key: string;
  readonly name: LocalizedText;
  readonly offersQuestionSet: string;
}

export type OnboardingStepKey =
  'workspace' | 'brand' | 'brand_profile' | 'brand_brain' | 'social' | 'team' | 'plan';

export interface OnboardingStepRule {
  readonly key: OnboardingStepKey;
  readonly required: boolean;
  readonly sortOrder: number;
}

export interface OnboardingPolicy {
  readonly signup: {
    readonly open: boolean;
    readonly minPasswordLength: number;
    readonly verificationTtlMinutes: number;
    readonly verificationResendCooldownSeconds: number;
    readonly verificationsPerHour: number;
  };
  readonly legalDocuments: readonly LegalDocumentRequirement[];
  /**
   * The abuse ceilings for the authentication surface (F-19).
   *
   * Projected alongside the signup rules because they are read at exactly the
   * same moments and by the same callers — a second document would mean a
   * second read on the sign-in path for no gain.
   */
  readonly abuse: {
    readonly windowSeconds: number;
    readonly signInPerIp: number;
    readonly signInPerAccount: number;
    readonly signUpPerIp: number;
    readonly passwordResetPerIp: number;
    readonly passwordResetPerAccount: number;
    readonly verificationResendPerIp: number;
    readonly mfaPerIp: number;
    readonly mfaPerAccount: number;
  };
  readonly mfa: {
    readonly customerEnrolmentEnabled: boolean;
    readonly requiredForCustomers: boolean;
    readonly recoveryCodeCount: number;
  };
  /** A8 (D-328): how long a workspace waits, pending deletion. */
  readonly workspaceDeletion: {
    readonly graceDays: number;
  };
  /** G6 (D-329): the industry list, and each industry's Offers question set. */
  readonly industries: readonly IndustryDefinition[];
  readonly steps: readonly OnboardingStepRule[];
}

export function onboardingPolicyFrom(payload: Record<string, unknown>): OnboardingPolicy {
  return parseConfigPayload(ONBOARDING_CONFIG_DOMAIN, payload) as unknown as OnboardingPolicy;
}

/** The steps in the order an owner put them, required ones first within a tie. */
export function orderedSteps(policy: OnboardingPolicy): readonly OnboardingStepRule[] {
  return [...policy.steps].sort(
    (a, b) => a.sortOrder - b.sortOrder || Number(b.required) - Number(a.required),
  );
}

/** The slice of a tenant-scoped client this source needs. */
export interface CatalogueReader {
  readonly entitlementCatalogueSnapshot: {
    findUnique(args: {
      where: { domain_environment: { domain: string; environment: Environment } };
    }): Promise<{ payload: unknown } | null>;
  };
}

/**
 * Reads the projection, so the customer application never touches
 * `configuration_version`, which stays platform-owned.
 *
 * NO SNAPSHOT MEANS THE SCHEMA'S DEFAULTS, which offer no legal document and no
 * step. That is the correct answer before an owner has approved anything, and
 * the signup form says so rather than inventing terms nobody wrote.
 */
export class TenantOnboardingPolicySource {
  readonly #db: CatalogueReader;
  readonly #environment: Environment;

  constructor(db: CatalogueReader, environment: Environment) {
    this.#db = db;
    this.#environment = environment;
  }

  async load(): Promise<OnboardingPolicy> {
    const row = await this.#db.entitlementCatalogueSnapshot.findUnique({
      where: {
        domain_environment: { domain: ONBOARDING_CONFIG_DOMAIN, environment: this.#environment },
      },
    });
    return onboardingPolicyFrom((row?.payload ?? {}) as Record<string, unknown>);
  }
}
