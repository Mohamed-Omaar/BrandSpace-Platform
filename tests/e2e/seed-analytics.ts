/**
 * Deterministic analytics for the end-to-end suite.
 *
 * WHY A FIXTURE AND NOT AN INGESTION RUN. Pulling real figures needs a platform
 * to ask, and every platform in this product requires business verification and
 * app review before it issues an analytics credential (D-18, D-19) — an
 * owner-driven process measured in weeks, and one this phase was told not to
 * start. So the suite seeds the PRECONDITION and tests the screens, which is
 * what it is a test of. The ingestion pipeline's own properties — idempotency,
 * out-of-order delivery, claim exclusivity, backoff — are settled against real
 * PostgreSQL in `tests/isolation/phase7-analytics-service.test.ts`, where they
 * can be.
 *
 * EVERY FIGURE IS FIXED, NOT RANDOM, and every window is an absolute date. A
 * chart seeded from `Math.random()` or from "today" renders differently on
 * every run, which turns a visual assertion into a coin toss and a numeric one
 * into a test nobody trusts.
 *
 * THE SOURCE IS MARKED `MOCK`, DELIBERATELY. The dashboard reads `sourceKind`
 * and shows the "this is sample data" banner, and asserting that banner is part
 * of the point: production must never ship demo numbers presented as real
 * (CLAUDE.md §4.1), and the honest way to keep that true is for the product to
 * SAY SO whenever a figure did not come from a platform.
 *
 * WRITTEN THROUGH THE TENANT CLIENT inside a workspace transaction, so RLS
 * applies to it exactly as it does to a real observation.
 *
 * Idempotent: keyed on a fixed prefix, so re-running replaces the fixture
 * rather than growing it.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { withWorkspace } from '@brandspace/database';
import { E2E_CREDENTIALS_FILE, loadE2eEnv, type E2eAdminCredentials } from './env';

loadE2eEnv();

/** The window the analytics screen opens on in the suite. Absolute, on purpose. */
const WINDOW_START = new Date('2026-09-01T00:00:00.000Z');
const DAYS = 14;

/** Marks every row this seed owns, so re-running replaces rather than appends. */
const SOURCE_VERSION = 'e2e-analytics-fixture-1';
const CAMPAIGN_KEY = 'e2e-analytics-campaign';

/**
 * Fixed daily figures, chosen so the screen has something to say.
 *
 * Impressions rise steadily and then step up sharply on the last two days, so
 * the trend line has a shape, the comparison has a direction, and the anomaly
 * detector has something real to find — rather than a flat series that renders
 * correctly and demonstrates nothing.
 */
const IMPRESSIONS = [
  1_200, 1_260, 1_190, 1_310, 1_280, 1_350, 1_400, 1_380, 1_420, 1_470, 1_510, 1_560, 3_900, 4_100,
];
const ENGAGEMENTS = [48, 52, 47, 55, 51, 58, 61, 59, 63, 66, 70, 74, 190, 205];
const REACH = [
  980, 1_020, 960, 1_070, 1_040, 1_100, 1_150, 1_130, 1_170, 1_210, 1_250, 1_290, 3_100, 3_250,
];

/** The same identity `observationKeyFor` computes. Kept in step deliberately. */
function observationKey(input: {
  workspaceId: string;
  socialConnectionId: string;
  subjectExternalId: string;
  metricKey: string;
  periodStart: Date;
}): string {
  return createHash('sha256')
    .update(
      [
        input.workspaceId,
        input.socialConnectionId,
        'ACCOUNT',
        input.subjectExternalId,
        input.metricKey,
        'DAY',
        input.periodStart.toISOString(),
      ].join('|'),
    )
    .digest('hex');
}

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

