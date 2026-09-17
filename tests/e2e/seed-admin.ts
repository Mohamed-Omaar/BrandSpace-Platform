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
  InvitationService,
  PlatformAuthService,
  WorkspaceAdminService,
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
    const actor = {
      platformUserId: user.id,
      roleKey: 'platform_owner',
      mfaVerified: true,
      // The account's real permissions, read back from the role it was given.
      permissionKeys: role.permissions.length
        ? await prisma.rolePermission
            .findMany({ where: { roleId: role.id }, include: { permission: true } })
            .then((rows) => rows.map((r) => r.permission.key))
        : [],
    };
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

    // --- Phase 2B: a throwaway CUSTOMER estate ---------------------------
    //
    // Provisioned through the SAME services the Control Center uses, so the
    // suite exercises the real code path rather than hand-built rows. Two
    // workspaces (so switching is testable), an owner, a read-only viewer and
    // one live invitation.
    const customer = await seedCustomerEstate(prisma, actor);

    const credentials: E2eAdminCredentials = {
      email: EMAIL,
      password,
      totpSecret: enrolment.secret,
      recoveryCode: recoveryCodes[0]!,
      customer,
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

/**
 * Provision the customer estate for the run.
 *
 * Idempotent by slug, and every password is generated here. Nothing in this
 * function is a credential before it runs.
 */
async function seedCustomerEstate(
  prisma: PrismaClient,
  actor: {
    platformUserId: string;
    roleKey: string;
    mfaVerified: boolean;
    permissionKeys: readonly string[];
  },
): Promise<E2eAdminCredentials['customer']> {
  const workspaces = new WorkspaceAdminService({ prisma });
  const invitations = new InvitationService({ prisma });

  const ownerEmail = 'e2e-owner@brandspace.test';
  const viewerEmail = 'e2e-viewer@brandspace.test';
  const invitedEmail = 'e2e-invitee@brandspace.test';
  const password = `e2e-${randomBytes(18).toString('base64url')}`;
  const viewerPassword = `e2e-${randomBytes(18).toString('base64url')}`;

  const primarySlug = 'e2e-primary';
  const secondSlug = 'e2e-secondary';

  for (const [slug, name] of [
    [primarySlug, 'E2E Primary Workspace'],
    [secondSlug, 'E2E Secondary Workspace'],
  ] as const) {
    const existing = await prisma.workspace.findUnique({ where: { slug } });
    if (!existing) {
      await workspaces.create(actor, {
        name,
        slug,
        ownerEmail,
        ownerName: 'E2E Workspace Owner',
        /*
         * EXPLICIT (D-194). A fixture states where its workspace is rather than
         * inheriting a platform assumption, because there is no longer one to
         * inherit — and a fixture that silently took `SA`/`SAR` was part of how
         * the assumption stayed invisible.
         */
        country: 'US',
        timezone: 'UTC',
        currency: 'USD',
        defaultLocale: 'EN',
      });
    }
  }

  const primary = await prisma.workspace.findUniqueOrThrow({ where: { slug: primarySlug } });
  const secondary = await prisma.workspace.findUniqueOrThrow({ where: { slug: secondSlug } });

  const ownerRole = await prisma.role.findFirstOrThrow({
    where: { key: 'workspace_owner', workspaceId: null },
  });
  const viewerRole = await prisma.role.findFirstOrThrow({
    where: { key: 'client_viewer', workspaceId: null },
  });

  // The owner: ACTIVE, with a fresh password, and an ACTIVE membership in both
  // workspaces so the switcher has something to switch between.
  const owner = await prisma.user.update({
    where: { email: ownerEmail },
    data: {
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(password),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  for (const workspaceId of [primary.id, secondary.id]) {
    await prisma.membership.upsert({
      where: { workspaceId_userId: { workspaceId, userId: owner.id } },
      create: {
        workspaceId,
        userId: owner.id,
        roleId: ownerRole.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
      update: { status: 'ACTIVE', roleId: ownerRole.id, acceptedAt: new Date() },
    });
  }

  // A read-only member of the primary workspace, for the RBAC assertions.
  const viewer = await prisma.user.upsert({
    where: { email: viewerEmail },
    create: {
      email: viewerEmail,
      name: 'E2E Viewer',
      status: 'ACTIVE',
      timezone: 'UTC',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(viewerPassword),
    },
    update: {
      status: 'ACTIVE',
      passwordHash: await hashPassword(viewerPassword),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });
  await prisma.membership.upsert({
    where: { workspaceId_userId: { workspaceId: primary.id, userId: viewer.id } },
    create: {
      workspaceId: primary.id,
      userId: viewer.id,
      roleId: viewerRole.id,
      status: 'ACTIVE',
      acceptedAt: new Date(),
      brandScope: [],
    },
    update: { status: 'ACTIVE', roleId: viewerRole.id },
  });

  // One live invitation. Any earlier pending one is revoked first, because the
  // partial unique index allows only a single PENDING row per address.
  await prisma.invitation.updateMany({
    where: { workspaceId: primary.id, email: invitedEmail, status: 'PENDING' },
    data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'Replaced for a new run' },
  });
  await prisma.membership.deleteMany({
    where: { workspaceId: primary.id, user: { email: invitedEmail } },
  });
  const issued = await invitations.create({
    workspaceId: primary.id,
    email: invitedEmail,
    roleId: viewerRole.id,
    inviter: {
      kind: 'platform',
      platformUserId: actor.platformUserId,
      permissionKeys: actor.permissionKeys,
      mfaVerified: actor.mfaVerified,
    },
  });

  // The invitee needs an account to accept with: acceptance binds an
  // invitation to a PROVEN identity, never to whoever opened the link.
  await prisma.user.upsert({
    where: { email: invitedEmail },
    create: {
      email: invitedEmail,
      name: 'E2E Invitee',
      status: 'ACTIVE',
      timezone: 'UTC',
      emailVerifiedAt: new Date(),
      passwordHash: await hashPassword(password),
    },
    update: {
      status: 'ACTIVE',
      passwordHash: await hashPassword(password),
      failedLoginCount: 0,
      lockedUntil: null,
    },
  });

  /*
   * A SECOND INVITATION, TO AN ADDRESS WITH NO ACCOUNT AT ALL — A-2.
   *
   * The one above pre-creates the invitee's `User`, and that pre-creation was
   * itself the defect: the product had no way for a genuinely new invitee to
   * establish an identity, so the suite quietly supplied one and the dead end
   * went unnoticed.
   *
   * This address is fresh per run and deliberately has NO user row, no
   * membership and no password. The only thing seeded is the invitation
   * itself, because the raw token cannot be recovered afterwards — the
   * database stores a hash, and the outbox redacts it. Everything else the
   * onboarding journey needs, it must create for itself.
   */
  const newcomerEmail = `e2e-newcomer-${Date.now()}@brandspace.test`;
  const newcomerInvitation = await invitations.create({
    workspaceId: primary.id,
    email: newcomerEmail,
    roleId: viewerRole.id,
    inviter: {
      kind: 'platform',
      platformUserId: actor.platformUserId,
      permissionKeys: actor.permissionKeys,
      mfaVerified: actor.mfaVerified,
    },
  });

  return {
    email: ownerEmail,
    password,
    workspaceSlug: primarySlug,
    workspaceName: 'E2E Primary Workspace',
    secondWorkspaceSlug: secondSlug,
    viewerEmail,
    viewerPassword,
    invitationToken: issued.token,
    invitedEmail,
    newcomerToken: newcomerInvitation.token,
    newcomerEmail,
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
