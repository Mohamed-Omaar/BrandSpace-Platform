/**
 * One schedulable draft, so the Content Calendar's end-to-end suite has
 * something real to plan.
 *
 * WHY A FIXTURE AND NOT A GENERATION. The calendar refuses a draft with no
 * caption — a plan to publish nothing is not a plan — so its suite needs a
 * draft that HAS one. The obvious way to make one is through the Content
 * Studio, and that does not work here: no provider is selected (D-13), and the
 * mock adapter SELECTS retrieved material rather than generating, so it does
 * not produce the JSON envelope the studio's schema requires. In a browser the
 * grounded path therefore reaches AC-11.9's refusal, which is correct behaviour
 * and leaves no variant behind.
 *
 * Relaxing the parser so prose became a draft is exactly what AC-11.9 forbids,
 * and skipping the calendar's scheduling test would mean AC-14.1 had no
 * end-to-end proof at all. So the PRECONDITION is seeded and the test exercises
 * the calendar, which is what it is a test of.
 *
 * WHAT IT WRITES: one `ContentItem` in DRAFT with one `ContentVariant`, in the
 * end-to-end customer's own workspace, through the TENANT client inside a
 * workspace transaction — so RLS applies to it exactly as it does to a real
 * draft, and a mistake here fails rather than writing across a tenant.
 *
 * Idempotent: keyed on a fixed idempotency key, so re-running finds the same
 * draft rather than growing the library on every seed.
 */
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { withWorkspace } from '@brandspace/database';
import { E2E_CREDENTIALS_FILE, loadE2eEnv, type E2eAdminCredentials } from './env';

loadE2eEnv();

const IDEMPOTENCY_KEY = 'e2e-calendar-fixture';
const TITLE = 'Seasonal note';

function assertNotProduction(): void {
  if ((process.env['APP_ENV'] ?? 'development') === 'production') {
    throw new Error('This seed refuses to run against a production deployment.');
  }
  const url = process.env['DATABASE_URL'] ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error('This seed refuses to run against a non-local database.');
  }
}

function tenantClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/**
 * The PLATFORM identity, for ONE lookup: which workspace the end-to-end
 * customer belongs to.
 *
 * `workspace` has FORCE ROW LEVEL SECURITY, so the tenant role cannot see a row
 * before a workspace context is set — and the context is the very thing being
 * looked up. That is the policy working, not a problem with it: resolving a
 * workspace by slug is a platform question. Everything AFTER this line runs on
 * the tenant client inside `withWorkspace`, so the content writes are subject to
 * RLS exactly as a real draft's are.
 */
function platformClient(): PrismaClient {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function main(): Promise<void> {
  assertNotProduction();

  let credentials: E2eAdminCredentials;
  try {
    credentials = JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('Run `tsx tests/e2e/seed-admin.ts` first — this seed needs its workspace.');
  }

  const platform = platformClient();
  const prisma = tenantClient();
  try {
    const workspace = await platform.workspace.findFirst({
      where: { slug: credentials.customer.workspaceSlug },
      select: { id: true },
    });
    if (!workspace) {
      throw new Error(
        `No workspace with slug "${credentials.customer.workspaceSlug}". ` +
          'Run `tsx tests/e2e/seed-admin.ts` first.',
      );
    }
    const workspaceId = workspace.id;

    const result = await withWorkspace(
      workspaceId,
      async (db) => {
        /*
         * A BRAND IS REQUIRED, because content is brand-scoped and the
         * composite foreign key says so. The end-to-end suites create one
         * through the Brand Brain screen; if none exists yet there is nothing
         * to attach a draft to, and saying so is better than inventing one that
         * the product's own flow would not have made.
         */
        const brand = await db.brand.findFirst({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (!brand) return { created: false as const };

        const existing = await db.contentItem.findFirst({
          where: { idempotencyKey: IDEMPOTENCY_KEY },
          include: { variants: true },
        });

        if (existing) {
          /*
           * RESET ITS SCHEDULING STATE, every time.
           *
           * The calendar suite schedules this draft, moves it and takes it off
           * again. A run that fails partway leaves it SCHEDULED — and the next
           * run then finds nothing to schedule and fails for a reason several
           * steps removed from its cause, which is what happened while this
           * suite was being written.
           *
           * So the seed's job is not "create if absent" but "leave the fixture
           * in the state the suite starts from". Cancelling rather than
           * deleting keeps the audit trail a real cancellation would leave.
           */
          await db.calendarSlot.updateMany({
            where: { contentItemId: existing.id, status: { not: 'CANCELLED' } },
            data: { status: 'CANCELLED', cancelledAt: new Date() },
          });
          if (existing.status !== 'DRAFT') {
            await db.contentItem.update({
              where: { id: existing.id },
              data: { status: 'DRAFT' },
            });
          }
        }

        if (existing && existing.variants.length > 0) {
          return { created: false as const, id: existing.id, replayed: true as const };
        }

        const item =
          existing ??
          (await db.contentItem.create({
            data: {
              workspaceId,
              brandId: brand.id,
              title: TITLE,
              contentType: 'POST',
              primaryLocale: 'EN',
              status: 'DRAFT',
              origin: 'HUMAN',
              idempotencyKey: IDEMPOTENCY_KEY,
            },
          }));

        await db.contentVariant.create({
          data: {
            workspaceId,
            brandId: brand.id,
            contentItemId: item.id,
            platformKey: 'instagram',
            locale: 'EN',
            body: 'A calm note about the season, written for the end-to-end fixture.',
            hashtags: ['season'],
            characterCount: 62,
            validationState: 'VALID',
            origin: 'HUMAN',
          },
        });

        return { created: true as const, id: item.id };
      },
      { prisma },
    );

    if (!result.created && !('id' in result)) {
      console.log('\n• No brand exists yet, so no schedulable draft was seeded.');
      console.log('  The calendar suite will skip its scheduling test, and say so.');
      return;
    }
    console.log(`\n✔ Schedulable draft ${'replayed' in result ? 'reset' : 'created'}: ${TITLE}`);
    console.log('  One DRAFT item with one caption. Nothing is scheduled and nothing publishes.');
  } finally {
    await prisma.$disconnect();
    await platform.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
