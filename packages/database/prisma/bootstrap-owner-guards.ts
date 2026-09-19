/**
 * The refusals that stand between this command and a production database.
 *
 * SEPARATE FROM THE COMMAND ITSELF, and that is the point. Every guard here is
 * a pure function over an environment object, so each one can be proven to
 * refuse in a unit test without a database, a terminal or a running platform.
 * A guard that can only be exercised by actually bootstrapping production is a
 * guard nobody has ever seen fire.
 *
 * NOTHING IN THIS FILE PRINTS OR RETURNS A SECRET VALUE. Several of these
 * inspect passwords and keys; all of them describe what is wrong by NAME and
 * never by content, because this command runs in an SSH session whose scrollback
 * an operator may well paste into a chat window.
 */

/** Long enough that it cannot be a habit or a word. Matches the seed's rule. */
export const MIN_OWNER_PASSWORD_LENGTH = 16;

/**
 * Values that look like they came from an example file rather than from a
 * person. Matched case-insensitively as substrings, because
 * `REPLACE_WITH_A_STRONG_PASSWORD_1` is no better than `REPLACE_WITH`.
 *
 * This is the same list the development seed rejects, plus the markers
 * `assertProductionSafety` already refuses for deployment secrets — one rule,
 * so a value that would be refused at boot is also refused here.
 */
const PLACEHOLDER_MARKERS = [
  'replace_with',
  'replace-with',
  'changeme',
  'change-me',
  'change me',
  'placeholder',
  'example',
  'password123',
  'yourpassword',
  'brandspace-dev-owner',
  'devonly',
  'localhost',
  'ci-only',
  'test-only',
  'todo',
  'xxxx',
];

export class BootstrapRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapRefusal';
  }
}

/** Does this value look like it was copied out of an example file? */
export function looksLikePlaceholder(value: string): boolean {
  const lowered = value.trim().toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * The Platform Owner's password, checked without ever being echoed.
 *
 * WHY THE VALUE NEVER APPEARS IN A MESSAGE. This command is run over SSH. Its
 * output lands in a terminal, often in a scrollback buffer, sometimes in a
 * screenshot, occasionally in a support thread. An error that quoted the
 * rejected password would put the operator's second attempt one scroll away
 * from the first.
 */
export function assertUsableOwnerPassword(value: string): void {
  const trimmed = value.trim();

  if (trimmed === '') {
    throw new BootstrapRefusal('The password was empty. Nothing was written.');
  }
  if (trimmed.length < MIN_OWNER_PASSWORD_LENGTH) {
    throw new BootstrapRefusal(
      `The password must be at least ${MIN_OWNER_PASSWORD_LENGTH} characters. ` +
        'The value itself is deliberately not printed. Nothing was written.',
    );
  }
  if (looksLikePlaceholder(trimmed)) {
    throw new BootstrapRefusal(
      'The password looks like a placeholder from an example file. ' +
        'Choose a real one. The value itself is deliberately not printed. Nothing was written.',
    );
  }
}

/**
 * A deployment variable that must be present and must not be a template value.
 *
 * `assertProductionSafety` applies the same rule at boot. Repeating it here is
 * deliberate: this command runs BEFORE any service has started against the
 * database, so it cannot rely on a process that boots later having refused.
 */
function requireRealValue(env: NodeJS.ProcessEnv, name: string, why: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new BootstrapRefusal(`${name} is not set, and ${why}. Nothing was written.`);
  }
  if (looksLikePlaceholder(value)) {
    throw new BootstrapRefusal(
      `${name} still holds a placeholder value, and ${why}. ` +
        'The value itself is deliberately not printed. Nothing was written.',
    );
  }
  return value;
}

