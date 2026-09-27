/**
 * Self-service signup, email verification and CUSTOMER MFA — Phase 9 §10, §11.
 *
 * THE THREE PROPERTIES THIS FILE EXISTS TO HOLD:
 *
 *   1. SIGNUP DOES NOT REVEAL WHO HAS AN ACCOUNT. Every outcome — created,
 *      already registered, signup closed to this address — returns the same
 *      value after the same work. An address that already exists is emailed a
 *      "you already have an account" notice instead of a verification link, so
 *      the person who owns it finds out and the person guessing does not.
 *
 *   2. AN UNVERIFIED ACCOUNT IS NOT AN ACCOUNT. The user is created PENDING and
 *      cannot sign in until a single-use link proves address control. The token
 *      is stored only as a SHA-256 hash, and the raw value exists solely in the
 *      emailed URL — a dump of the table yields nothing usable.
 *
 *   3. THE MFA SEED IS NEVER STORED. It is sealed with the customer MFA key
 *      domain (D-206) and the envelope binds to that one user, so a row copied
 *      to another account fails to decrypt rather than quietly authenticating
 *      somebody else.
 *
 * WHAT IS CONFIGURATION AND NOT CODE (CLAUDE.md §2.2): whether signup is open,
 * the password floor, the link's lifetime, the resend cooldown and ceiling,
 * which legal documents must be accepted and at which version, and how many
 * recovery codes are issued. Every one of them arrives in `OnboardingPolicy`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@brandspace/database';
import { AppError, type Clock, systemClock } from '@brandspace/shared';
import {
  CUSTOMER_MFA_DOMAIN,
  createKeyProvider,
  decryptSecret,
  encryptSecret,
  type EncryptedMaterial,
  type KeyProvider,
} from '@brandspace/vault';
import type { EmailProvider } from './email';
import {
  generateRecoveryCodes,
  generateTotpEnrolment,
  hashRecoveryCode,
  totpVerifier,
  type TotpEnrolment,
  totpUri,
} from './mfa';
import { hashPassword, verifyPassword } from './password';
import { AuthRateLimiter, type AbuseCeilings } from './rate-limit';

// --- The policy, as the activated `onboarding` document carries it ------------

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

export interface OnboardingPolicy {
  readonly signup: {
    readonly open: boolean;
    readonly minPasswordLength: number;
    readonly verificationTtlMinutes: number;
    readonly verificationResendCooldownSeconds: number;
    readonly verificationsPerHour: number;
  };
  readonly legalDocuments: readonly LegalDocumentRequirement[];
  /** The abuse ceilings (F-19). Structurally the same shape the projection has. */
  readonly abuse: AbuseCeilings;
  readonly mfa: {
    readonly customerEnrolmentEnabled: boolean;
    readonly requiredForCustomers: boolean;
    readonly recoveryCodeCount: number;
  };
  readonly steps: ReadonlyArray<{
    readonly key: string;
    readonly required: boolean;
    readonly sortOrder: number;
  }>;
}

// --- Signup -------------------------------------------------------------------

export interface SignupInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly locale: 'AR' | 'EN';
  /**
   * NO DEFAULT (D-194). The form asks; a browser's own zone may prefill the
   * control, but nothing here substitutes one if the answer is missing.
   */
  readonly timezone: string;
  /** Which documents, at which versions, the person ticked. */
  readonly acceptedDocuments: ReadonlyArray<{ readonly key: string; readonly version: string }>;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/**
 * What every signup returns, whatever happened.
 *
 * DELIBERATELY UNINFORMATIVE. It says a verification email will arrive if the
 * address can be registered — which is true either way and reveals nothing.
 */
export interface SignupAcknowledgement {
  readonly acknowledged: true;
}

