/**
 * Activate a FIXTURE commercial catalogue, so the Phase 9 journey can be walked.
 *
 * WHY THIS SEED EXISTS AND `seed-quotas` DELIBERATELY DOES NOT DO IT. That seed
 * refuses to write a plan or a price, and it is right: D-06 and D-07 settled the
 * REAL plan names and prices, and CLAUDE.md §2.2 keeps approved commercial values
 * out of the repository. Phase 9 cannot be exercised without SOME catalogue — a
 * checkout with no price is not a checkout — so this writes an obviously fake one
 * and says so in every place a reader could mistake it.
 *
 * THE DISTINCTION THAT MAKES IT ACCEPTABLE. A fixture is not an approved value.
 * `Fixture Starter` at `99.00 SAR` is not a plan anybody may sell; it exists to
 * prove that a price set by an owner travels intact from configuration to a
 * checkout to an invoice. The values live in `tests/support/*-fixture.ts`, shared
 * with the unit and isolation suites so all three reason about the same
 * configured world, and nothing under `packages/` or `apps/` contains any of them.
 *
 * IT WEAKENS NO VALIDATION. Every document goes through `ConfigurationService`:
 * the same schema parse, the same cross-domain semantic validation and the same
 * high-impact acknowledgement an activation from Platform Admin runs.
 *
 * IT DOES NOT RUN ANYWHERE THAT LOOKS LIKE PRODUCTION. Two independent guards,
 * and both must pass.
 *
 * Idempotent: re-running activates a fresh version of the same payload.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ConfigurationService, type ConfigActor, type Environment } from '@brandspace/config';
import { loadE2eEnv } from './env';
import { CATALOGUE } from '../support/commerce-fixture';
import { PLANS_FIXTURE } from '../support/plans-fixture';

loadE2eEnv();

const ENVIRONMENT: Environment = 'DEVELOPMENT';
const REASON = 'Development fixture: a fake commercial catalogue so Phase 9 can be exercised.';

/**
 * The onboarding rules the signup form and the checklist read.
 *
 * NO COUNTRY, LOCALE, TIMEZONE OR CURRENCY (D-194) — onboarding asks for all
 * four, and a default here would be exactly the assumption that decision
 * removed. The legal document is a fixture: a version string, not a document.
 */
const ONBOARDING_FIXTURE = {
  signup: {
    open: true,
    minPasswordLength: 12,
    verificationTtlMinutes: 1_440,
    verificationResendCooldownSeconds: 30,
    verificationsPerHour: 20,
  },
  legalDocuments: [
    {
      key: 'terms-of-service',
      title: { ar: 'شروط الخدمة', en: 'Terms of service' },
      version: 'fixture-2026-09-01',
      url: null,
      required: true,
    },
  ],
  mfa: { customerEnrolmentEnabled: true, requiredForCustomers: false, recoveryCodeCount: 10 },
  steps: [
    { key: 'workspace', required: true, sortOrder: 0 },
    { key: 'brand', required: true, sortOrder: 1 },
    { key: 'brand_profile', required: false, sortOrder: 2 },
    { key: 'brand_brain', required: false, sortOrder: 3 },
    { key: 'social', required: false, sortOrder: 4 },
    { key: 'team', required: false, sortOrder: 5 },
    { key: 'plan', required: true, sortOrder: 6 },
  ],
} as const;

function assertNotProduction(): void {
  if ((process.env['APP_ENV'] ?? 'development') === 'production') {
    throw new Error('This seed refuses to run against a production deployment.');
  }
  const url = process.env['DATABASE_PLATFORM_URL'] ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error('This seed refuses to run against a non-local database.');
  }
}

function platformClient(): PrismaClient {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** A REAL platform actor with the REAL permissions of the role it holds. */
async function actorFor(prisma: PrismaClient): Promise<ConfigActor> {
  const owner = await prisma.platformUser.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, roleId: true },
  });
  if (!owner) {
    throw new Error('No platform user exists. Run the database seed first (pnpm db:seed).');
  }
  const grants = await prisma.rolePermission.findMany({
    where: { roleId: owner.roleId },
    include: { permission: true },
  });
  return {
    platformUserId: owner.id,
    roleKey: 'platform_owner',
    mfaVerified: true,
    permissionKeys: grants.map((grant) => grant.permission.key),
  };
}

async function activate(
  configuration: ConfigurationService,
  actor: ConfigActor,
  domain: 'commerce' | 'onboarding' | 'plans',
  payload: Record<string, unknown>,
): Promise<void> {
  const draft = await configuration.createDraft(actor, domain, ENVIRONMENT, REASON, payload);
  const report = await configuration.validateDraft(actor, draft.id);
  if (!report.valid) {
    throw new Error(
      `The ${domain} fixture failed validation: ${report.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
  console.log(`  ✔ ${domain}`);
}

async function main(): Promise<void> {
  assertNotProduction();

  const prisma = platformClient();
  try {
    const actor = await actorFor(prisma);
    const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });

    console.log('› activating the FIXTURE commercial catalogue (development only) …');

    // `plans` first: `commerce` markets name plan keys, and the cross-domain
    // validation reads them.
    await activate(
      configuration,
      actor,
      'plans',
      PLANS_FIXTURE as unknown as Record<string, unknown>,
    );
    await activate(
      configuration,
      actor,
      'commerce',
      CATALOGUE as unknown as Record<string, unknown>,
    );
    await activate(
      configuration,
      actor,
      'onboarding',
      ONBOARDING_FIXTURE as unknown as Record<string, unknown>,
    );

    console.log('\n✔ a fake catalogue is active in DEVELOPMENT.');
    console.log('  Nothing here is an approved plan, price, market or tax rate.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