/**
 * An address that is plausibly a real mailbox.
 *
 * DELIBERATELY NOT A FULL RFC 5322 PARSER. The point is to catch a shell
 * mistake — an unexpanded `$VAR`, a stray quote, a flag that landed in the
 * wrong position — before it becomes the permanent identity of the account
 * that owns the platform. Anything subtler than that is the operator's to get
 * right, and they will see the address echoed before anything is written.
 */
function assertPlausibleEmail(value: string): void {
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value)) {
    throw new BootstrapRefusal(
      'BOOTSTRAP_PLATFORM_OWNER_EMAIL does not look like an email address. Nothing was written.',
    );
  }
  if (looksLikePlaceholder(value)) {
    throw new BootstrapRefusal(
      'BOOTSTRAP_PLATFORM_OWNER_EMAIL looks like a placeholder. Nothing was written.',
    );
  }
}

export interface BootstrapEnvironment {
  readonly ownerEmail: string;
}

/**
 * Refuse unless this is genuinely the production platform.
 *
 * WHY BOTH `APP_ENV` AND `NODE_ENV`. D-97 makes `APP_ENV` the deployment
 * environment because every built Next.js app sets `NODE_ENV=production`
 * regardless. That asymmetry is exactly why this command wants BOTH: `APP_ENV`
 * proves the deployment believes it is production, and `NODE_ENV` proves the
 * process was not started by a developer tool that left it at `development`.
 * Requiring both makes it hard to reach this code by accident from anywhere
 * else.
 *
 * WHY THE VAULT KEY IS CHECKED HERE RATHER THAN WHERE IT IS USED. The TOTP seed
 * is sealed with `SECRET_VAULT_KEK`. Discovering it is missing halfway through
 * would leave a Platform Owner with a password and no second factor — an
 * account that is worse than no account, because it looks finished.
 */
export function assertBootstrapEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapEnvironment {
  if (env['APP_ENV'] !== 'production') {
    throw new BootstrapRefusal(
      'This command bootstraps the PRODUCTION Platform Owner and refuses to run anywhere else. ' +
        'APP_ENV must be exactly "production" (D-97). Nothing was written.',
    );
  }
  if (env['NODE_ENV'] !== 'production') {
    throw new BootstrapRefusal(
      'NODE_ENV must be exactly "production" as well as APP_ENV. ' + 'Nothing was written.',
    );
  }

  requireRealValue(
    env,
    'DATABASE_PLATFORM_URL',
    'the Platform Owner, the roles and the permission catalogue are platform-owned rows that only the platform role may write',
  );
  requireRealValue(
    env,
    'SECRET_VAULT_KEK',
    'the owner’s TOTP seed is sealed with it and an unsealed seed must never be written',
  );

  const ownerEmail = requireRealValue(
    env,
    'BOOTSTRAP_PLATFORM_OWNER_EMAIL',
    'the Platform Owner is identified by their real address and it is never hard-coded',
  ).toLowerCase();
  assertPlausibleEmail(ownerEmail);

  return { ownerEmail };
}

/**
 * Refuse to disclose enrolment material unless a person is demonstrably reading.
 *
 * THE ONE-TIME DISCLOSURE IS THE WHOLE POINT OF ENROLMENT, and it is also the
 * single most dangerous line this command prints. A TOTP seed or a set of
 * recovery codes written into a captured log, a redirected file, a CI
 * transcript or a `tee` is a permanent second factor for whoever reads that
 * file — which defeats the second factor entirely.
 *
 * So the rule is: a real terminal, or nothing. There is deliberately NO
 * override flag. The development seed has one (`SEED_PRINT_MFA_ENROLMENT`)
 * because a developer occasionally needs the seed to work through a pipe; in
 * production the only correct response to "this is not a terminal" is to stop,
 * because the alternative is a credential in a log nobody can unsend.
 */