function platformClient(): PrismaClient {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function main(): Promise<void> {
  const tenantUrl = process.env['DATABASE_URL'];
  if (!tenantUrl) throw new Error('DATABASE_URL is required to seed the analytics fixture.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: tenantUrl }) });
  const platform = platformClient();

  try {
    const { customer } = credentials();
    /*
     * RESOLVING A WORKSPACE BY SLUG IS A PLATFORM QUESTION, and the tenant
     * client cannot answer it: with no workspace context set, RLS returns
     * nothing — the policy working rather than a problem with it.
     */
    const workspace = await platform.workspace.findFirst({
      where: { slug: customer.workspaceSlug },
      select: { id: true },
    });
    if (!workspace) {
      throw new Error(
        `No workspace with slug "${customer.workspaceSlug}". ` +
          'Run `tsx tests/e2e/seed-admin.ts` first.',
      );
    }
    const workspaceId = workspace.id;

    await withWorkspace(
      workspaceId,
      async (db) => {
        const connection = await db.socialConnection.findFirst({
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, brandId: true, externalAccountId: true, provider: true },
        });
        if (!connection) {
          throw new Error(
            'The end-to-end workspace has no connected account to attribute figures to. ' +
              'Run `tsx tests/e2e/seed-social.ts` first.',
          );
        }

        // RESET RATHER THAN ACCUMULATE, so the totals on the screen are the
        // same on the tenth run as on the first.
        await db.metricObservation.deleteMany({ where: { sourceVersion: SOURCE_VERSION } });

        /*
         * AND THE SAME RULE FOR THE AUTOMATION RULES THE SUITE AUTHORS.
         *
         * Seven of them are created per run — one per trigger and condition
         * shape the authoring form offers — and nothing removed them, so the
         * fixture brand accumulated seven more every time. `maxRulesPerBrand`
         * is twenty by configuration, so the third run in a row hit the
         * ceiling and every authoring test failed with a limit refusal that
         * had nothing to do with what it was testing.
         *
         * THE CEILING IS NOT THE BUG — it is the product working. The bug was
         * a fixture that grew without bound, and the fix is the one the
         * observations above already use.
         *
         * SCOPED TO THE `E2E ` PREFIX the suite names its own rules with, so a
         * rule a developer created by hand in the same workspace survives. The
         * runs and events beneath them go with them: both carry
         * `onDelete: Cascade` on the composite key.
         */
        await db.automationRule.deleteMany({ where: { name: { startsWith: 'E2E ' } } });

        const rows: {
          metricKey: string;
          values: readonly number[];
        }[] = [
          { metricKey: 'impressions', values: IMPRESSIONS },
          { metricKey: 'engagements', values: ENGAGEMENTS },
          { metricKey: 'reach', values: REACH },
        ];

        let written = 0;
        for (const { metricKey, values } of rows) {
          for (let day = 0; day < DAYS; day += 1) {
            const periodStart = new Date(WINDOW_START.getTime() + day * 86_400_000);
            const periodEnd = new Date(periodStart.getTime() + 86_400_000);
            await db.metricObservation.create({
              data: {
                workspaceId,
                brandId: connection.brandId,
                socialConnectionId: connection.id,
                provider: connection.provider,
                subjectType: 'ACCOUNT',
                subjectExternalId: connection.externalAccountId,
                metricKey,
                granularity: 'DAY',
                periodStart,
                periodEnd,
                value: BigInt(values[day] ?? 0),
                unit: 'COUNT',
                // DERIVED FROM THE WINDOW, so there is no clock in the fixture
                // and a run at midnight reads the same as one at noon.
                observedAt: periodEnd,
                // MARKED AS SAMPLE DATA. The dashboard says so, and the suite
                // asserts that it does.
                sourceKind: 'MOCK',
                sourceVersion: SOURCE_VERSION,
                observationKey: observationKey({
                  workspaceId,
                  socialConnectionId: connection.id,
                  subjectExternalId: connection.externalAccountId,
                  metricKey,
                  periodStart,
                }),
              },
            });
            written += 1;
          }
        }

        // A CURSOR, so the freshness banner has something to report rather than
        // rendering the "never synced" state over a screen full of figures.
        await db.analyticsIngestionCursor.deleteMany({
          where: { socialConnectionId: connection.id, subjectType: 'ACCOUNT', granularity: 'DAY' },
        });
        await db.analyticsIngestionCursor.create({
          data: {
            workspaceId,
            brandId: connection.brandId,
            socialConnectionId: connection.id,
            provider: connection.provider,
            subjectType: 'ACCOUNT',
            granularity: 'DAY',
            lastCoveredPeriodEnd: new Date(WINDOW_START.getTime() + DAYS * 86_400_000),
            lastSucceededAt: new Date(),
            lastAttemptedAt: new Date(),
            nextAttemptAt: new Date(Date.now() + 3 * 60 * 60 * 1_000),
            freshness: 'FRESH',
          },
        });

        // A campaign, so the Copilot journey has one to list and the analytics
        // filter has one to offer.
        const campaign = await db.campaign.findFirst({
          where: { idempotencyKey: CAMPAIGN_KEY },
          select: { id: true },
        });
        if (!campaign) {
          await db.campaign.create({
            data: {
              workspaceId,
              brandId: connection.brandId,
              name: 'Autumn Launch',
              objective: 'AWARENESS',
              status: 'ACTIVE',
              channels: ['LINKEDIN'],
              idempotencyKey: CAMPAIGN_KEY,
            },
          });
        }

        console.log(`✔ ${written} sample observations across ${DAYS} days, marked as MOCK`);
        console.log(`  Window: ${WINDOW_START.toISOString().slice(0, 10)} + ${DAYS} days`);
        console.log('  No real credential and no real platform figure was used.');
      },
      { prisma },
    );
  } finally {
    await prisma.$disconnect();
    await platform.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