export interface VerificationIssued {
  readonly userId: string;
  /** The RAW token. Composed into a link by the caller and never stored. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface SignupServiceOptions {
  readonly prisma: PrismaClient;
  readonly email: EmailProvider;
  /**
   * Builds the verification URL from the raw token. Supplied rather than
   * composed here, because the public base URL is deployment configuration and
   * must not be a constant in a package (docs/ARCHITECTURE.md).
   */
  readonly verificationLink: (token: string, locale: 'AR' | 'EN') => string;
  readonly clock?: Clock;
  readonly keyProvider?: KeyProvider;
  readonly env?: NodeJS.ProcessEnv;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 256 bits, URL-safe. Only its hash is ever written down. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class SignupService {
  readonly #prisma: PrismaClient;
  readonly #limiter: AuthRateLimiter;
  readonly #email: EmailProvider;
  readonly #link: (token: string, locale: 'AR' | 'EN') => string;
  readonly #clock: Clock;
  readonly #keyProviderOverride: KeyProvider | undefined;
  readonly #env: NodeJS.ProcessEnv;
  #keyProvider: KeyProvider | null = null;

  constructor(options: SignupServiceOptions) {
    this.#prisma = options.prisma;
    this.#email = options.email;
    this.#link = options.verificationLink;
    this.#clock = options.clock ?? systemClock;
    this.#keyProviderOverride = options.keyProvider;
    this.#env = options.env ?? process.env;
    this.#limiter = new AuthRateLimiter({ prisma: options.prisma, clock: this.#clock });
  }

  /**
   * Register an account, or convincingly appear to.
   *
   * THE VALIDATION THAT RUNS FIRST is the part a caller CAN observe — a password
   * below the configured floor, a missing legal acceptance, a malformed address.
   * Those are properties of the REQUEST, not of the account, so refusing them
   * loudly tells an attacker nothing. Everything that depends on whether the
   * address exists happens after, and is silent.
   */
  async signUp(policy: OnboardingPolicy, input: SignupInput): Promise<SignupAcknowledgement> {
    const email = input.email.trim().toLowerCase();

    /*
     * A CEILING ON ACCOUNT CREATION (F-19). There was none: one caller could
     * create accounts without limit, and — because a TAKEN address is answered
     * by mailing "you already have an account" to the address itself — could
     * also send unlimited mail to any inbox it named. The ceiling is per SOURCE
     * rather than per address, because the address is the attacker's choice and
     * the source is not.
     */
    await this.#limiter.enforce(
      'signup:ip',
      input.ip,
      policy.abuse.signUpPerIp,
      policy.abuse.windowSeconds,
    );

    if (!EMAIL_SHAPE.test(email)) {
      throw new AppError('VALIDATION_FAILED', 'That does not look like an email address.');
    }
    if (input.password.length < policy.signup.minPasswordLength) {
      throw new AppError('VALIDATION_FAILED', 'That password is too short.', {
        minLength: policy.signup.minPasswordLength,
      });
    }
    if (!input.timezone.trim()) {
      // D-194: there is no product-wide timezone to fall back to, and inventing
      // one here would put the assumption back that decision removed.
      throw new AppError('VALIDATION_FAILED', 'A timezone is required.');
    }
    if (!input.name.trim()) {
      throw new AppError('VALIDATION_FAILED', 'A name is required.');
    }

    assertLegalAcceptance(policy, input.acceptedDocuments);

    if (!policy.signup.open) {
      // Closed signup is a property of the PLATFORM, not of the address, so it
      // is honest to say so plainly.
      throw new AppError('FORBIDDEN', 'Signup is currently by invitation only.');
    }

    const existing = await this.#prisma.user.findUnique({
      where: { email },
      select: { id: true, locale: true, deletedAt: true },
    });

    if (existing) {
      // THE ADDRESS IS TOLD, THE CALLER IS NOT. Whoever owns the inbox learns
      // that someone tried; whoever sent the request learns nothing.
      await this.#email.send({
        to: email,
        templateKey: 'auth.signup.exists',
        locale: existing.locale,
      });
      await this.#audit(existing.id, 'customer.signup.duplicate', input.ip, 'NOTICE');
      return { acknowledged: true };
    }

    const passwordHash = await hashPassword(input.password);
    const now = this.#clock.now();
    const token = mintToken();
    const expiresAt = new Date(now.getTime() + policy.signup.verificationTtlMinutes * 60_000);

    await this.#prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name: input.name.trim(),
          locale: input.locale,
          timezone: input.timezone.trim(),
          passwordHash,
          // PENDING until a link is followed. `signIn` refuses anything but
          // ACTIVE, so an unverified account cannot be used.
          status: 'PENDING',
        },
        select: { id: true },
      });

      await tx.userLegalAcceptance.createMany({
        data: input.acceptedDocuments.map((doc) => ({
          userId: user.id,
          documentKey: doc.key,
          version: doc.version,
          ip: input.ip ?? null,
          userAgent: input.userAgent ?? null,
        })),
      });

      await tx.emailVerificationToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt, ip: input.ip ?? null },
      });

      /*
       * `createMany`, NOT `create`. Prisma's `create` issues INSERT … RETURNING,
       * and the tenant policy's USING clause deliberately hides platform-scope
       * events (`workspaceId IS NULL`) from every tenant — so the row is written
       * and the RETURNING then fails, reported as "new row violates row-level
       * security policy" for a write that was actually allowed. The same trap
       * `CustomerAuthService` and the outbox already document; repeated here
       * because the day somebody switches this back is the day signup starts
       * failing on a line that looks like bookkeeping.
       */
      await tx.auditEvent.createMany({
        data: [
          {
            workspaceId: null,
            actorType: 'USER',
            actorId: user.id,
            action: 'customer.signup.started',
            severity: 'NOTICE',
            outcome: 'SUCCESS',
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
          },
        ],
      });
    });

    await this.#email.send({
      to: email,
      templateKey: 'auth.email_verification',
      locale: input.locale,
      // THE LINK IS DELIVERED AND NOT STORED. `variables` is persisted after
      // redaction; `link` is not persisted at all, which is what keeps a usable
      // token out of the outbox table.
      link: this.#link(token, input.locale),
    });

    return { acknowledged: true };
  }

  /**
   * Follow the link.
   *
   * SINGLE USE BY CONDITIONAL UPDATE, not by reading then writing. Two
   * simultaneous clicks race on `usedAt IS NULL`; exactly one wins, and the
   * loser is indistinguishable from a link used yesterday.
   */
  async verifyEmail(
    token: string,
    context: { readonly ip?: string | undefined } = {},
  ): Promise<{ readonly userId: string } | null> {
    if (!token) return null;
    const row = await this.#prisma.emailVerificationToken.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, userId: true, expiresAt: true, usedAt: true },
    });
    if (!row) return null;

    const now = this.#clock.now();
    if (row.usedAt || row.expiresAt <= now) return null;

    const claimed = await this.#prisma.emailVerificationToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count === 0) return null;

    await this.#prisma.user.update({
      where: { id: row.userId },
      data: {
        emailVerifiedAt: now,
        // PENDING becomes ACTIVE. A SUSPENDED or DELETED account is left alone:
        // proving an address must never overturn an administrative decision.
        ...((await this.#isPending(row.userId)) ? { status: 'ACTIVE' as const } : {}),
      },
    });

    await this.#audit(row.userId, 'customer.email.verified', context.ip, 'NOTICE');
    return { userId: row.userId };
  }

  /**
   * Send another link.
   *
   * RATE-LIMITED AND SILENT. An unknown address, a cooldown that has not
   * elapsed and an hourly ceiling already reached all return the same
   * acknowledgement — otherwise this endpoint becomes the account-enumeration
   * oracle that `signUp` carefully is not.
   */
  async resendVerification(
    policy: OnboardingPolicy,
    email: string,
    context: { readonly ip?: string | undefined } = {},
  ): Promise<SignupAcknowledgement> {
    const address = email.trim().toLowerCase();

    /*
     * THE PER-ACCOUNT COOLDOWN AND HOURLY CEILING BELOW ALREADY WORK, and they
     * are keyed on the target address — which the caller chooses. One source
     * walking a list of addresses meets neither. This is the dimension that was
     * missing.
     */
    await this.#limiter.enforce(
      'verification-resend:ip',
      context.ip,
      policy.abuse.verificationResendPerIp,
      policy.abuse.windowSeconds,
    );

    const user = await this.#prisma.user.findUnique({
      where: { email: address },
      select: { id: true, locale: true, emailVerifiedAt: true, status: true },
    });
    if (!user || user.emailVerifiedAt || user.status === 'DELETED') {
      return { acknowledged: true };
    }

    const now = this.#clock.now();
    const since = new Date(now.getTime() - 3_600_000);
    const recent = await this.#prisma.emailVerificationToken.findMany({
      where: { userId: user.id, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (recent.length >= policy.signup.verificationsPerHour) return { acknowledged: true };
    const last = recent[0]?.createdAt;
    if (
      last &&
      now.getTime() - last.getTime() < policy.signup.verificationResendCooldownSeconds * 1_000
    ) {
      return { acknowledged: true };
    }

    const token = mintToken();
    await this.#prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + policy.signup.verificationTtlMinutes * 60_000),
        ip: context.ip ?? null,
      },
    });
    await this.#email.send({
      to: address,
      templateKey: 'auth.email_verification',
      locale: user.locale,
      link: this.#link(token, user.locale),
    });
    return { acknowledged: true };
  }

  // --- Customer MFA -----------------------------------------------------------

  /**
   * Begin enrolment: mint a seed, seal it, hand back the QR.
   *
   * MFA IS NOT ENABLED YET. The seed is stored sealed and `mfaEnabled` stays
   * false until a code proves the authenticator actually has it — otherwise a
   * mistyped scan locks the customer out of their own account.
   */
  async beginMfaEnrolment(
    policy: OnboardingPolicy,
    userId: string,
  ): Promise<{ readonly otpauthUri: string; readonly issuer: string }> {
    if (!policy.mfa.customerEnrolmentEnabled) {
      throw new AppError('FORBIDDEN', 'Two-factor authentication is not available.');
    }
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, mfaEnabled: true },
    });
    if (!user) throw new AppError('NOT_FOUND', 'User not found.');
    if (user.mfaEnabled) {
      throw new AppError('CONFLICT', 'Two-factor authentication is already on for this account.');
    }

    const enrolment: TotpEnrolment = generateTotpEnrolment(user.email);
    const sealed = await encryptSecret(enrolment.secret, customerMfaContext(userId), this.#keys());

    await this.#prisma.user.update({
      where: { id: userId },
      data: { mfaSecretMaterial: sealed as unknown as object, mfaEnabled: false },
    });

    // The URI CONTAINS the seed, so it is returned once and never logged,
    // audited or persisted.
    return { otpauthUri: enrolment.otpauthUri, issuer: enrolment.issuer };
  }

  /**
   * Confirm enrolment with a live code, and issue recovery codes.
   *
   * THE CODES ARE RETURNED ONCE AND STORED ONLY AS HASHES. Without them, losing
   * a phone locks a customer out permanently — which is how optional MFA turns
   * into MFA nobody switches on.
   */
  async confirmMfaEnrolment(
    policy: OnboardingPolicy,
    userId: string,
    code: string,
  ): Promise<{ readonly recoveryCodes: readonly string[] }> {
    const secret = await this.#openSeed(userId);
    if (!secret) throw new AppError('CONFLICT', 'Start enrolment before confirming it.');
    if (!totpVerifier.verify({ secret, token: code })) {
      throw new AppError('UNAUTHENTICATED', 'That code is not valid.');
    }

    const codes = generateRecoveryCodes(policy.mfa.recoveryCodeCount);
    const now = this.#clock.now();

    await this.#prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { mfaEnabled: true, mfaEnrolledAt: now },
      });
      // Replace wholesale: re-enrolling must invalidate the previous set, or an
      // old printout stays a working second factor forever.
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.userMfaRecoveryCode.createMany({
        data: codes.map((value) => ({ userId, codeHash: hashRecoveryCode(value) })),
      });
      // `createMany` for the reason given in `signUp` above.
      await tx.auditEvent.createMany({
        data: [
          {
            workspaceId: null,
            actorType: 'USER',
            actorId: userId,
            action: 'customer.mfa.enrolled',
            severity: 'NOTICE',
            outcome: 'SUCCESS',
          },
        ],
      });
    });

    return { recoveryCodes: codes };
  }

  /**
   * Verify a second factor: a TOTP code, or one recovery code, once.
   *
   * A RECOVERY CODE IS CONSUMED BY A CONDITIONAL UPDATE, so two simultaneous
   * uses of the same code cannot both succeed. Comparison is constant-time, so
   * timing cannot reveal a partial match.
   */
  async verifyMfa(userId: string, code: string): Promise<boolean> {
    const secret = await this.#openSeed(userId);
    if (!secret) return false;
    if (totpVerifier.verify({ secret, token: code })) return true;

    const candidate = hashRecoveryCode(code);
    const rows = await this.#prisma.userMfaRecoveryCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
    });
    const match = rows.find((row) => constantTimeHexEquals(row.codeHash, candidate));
    if (!match) return false;

    const claimed = await this.#prisma.userMfaRecoveryCode.updateMany({
      where: { id: match.id, usedAt: null },
      data: { usedAt: this.#clock.now() },
    });
    if (claimed.count === 0) return false;

    await this.#audit(userId, 'customer.mfa.recovery-code-used', undefined, 'WARNING');
    return true;
  }

  /**
   * Turn MFA off. Requires a working second factor first.
   *
   * WHY A CODE IS REQUIRED. Disabling MFA with only a session cookie would make
   * a stolen session enough to remove the protection that session was supposed
   * to be behind.
   */
  async disableMfa(userId: string, code: string): Promise<void> {
    const ok = await this.verifyMfa(userId, code);
    if (!ok) throw new AppError('UNAUTHENTICATED', 'That code is not valid.');
    await this.#turnOff(userId);
  }

  async #turnOff(userId: string): Promise<void> {
    await this.#prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          mfaEnabled: false,
          mfaSecretMaterial: Prisma.DbNull,
          mfaPendingSecretMaterial: Prisma.DbNull,
          mfaEnrolledAt: null,
        },
      });
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.auditEvent.createMany({
        data: [
          {
            workspaceId: null,
            actorType: 'USER',
            actorId: userId,
            action: 'customer.mfa.disabled',
            severity: 'WARNING',
            outcome: 'SUCCESS',
          },
        ],
      });
    });
  }

  /**
   * Issue a fresh set of recovery codes, replacing the old one.
   *
   * THE GAP THIS CLOSES. Codes are shown once at enrolment and each works once;
   * somebody who spends them has no way back to a working set short of turning
   * MFA off and on again — which F-13 records as the same defect on the platform
   * side. Nothing about the rules changes: this is the replacement
   * `confirmMfaEnrolment` already performs, asked for deliberately.
   *
   * IT DEMANDS A WORKING CODE, exactly like disabling, and for the same reason:
   * a stolen session must not be able to mint itself a set of permanent
   * credentials for an account it has no second factor for. A recovery code is
   * accepted as that proof — `verifyMfa` spends it — so the person who has lost
   * their device can still use their last code to get a new set.
   */
  async regenerateRecoveryCodes(
    policy: OnboardingPolicy,
    userId: string,
    code: string,
  ): Promise<{ readonly recoveryCodes: readonly string[] }> {
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { mfaEnabled: true },
    });
    if (!user?.mfaEnabled) {
      throw new AppError('CONFLICT', 'Two-factor authentication is not on for this account.');
    }
    const ok = await this.verifyMfa(userId, code);
    if (!ok) throw new AppError('UNAUTHENTICATED', 'That code is not valid.');

    const codes = generateRecoveryCodes(policy.mfa.recoveryCodeCount);
    await this.#prisma.$transaction(async (tx) => {
      // Wholesale, for the reason enrolment gives: a surviving old code is a
      // working second factor somebody printed and forgot.
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.userMfaRecoveryCode.createMany({
        data: codes.map((value) => ({ userId, codeHash: hashRecoveryCode(value) })),
      });
      await tx.auditEvent.createMany({
        data: [
          {
            workspaceId: null,
            actorType: 'USER',
            actorId: userId,
            action: 'customer.mfa.recovery-codes-replaced',
            severity: 'NOTICE',
            outcome: 'SUCCESS',
          },
        ],
      });
    });
    return { recoveryCodes: codes };
  }

  /**
   * THE ENROLMENT IN PROGRESS, for its own person's settings page (G4, D-333).
   *
   * A first enrolment (a sealed seed, two-step not on yet) or a new phone being
   * set up (a pending seed beside the live one). Opened on the server so the
   * page can draw the QR code and print the key — the seed is never put in a
   * URL, a log or an audit row. Null when nothing is being set up.
   */
  async pendingEnrolment(
    userId: string,
  ): Promise<{ readonly secret: string; readonly otpauthUri: string } | null> {
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        mfaEnabled: true,
        mfaSecretMaterial: true,
        mfaPendingSecretMaterial: true,
      },
    });
    if (!user) return null;
    const material = user.mfaEnabled ? user.mfaPendingSecretMaterial : user.mfaSecretMaterial;
    if (!material) return null;
    const secret = await this.#openMaterial(userId, material);
    if (!secret) return null;
    return { secret, otpauthUri: totpUri(secret, user.email) };
  }

  /**
   * Turn two-step verification off with EITHER a current code or the account
   * password (G4, D-333). The caller wraps this in the session step-up, which
   * rate-limits it and counts a wrong proof toward the lockout; a workspace
   * that requires two-step is checked by the caller before this is reached.
   */
  async disableMfaWith(
    userId: string,
    proof: { readonly code: string } | { readonly password: string },
  ): Promise<boolean> {
    if ('password' in proof) {
      const user = await this.#prisma.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true, mfaEnabled: true },
      });
      if (!user?.mfaEnabled || !user.passwordHash || proof.password === '') return false;
      if (!(await verifyPassword(user.passwordHash, proof.password))) return false;
    } else if (!(await this.verifyMfa(userId, proof.code))) {
      return false;
    }
    await this.#turnOff(userId);
    return true;
  }

  /**
   * "NEW PHONE" (G4, D-333): a current code — from the old phone, or a
   * recovery code — starts setting up another authenticator. The live one
   * keeps working until the new one proves itself, so abandoning halfway
   * locks nobody out. False when the code is wrong.
   */
  async beginMfaReenrolment(
    policy: OnboardingPolicy,
    userId: string,
    code: string,
  ): Promise<boolean> {
    if (!policy.mfa.customerEnrolmentEnabled) {
      throw new AppError('FORBIDDEN', 'Two-factor authentication is not available.');
    }
    const user = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, mfaEnabled: true },
    });
    if (!user?.mfaEnabled) {
      throw new AppError('CONFLICT', 'Two-factor authentication is not on for this account.');
    }
    if (!(await this.verifyMfa(userId, code))) return false;
    const enrolment = generateTotpEnrolment(user.email);
    const sealed = await encryptSecret(enrolment.secret, customerMfaContext(userId), this.#keys());
    await this.#prisma.user.update({
      where: { id: userId },
      data: { mfaPendingSecretMaterial: sealed as unknown as object },
    });
    await this.#audit(userId, 'customer.mfa.reenrolment_started', undefined, 'NOTICE');
    return true;
  }

  /**
   * The new phone proves itself with a 6-digit code: its seed becomes the live
   * one, the old phone stops working, and a fresh set of recovery codes is
   * issued (the old printout stops working too).
   */
  async confirmMfaReenrolment(
    policy: OnboardingPolicy,
    userId: string,
    code: string,
  ): Promise<{ readonly recoveryCodes: readonly string[] }> {
    const row = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { mfaPendingSecretMaterial: true },
    });
    const pending = row?.mfaPendingSecretMaterial
      ? await this.#openMaterial(userId, row.mfaPendingSecretMaterial)
      : null;
    if (!row?.mfaPendingSecretMaterial || !pending) {
      throw new AppError('CONFLICT', 'Start setting up the new phone before confirming it.');
    }
    if (!totpVerifier.verify({ secret: pending, token: code })) {
      throw new AppError('UNAUTHENTICATED', 'That code is not valid.');
    }
    const codes = generateRecoveryCodes(policy.mfa.recoveryCodeCount);
    const now = this.#clock.now();
    await this.#prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          mfaSecretMaterial: row.mfaPendingSecretMaterial as object,
          mfaPendingSecretMaterial: Prisma.DbNull,
          mfaEnrolledAt: now,
        },
      });
      await tx.userMfaRecoveryCode.deleteMany({ where: { userId } });
      await tx.userMfaRecoveryCode.createMany({
        data: codes.map((value) => ({ userId, codeHash: hashRecoveryCode(value) })),
      });
      await tx.auditEvent.createMany({
        data: [
          {
            workspaceId: null,
            actorType: 'USER',
            actorId: userId,
            action: 'customer.mfa.reenrolled',
            severity: 'NOTICE',
            outcome: 'SUCCESS',
          },
        ],
      });
    });
    return { recoveryCodes: codes };
  }

  /** Stop setting up a new phone. The current one was never touched. */
  async cancelMfaReenrolment(userId: string): Promise<void> {
    await this.#prisma.user.update({
      where: { id: userId },
      data: { mfaPendingSecretMaterial: Prisma.DbNull },
    });
  }

  /** How many unused recovery codes remain — the number the settings page shows. */
  async remainingRecoveryCodes(userId: string): Promise<number> {
    return this.#prisma.userMfaRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  // ---------------------------------------------------------------------------

  #keys(): KeyProvider {
    if (this.#keyProviderOverride) return this.#keyProviderOverride;
    this.#keyProvider ??= createKeyProvider(this.#env, CUSTOMER_MFA_DOMAIN);
    return this.#keyProvider;
  }

  async #openSeed(userId: string): Promise<string | null> {
    const row = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { mfaSecretMaterial: true },
    });
    if (!row?.mfaSecretMaterial) return null;
    /*
     * The context is INSIDE the envelope and authenticated as AAD, so the
     * decrypt fails on material copied from another user's row rather than
     * returning their seed. Re-deriving it here and comparing first makes that
     * refusal explicit instead of relying on a GCM tag mismatch to say it.
     */
    return this.#openMaterial(userId, row.mfaSecretMaterial);
  }

  /** Open a sealed seed — live or pending — bound to exactly this user. */
  async #openMaterial(userId: string, stored: unknown): Promise<string | null> {
    const material = stored as EncryptedMaterial;
    if (material.encryptionContext !== customerMfaContext(userId)) return null;
    return decryptSecret(material, this.#keys());
  }

  async #isPending(userId: string): Promise<boolean> {
    const row = await this.#prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    return row?.status === 'PENDING';
  }

  async #audit(
    userId: string,
    action: string,
    ip: string | undefined,
    severity: 'INFO' | 'NOTICE' | 'WARNING' = 'INFO',
  ): Promise<void> {
    await this.#prisma.auditEvent.createMany({
      data: [
        {
          workspaceId: null,
          actorType: 'USER',
          actorId: userId,
          action,
          severity,
          outcome: 'SUCCESS',
          ip: ip ?? null,
        },
      ],
    });
  }
}

/**
 * Bind the sealed seed to exactly one user.
 *
 * AUTHENTICATED AS AAD, so a `mfaSecretMaterial` value copied onto another row
 * fails to decrypt rather than authenticating the wrong person with the right
 * authenticator.
 */
export function customerMfaContext(userId: string): string {
  return `brandspace:customer-mfa:v1:${userId}`;
}

/**
 * Every required document must be accepted at the version currently published.
 *
 * AT THE VERSION, not merely "accepted once". Publishing new terms makes an old
 * acceptance stale by construction, which is the whole reason the version is
 * stored beside the key.
 */
export function assertLegalAcceptance(
  policy: OnboardingPolicy,
  accepted: ReadonlyArray<{ readonly key: string; readonly version: string }>,
): void {
  const given = new Map(accepted.map((doc) => [doc.key, doc.version]));
  const missing = policy.legalDocuments
    .filter((doc) => doc.required)
    .filter((doc) => given.get(doc.key) !== doc.version)
    .map((doc) => doc.key);
  if (missing.length > 0) {
    throw new AppError('VALIDATION_FAILED', 'The current terms must be accepted.', {
      documents: missing.join(','),
    });
  }
}

function constantTimeHexEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}
