/**
 * Provision a throwaway Platform Admin account for the end-to-end run.
 *
 * NO REAL CREDENTIAL IS INVOLVED, and none is committed. The password is
 * generated here, the TOTP seed is generated here and stored through the Secret
 * Service exactly as a real enrolment would be, and both are written to a
 * git-ignored file under test-results/ that exists only for the length of the
 * run. Nothing in this file is a secret before the script runs.
 *
 * This runs against the TEST database (.env.test) and refuses to run anywhere
 * that looks like production.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  PlatformAuthService,
  generateRecoveryCodes,
  generateTotpEnrolment,
  hashPassword,
} from '@brandspace/auth';
import { SecretService } from '@brandspace/secrets';
import { E2E_CREDENTIALS_FILE, loadE2eEnv, repoRoot, type E2eAdminCredentials } from './env';

loadE2eEnv();

const EMAIL = 'e2e-admin@brandspace.test';
const ENVIRONMENT = 'DEVELOPMENT' as const;
const MFA_SECRET_REF = `mfa-totp/platform/development/${EMAIL}`;

/**
 * Run the repository seed against the TEST database.
 *
 * Spawned rather than imported so there is exactly one seed implementation, and
 * so `NODE_ENV=test` can be set for the child without this process (or the
 * Playwright run) inheriting it. The seed is idempotent.
 */
function seedDatabase(): void {
  execFileSync('pnpm', ['--filter', '@brandspace/database', 'seed'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' },
  });
}

async function main(): Promise<void> {
  if (process.env['APP_ENV'] === 'production' || process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed an end-to-end admin account in a production environment.');
  }

  seedDatabase();

  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) {
    throw new Error(
      'DATABASE_PLATFORM_URL is not set, and the end-to-end admin account is platform-owned data.\n' +
        '  Set it in .env.test at the repository root (see .env.test.example).',
    );
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const secrets = new SecretService({ prisma });
  const auth = new PlatformAuthService({ prisma });

  try {
    const role = await prisma.role.findFirst({
      where: { key: 'platform_owner', workspaceId: null },
      include: { permissions: true },
    });
    if (!role || role.permissions.length === 0) {
      throw new Error(
        'The platform_owner role is missing or carries no permissions, so the Control Center ' +
          'would refuse every page.\n' +
          '  The repository seed builds the role and permission catalogue — it is run for you by ' +
          '`pnpm e2e:seed`, so this means that step did not complete.',
      );
    }

    // A fresh password and a fresh TOTP seed on every run: nothing is reused
    // between runs, so a leaked test-results/ file is worthless a minute later.
    const password = `e2e-${randomBytes(18).toString('base64url')}`;
    const enrolment = generateTotpEnrolment(EMAIL);
    const recoveryCodes = generateRecoveryCodes(3);

    // Upsert rather than delete-and-recreate: the account owns secrets and
    // configuration versions from previous runs, and deleting the row that
    // audit history points at would be exactly the kind of history rewrite the
    // platform is built to prevent.
    const passwordHash = await hashPassword(password);
    const user = await prisma.platformUser.upsert({
      where: { email: EMAIL },
      create: {
        email: EMAIL,
        name: 'End-to-end Platform Owner',
        status: 'ACTIVE',
        roleId: role.id,
        passwordHash,
        mfaEnabled: true,
        mfaSecretRef: MFA_SECRET_REF,
        mfaEnrolledAt: new Date(),
      },
      update: {
        status: 'ACTIVE',
        roleId: role.id,
        passwordHash,
        mfaEnabled: true,
        mfaSecretRef: MFA_SECRET_REF,
        mfaEnrolledAt: new Date(),
        failedLoginCount: 0,
      },
    });

    // The TOTP seed goes into the vault, encrypted, like every other secret.
    // A previous run's seed is ROTATED, never overwritten in place: that is the
    // only path the Secret Service offers, and the seed uses no other.
    const actor = { platformUserId: user.id, roleKey: 'platform_owner', mfaVerified: true };
    const existing = await prisma.secretRecord.findUnique({
      where: { ref_environment: { ref: MFA_SECRET_REF, environment: ENVIRONMENT } },
    });
    if (existing) {
      if (existing.status !== 'ACTIVE') {
        await secrets.enableSecret(actor, existing.id, 'Re-enabled for the end-to-end run');
      }
      await secrets.rotateSecret(
        actor,
        existing.id,
        enrolment.secret,
        'New TOTP seed for the end-to-end run',
      );
    } else {
      await secrets.createSecret(actor, {
        ref: MFA_SECRET_REF,
        name: 'End-to-end admin TOTP seed',
        category: 'mfa_totp',
        environment: ENVIRONMENT,
        value: enrolment.secret,
        description: 'Generated for the end-to-end suite. Not a real credential.',
      });
    }

    await auth.storeRecoveryCodes(user.id, recoveryCodes);

    const credentials: E2eAdminCredentials = {
      email: EMAIL,
      password,
      totpSecret: enrolment.secret,
      recoveryCode: recoveryCodes[0]!,
    };

    mkdirSync(path.dirname(E2E_CREDENTIALS_FILE), { recursive: true });
    writeFileSync(E2E_CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), { mode: 0o600 });

    // Deliberately prints no value — not the password, not the seed.
    console.log(`End-to-end admin account ready: ${EMAIL}`);
    console.log(`Credentials written to ${path.relative(process.cwd(), E2E_CREDENTIALS_FILE)}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