export function assertInteractiveDisclosure(stdoutIsTty: boolean, stdinIsTty: boolean): void {
  if (!stdoutIsTty || !stdinIsTty) {
    throw new BootstrapRefusal(
      'Refusing to bootstrap: this is not an interactive terminal.\n' +
        'Enrolment produces a TOTP seed and recovery codes that must be shown exactly once, to a\n' +
        'person. Printing them into a captured log, a pipe or a redirected file would leave a\n' +
        'permanent second factor somewhere searchable (CLAUDE.md §2.3).\n' +
        'Run this from an interactive shell — `railway ssh` attaches one. Nothing was written.',
    );
  }
}

/**
 * Refuse early if the platform vault cannot seal anything.
 *
 * WHY THIS IS CHECKED BEFORE A ROW IS WRITTEN. The owner's TOTP seed is sealed
 * through the Secret Service, which builds its key provider eagerly in the
 * constructor. `createKeyProvider` refuses the `SECRET_VAULT_KEK` provider when
 * `NODE_ENV=production` — that provider keeps the key beside the data it
 * protects — so a production process without `SECRET_VAULT_KMS_KEY_ARN` cannot
 * construct a `SecretService` at all.
 *
 * Discovering that halfway through would leave the owner row written and the
 * password set, with enrolment failing. MFA is mandatory for platform roles
 * (D-27), so that account would be unusable and unfixable by any other route.
 * Refusing up front leaves the database untouched.
 *
 * THE CONDITION IS NOT SPECIFIC TO THIS COMMAND. The same configuration stops
 * the Integrations Hub storing a provider credential and stops platform
 * sign-in resolving an owner's seed, so the message says so rather than
 * implying the bootstrap is at fault.
 */
export function assertVaultCanSeal(env: NodeJS.ProcessEnv = process.env): void {
  if (env['SECRET_VAULT_KMS_KEY_ARN']?.trim()) return;
  if (env['NODE_ENV'] !== 'production') return;

  throw new BootstrapRefusal(
    'Refusing to bootstrap: the platform secret vault cannot seal anything in this process.\n' +
      '\n' +
      'SECRET_VAULT_KEK alone drives the LOCAL DEVELOPMENT key provider, and that provider is\n' +
      'refused when NODE_ENV=production because it keeps the key in the same environment as\n' +
      'the data it protects. The owner’s TOTP seed would therefore fail to seal AFTER the\n' +
      'account had been created, leaving an owner with no second factor — and MFA is\n' +
      'mandatory for platform roles (D-27).\n' +
      '\n' +
      'This is a platform-wide condition, not a fault in this command: with this configuration\n' +
      'the Integrations Hub cannot store a provider credential either, and platform sign-in\n' +
      'cannot resolve an owner’s TOTP seed.\n' +
      '\n' +
      'Set SECRET_VAULT_KMS_KEY_ARN to the AWS KMS key for this environment, together with\n' +
      'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY scoped to that one key.\n' +
      'The full procedure is docs/RAILWAY-DEPLOYMENT.md §25.\n' +
      '\n' +
      'Nothing was written.',
  );
}

// ---------------------------------------------------------------------------
// The recovery state machine
// ---------------------------------------------------------------------------

/**
 * What state the Platform Owner account is in, and therefore what may be done
 * to it.
 *
 * WHY THIS IS A TOTAL FUNCTION OVER A SNAPSHOT rather than a chain of `if`s
 * inside the command. The first version of this command asked three separate
 * questions in three separate places — is there an owner, is MFA enabled, is
 * there a sealed seed — and acted on each in turn. That reads fine and hides a
 * real defect: with a seed already sealed and MFA not yet enabled, it took the
 * enrolment branch and called `createSecret` for a `ref` that already existed,
 * which conflicts on the unique index. The half-finished account could not be
 * finished by the only command able to finish it.
 *
 * Enumerating the states makes the gaps visible, makes each one testable
 * without a database, and makes "which states are dangerous" a question with a
 * written answer rather than an emergent one.
 */
