/**
 * DEVELOPMENT FIXTURE — a holiday, an observance, an industry and suggested
 * posting times, so the G6 calendar (D-329) can be proven in a browser.
 *
 * EVERY VALUE IS A FIXTURE, NAMED AS ONE. The real lists are operator
 * configuration and ship EMPTY; the Egypt / Saudi Arabia / UAE draft in
 * docs/CALENDAR-OBSERVANCES-DRAFT.md is unverified and is NOT loaded here or
 * anywhere. The fixture day is three days after the seed runs, in the fixture
 * workspaces' country (US), so it is always ahead of "today". The suggested
 * times start at 09:00 — the calendar's ordinary default — so no other suite's
 * proposed time moves.
 *
 * Through `ConfigurationService` (draft, validate, activate) exactly as an
 * operator would; adds to the active documents; refuses production and
 * non-local databases.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { ConfigurationService, type ConfigActor, type Environment } from '@brandspace/config';
import { loadE2eEnv } from './env';

loadE2eEnv();

const ENVIRONMENT: Environment = 'DEVELOPMENT';
const REASON =
  'Development fixture: a holiday, an observance and suggested times for the calendar.';
export const FIXTURE_HOLIDAY = { en: 'E2E Fixture Holiday', ar: 'عطلة اختبارية' } as const;
export const FIXTURE_INDUSTRY = 'e2e-fixture-industry';

function assertNotProduction(): void {
  if ((process.env['APP_ENV'] ?? 'development') === 'production') {
    throw new Error('This seed refuses to run against a production deployment.');
  }
  const url = process.env['DATABASE_PLATFORM_URL'] ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error('This seed refuses to run against a non-local database.');
  }
}

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

async function activate(
  configuration: ConfigurationService,
  actor: ConfigActor,
  domain: 'content' | 'onboarding',
  payload: Record<string, unknown>,
): Promise<void> {
  const draft = await configuration.createDraft(actor, domain, ENVIRONMENT, REASON, payload);
  const report = await configuration.validateDraft(actor, draft.id);
  if (!report.valid) {
    throw new Error(
      `The calendar fixture failed validation: ${report.issues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
}

async function main(): Promise<void> {
  assertNotProduction();
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const actor = await actorFor(prisma);
    const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });
    console.log('› adding the calendar fixture (development only) …');

    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const content = await configuration.get('content', ENVIRONMENT);
    await activate(configuration, actor, 'content', {
      ...content,
      calendar: {
        ...content.calendar,
        holidays: [
          ...content.calendar.holidays.filter((row) => row.name.en !== FIXTURE_HOLIDAY.en),
          { country: 'US', date: day, name: { ...FIXTURE_HOLIDAY } },
        ],
        observances: [
          ...content.calendar.observances.filter((row) => row.industry !== FIXTURE_INDUSTRY),
          {
            industry: FIXTURE_INDUSTRY,
            date: day,
            name: { en: 'E2E Fixture Observance', ar: 'مناسبة اختبارية' },
          },
        ],
        suggestedTimes: [
          ...content.calendar.suggestedTimes.filter((row) => row.country !== 'US'),
          { country: 'US', times: ['09:00', '13:00', '18:00'] },
        ],
      },
    });

    const onboarding = await configuration.get('onboarding', ENVIRONMENT);
    if (!onboarding.industries.some((industry) => industry.key === FIXTURE_INDUSTRY)) {
      await activate(configuration, actor, 'onboarding', {
        ...onboarding,
        industries: [
          ...onboarding.industries,
          {
            key: FIXTURE_INDUSTRY,
            name: { en: 'E2E fixture industry', ar: 'قطاع اختباري' },
            offersQuestionSet: 'general',
          },
        ],
      });
    }
    console.log(`✔ fixture holiday on ${day} (US); suggested times 09:00, 13:00, 18:00`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
