import { describe, expect, it } from 'vitest';
import {
  BootstrapRefusal,
  MIN_OWNER_PASSWORD_LENGTH,
  assertBootstrapEnvironment,
  assertInteractiveDisclosure,
  assertUsableOwnerPassword,
  assertVaultCanSeal,
  looksLikePlaceholder,
} from '../../packages/database/prisma/bootstrap-owner-guards';

/**
 * THE REFUSALS, EXERCISED WITHOUT A PRODUCTION DATABASE.
 *
 * Every guard the production Platform Owner bootstrap depends on is a pure
 * function over an environment object, precisely so that each one can be seen
 * to fire here rather than only on the day somebody runs the command against a
 * live platform. A guard whose refusal has never been observed is a guard
 * nobody knows the shape of.
 *
 * NO REAL VALUE APPEARS IN THIS FILE. The passwords below are deliberately
 * obvious fixtures, and several assertions check that the guard did NOT echo
 * what it rejected.
 */

/** A complete, plausible production environment. Individual tests break one thing. */
function productionEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    APP_ENV: 'production',
    NODE_ENV: 'production',
    DATABASE_PLATFORM_URL: 'postgresql://brandspace_platform:pw@db.internal:5432/brandspace',
    SECRET_VAULT_KEK: 'k'.repeat(48),
    SECRET_VAULT_KMS_KEY_ARN: 'arn:aws:kms:eu-west-1:000000000000:key/abc',
    BOOTSTRAP_PLATFORM_OWNER_EMAIL: 'owner@brandspace.test',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('the bootstrap refuses to run outside production', () => {
  it('accepts a complete production environment', () => {
    expect(assertBootstrapEnvironment(productionEnv()).ownerEmail).toBe('owner@brandspace.test');
  });

  it('refuses when APP_ENV is not production', () => {
    /*
     * D-97: APP_ENV is the deployment environment. A command that writes the
     * account owning the platform must not be reachable from a staging shell.
     */
    expect(() => assertBootstrapEnvironment(productionEnv({ APP_ENV: 'staging' }))).toThrow(
      BootstrapRefusal,
    );
    expect(() => assertBootstrapEnvironment(productionEnv({ APP_ENV: undefined }))).toThrow(
      /APP_ENV/,
    );
  });

  it('refuses when NODE_ENV is not production, even if APP_ENV says it is', () => {
    /*
     * BOTH, because the two disagree for a real reason: every built Next.js app
     * sets NODE_ENV=production regardless of deployment. Requiring both makes
     * this hard to reach by accident from a developer tool.
     */
    expect(() => assertBootstrapEnvironment(productionEnv({ NODE_ENV: 'development' }))).toThrow(
      /NODE_ENV/,
    );
  });

  it('refuses without the platform database identity', () => {
    expect(() =>
      assertBootstrapEnvironment(productionEnv({ DATABASE_PLATFORM_URL: undefined })),
    ).toThrow(/DATABASE_PLATFORM_URL/);
  });

  it('refuses a placeholder database URL rather than connecting to it', () => {
    expect(() =>
      assertBootstrapEnvironment(
        productionEnv({ DATABASE_PLATFORM_URL: 'postgresql://replace_with_real@localhost/db' }),
      ),
    ).toThrow(/placeholder/i);
  });

  it('refuses a placeholder vault key', () => {
    expect(() =>
      assertBootstrapEnvironment(
        productionEnv({ SECRET_VAULT_KEK: 'change-me-please-0000000000' }),
      ),
    ).toThrow(/placeholder/i);
  });

  it('never echoes a rejected value', () => {
    const secret = 'placeholder-do-not-print-me-12345';
    try {
      assertBootstrapEnvironment(productionEnv({ SECRET_VAULT_KEK: secret }));
      expect.unreachable('should have refused');
    } catch (error: unknown) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe('the owner address comes from the environment, never from source', () => {
  it('refuses when it is absent', () => {
    expect(() =>
      assertBootstrapEnvironment(productionEnv({ BOOTSTRAP_PLATFORM_OWNER_EMAIL: undefined })),
    ).toThrow(/BOOTSTRAP_PLATFORM_OWNER_EMAIL/);
  });

  it('refuses something that is not an address', () => {
    // The shape a shell mistake takes: an unexpanded variable, a stray flag.
    for (const bad of ['$OWNER_EMAIL', '--email', 'owner@localhost', 'owner at example.com']) {
      expect(() =>
        assertBootstrapEnvironment(productionEnv({ BOOTSTRAP_PLATFORM_OWNER_EMAIL: bad })),
      ).toThrow(BootstrapRefusal);
    }
  });

  it('refuses a documentation address, which is what an unedited template leaves', () => {
    /*
     * FOUND BY THIS SUITE'S OWN FIXTURE, which originally used
     * `owner@brandspace.example` and was refused. That is the guard working:
     * `example` is exactly the marker an operator leaves behind when they copy
     * a command out of a document and forget the one field that matters.
     */
    for (const templated of ['owner@example.com', 'admin@example.org']) {
      expect(() =>
        assertBootstrapEnvironment(productionEnv({ BOOTSTRAP_PLATFORM_OWNER_EMAIL: templated })),
      ).toThrow(/placeholder/i);
    }
  });

  it('lowercases it, so the account identity is stable', () => {
    const { ownerEmail } = assertBootstrapEnvironment(
      productionEnv({ BOOTSTRAP_PLATFORM_OWNER_EMAIL: 'Owner@BrandSpace.Test' }),
    );
    expect(ownerEmail).toBe('owner@brandspace.test');
  });
});

describe('the password is checked without ever being echoed', () => {
  it('accepts a real one', () => {
    expect(() => assertUsableOwnerPassword('correct-horse-battery-staple-9')).not.toThrow();
  });

  it('refuses an empty password', () => {
    expect(() => assertUsableOwnerPassword('   ')).toThrow(/empty/i);
  });

  it(`refuses anything shorter than ${MIN_OWNER_PASSWORD_LENGTH} characters`, () => {
    expect(() => assertUsableOwnerPassword('short-one-123')).toThrow(
      new RegExp(String(MIN_OWNER_PASSWORD_LENGTH)),
    );
  });

  it('refuses a placeholder even when it is long enough', () => {
    /*
     * LENGTH IS NOT STRENGTH. `REPLACE_WITH_A_STRONG_PASSWORD_1` clears any
     * length floor and is a known credential everywhere the example file went.
     */
    expect(() => assertUsableOwnerPassword('REPLACE_WITH_A_STRONG_PASSWORD_1')).toThrow(
      /placeholder/i,
    );
    expect(() => assertUsableOwnerPassword('ChangeMe-ChangeMe-ChangeMe')).toThrow(/placeholder/i);
  });

  it('never puts the rejected password in the message', () => {
    for (const bad of ['short', 'placeholder-but-long-enough-here']) {
      try {
        assertUsableOwnerPassword(bad);
        expect.unreachable('should have refused');
      } catch (error: unknown) {
        expect(String(error)).not.toContain(bad);
      }
    }
  });

  it('recognises the markers an example file leaves behind', () => {
    expect(looksLikePlaceholder('Replace_With_Something')).toBe(true);
    expect(looksLikePlaceholder('an-ordinary-passphrase')).toBe(false);
  });
});

describe('enrolment material is never disclosed to a non-terminal', () => {
  it('allows a real interactive terminal', () => {
    expect(() => assertInteractiveDisclosure(true, true)).not.toThrow();
  });

  it('refuses when stdout is redirected', () => {
    /*
     * A TOTP seed in a captured log is a permanent second factor for whoever
     * can read that file, which defeats the second factor entirely. There is
     * deliberately no override flag here, unlike the development seed.
     */
    expect(() => assertInteractiveDisclosure(false, true)).toThrow(/interactive terminal/i);
  });

  it('refuses when stdin is not a terminal either', () => {
    expect(() => assertInteractiveDisclosure(true, false)).toThrow(/interactive terminal/i);
  });
});

describe('the vault must be able to seal before anything is written', () => {
  it('allows production when a KMS key is configured', () => {
    expect(() => assertVaultCanSeal(productionEnv())).not.toThrow();
  });

  it('refuses production when only a KEK is configured', () => {
    /*
     * The condition that would otherwise surface halfway through: the owner
     * created, the password set, and enrolment failing because
     * `createKeyProvider` refuses the development provider in production.
     */
    expect(() =>
      assertVaultCanSeal(productionEnv({ SECRET_VAULT_KMS_KEY_ARN: undefined })),
    ).toThrow(/cannot seal/i);
  });

  it('names the remedy rather than just the symptom', () => {
    try {
      assertVaultCanSeal(productionEnv({ SECRET_VAULT_KMS_KEY_ARN: undefined }));
      expect.unreachable('should have refused');
    } catch (error: unknown) {
      const message = String(error);
      expect(message).toContain('SECRET_VAULT_KMS_KEY_ARN');
      // And says it is not this command's fault, so an operator looks in the
      // right place.
      expect(message).toContain('Integrations Hub');
      expect(message).toContain('Nothing was written.');
    }
  });

  it('does not interfere outside production', () => {
    expect(() =>
      assertVaultCanSeal({ NODE_ENV: 'development', SECRET_VAULT_KEK: 'k' } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