export type OwnerState =
  /** No account, no seed. The ordinary first run. */
  | { readonly kind: 'absent' }
  /** The account exists but nothing has been sealed for it yet. */
  | { readonly kind: 'needs-enrolment' }
  /**
   * A seed is sealed and MFA was never enabled — the state a crash or a failed
   * code confirmation leaves behind. Resumable, and the id is what lets the
   * resume ROTATE the existing record instead of colliding with it.
   */
  | { readonly kind: 'enrolment-pending'; readonly secretId: string }
  /** MFA is complete and working; only the password was never set. */
  | { readonly kind: 'needs-password' }
  /** Nothing to do. */
  | { readonly kind: 'complete' }
  /**
   * Something that this command cannot have produced and must not repair by
   * guessing. Always a refusal.
   */
  | { readonly kind: 'inconsistent'; readonly reason: string };

export interface OwnerSnapshot {
  readonly owner: {
    readonly passwordHash: string | null;
    readonly mfaEnabled: boolean;
    readonly mfaSecretRef: string | null;
  } | null;
  readonly sealed: { readonly id: string; readonly status: string } | null;
  /** The `ref` this command would seal the seed under. */
  readonly expectedRef: string;
}

/**
 * Classify the account, fail-closed by default.
 *
 * THE RULE BEHIND EVERY `inconsistent` BELOW: an account whose MFA is ACTIVE is
 * never re-enrolled, never re-sealed and never repaired by this command. Doing
 * so would silently replace a working second factor — which is the difference
 * between a bootstrap and an account-takeover primitive. Every such state gets
 * a human instead.
 *
 * None of the reasons name the owner, the seed, the password or any value.
 */
export function classifyOwner({ owner, sealed, expectedRef }: OwnerSnapshot): OwnerState {
  if (owner === null) {
    if (sealed === null) return { kind: 'absent' };
    /*
     * A seed filed under an address no account holds. This command creates the
     * account BEFORE it seals anything, so it cannot have produced this — and
     * sealing a second seed over it, or adopting one whose provenance is
     * unknown, are both worse than stopping.
     */
    return {
      kind: 'inconsistent',
      reason:
        'a sealed MFA seed exists for this address but no Platform Owner account holds it. ' +
        'This command creates the account before it seals a seed, so it did not produce this ' +
        'state. Resolve the orphaned secret in the Control Center first.',
    };
  }

  if (owner.mfaEnabled) {
    if (owner.mfaSecretRef === null) {
      return {
        kind: 'inconsistent',
        reason: 'the account has MFA enabled with no seed reference recorded.',
      };
    }
    if (owner.mfaSecretRef !== expectedRef) {
      return {
        kind: 'inconsistent',
        reason:
          'the account has MFA enabled against a seed filed under a different reference than ' +
          'this command would use. Re-enrolling would replace a working second factor.',
      };
    }
    if (sealed === null) {
      return {
        kind: 'inconsistent',
        reason:
          'the account has MFA enabled but its sealed seed is not in the vault. Re-enrolling ' +
          'would replace a second factor the owner may still be using; recovering the account ' +
          'is a Control Center operation, not a bootstrap.',
      };
    }
    return owner.passwordHash === null ? { kind: 'needs-password' } : { kind: 'complete' };
  }

  // --- MFA is NOT enabled from here down. -----------------------------------

  if (owner.mfaSecretRef !== null) {
    /*
     * Enabling MFA and recording its reference happen in one write, so this
     * pair cannot diverge by accident. That it has diverged means something
     * else edited the row.
     */
    return {
      kind: 'inconsistent',
      reason: 'the account records a seed reference while MFA is switched off.',
    };
  }
  if (sealed === null) return { kind: 'needs-enrolment' };
  if (sealed.status !== 'ACTIVE') {
    return {
      kind: 'inconsistent',
      reason: `a seed is sealed for this address but is ${sealed.status.toLowerCase()} rather than active.`,
    };
  }
  return { kind: 'enrolment-pending', secretId: sealed.id };
}
