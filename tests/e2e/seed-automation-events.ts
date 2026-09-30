/**
 * DEVELOPMENT FIXTURE — the analytics events' operator thresholds (Phase 2B-3
 * PR 4).
 *
 * WHAT PROBLEM THIS SOLVES. `WEEKLY_ENGAGEMENT_DROPPED` and
 * `POST_TOP_10_PERCENT` read thresholds that have NO default (report §30): on a
 * fresh database neither event is evaluated and the Automations screen shows
 * both as not available yet. The end-to-end suite authors rules on them, so it
 * needs an environment where an operator has set them.
 *
 * WHAT IT DOES NOT DO. These numbers are test data for the local end-to-end
 * database, not a product default — production has none, and an operator sets
 * its own from Platform Admin. It goes through `ConfigurationService` (draft,
 * validate, activate) exactly as an operator's change would, which also writes
 * the tenant-readable snapshot the dashboard reads; it keeps every other
 * automations setting as it is, leaves a threshold that is already set alone,
 * and refuses production and non-local databases.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ConfigurationService, type ConfigActor, type Environment } from '@brandspace/config';
import { loadE2eEnv } from './env';

loadE2eEnv();

const ENVIRONMENT: Environment = 'DEVELOPMENT';
const REASON = 'Development fixture: set the analytics event thresholds for the end-to-end suite.';

const FIXTURE_EVENTS = {
  weeklyEngagementDrop: { minBaseline: 100 },
  topPost: { populationDays: 30, minImpressions: 100, minPopulation: 10 },
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

/** A real platform user with the permissions its role actually holds. */
async function actorFor(prisma: PrismaClient): Promise<ConfigActor> {
  const owner = await prisma.platformUser.findFirst({
    where: { deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, roleId: true },
  });
  if (!owner) throw new Error('No platform user exists. Run the database seed first.');
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

async function main(): Promise<void> {
  assertNotProduction();
  const prisma = platformClient();
  try {
    const actor = await actorFor(prisma);
    const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });
    console.log('› setting the analytics event thresholds (development only) …');

    const current = await configuration.get('automations', ENVIRONMENT);
    // An operator's value wins over the fixture's.
    const events = {
      weeklyEngagementDrop: {
        ...FIXTURE_EVENTS.weeklyEngagementDrop,
        ...current.events.weeklyEngagementDrop,
      },
      topPost: { ...FIXTURE_EVENTS.topPost, ...current.events.topPost },
    };
    if (JSON.stringify(events) === JSON.stringify(current.events)) {
      console.log('✔ already set; nothing to do');
      return;
    }

    const draft = await configuration.createDraft(actor, 'automations', ENVIRONMENT, REASON, {
      ...current,
      events,
    });
    const report = await configuration.validateDraft(actor, draft.id);
    if (!report.valid) {
      throw new Error(
        `The automation events fixture failed validation: ${report.issues
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
    console.log('\n✔ weekly engagement drop and top 10% thresholds set');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
