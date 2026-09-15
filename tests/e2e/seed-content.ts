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

/*
 * PHASE 5B-3 — A SECOND DRAFT, FOR APPROVALS ALONE.
 *
 * The calendar suite schedules the draft above, moves it and cancels it; the
 * approvals suite submits ITS draft for review, is refused a self-approval,
 * changes the brand policy and approves. Sharing one fixture between them makes
 * each suite's starting state depend on whether the other ran first, which is
 * the kind of coupling that produces a failure pointing nowhere near its cause.
 */
const APPROVAL_IDEMPOTENCY_KEY = 'e2e-approvals-fixture';
const APPROVAL_TITLE = 'Launch announcement';

/*
 * A SECOND BRAND, so "another brand" is a real place in the end-to-end suite.
 *
 * D-121 grants Viewer approval PER BRAND, and a test that cannot show the
 * Viewer being admitted to one brand while being refused another is not testing
 * the grant — it is testing a boolean. The second brand carries its own draft so
 * both can be in review at once.
 */
const SECOND_BRAND_SLUG = 'e2e-approvals-brand-two';
const SECOND_BRAND_NAME = 'E2E Second Brand';
const SECOND_IDEMPOTENCY_KEY = 'e2e-approvals-second-brand';
const SECOND_TITLE = 'Second brand note';

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
         * composite foreign key says so.
         *
         * THE SEED CREATES ONE IF NONE EXISTS, rather than bailing. Bailing was
         * the first version and it failed in CI for a reason that only shows up
         * there: on a developer's reused database a brand is always left over
         * from an earlier run, and on a FRESH one — which is what CI has — the
         * brands are created by the suites DURING the run, long after the seed
         * has finished. So the seed wrote nothing, the calendar had nothing to
         * schedule, and AC-14.1's end-to-end proof failed on the one machine it
         * most needed to run.
         *
         * A fixture's job is to establish its own precondition. `seed-visual`
         * already creates a brand for the same reason.
         */
        const existingBrand = await db.brand.findFirst({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        const brand =
          existingBrand ??
          (await db.brand.create({
            data: {
              workspaceId,
              slug: 'e2e-content-fixture',
              name: 'E2E Content Fixture',
              defaultLocale: 'EN',
              status: 'ACTIVE',
            },
            select: { id: true },
          }));

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

    /*
     * THE APPROVALS FIXTURE, reset to a clean DRAFT with no review history.
     *
     * The suite asserts cycle numbers and the self-approval refusal, so a
     * previous run's cycles would make the first assertion wrong on the second
     * run. Approvals ARE deleted rather than cancelled — unlike the calendar
     * slot above — because a cancelled cycle still counts towards the ceiling
     * and still shows in the history the suite reads. The AUDIT trail of those
     * reviews survives regardless: `audit_event` is append-only and nothing
     * here touches it.
     *
     * The brand's policy row is removed too, so the suite starts from the
     * activated defaults rather than from whatever it last switched on.
     */
    await withWorkspace(
      workspaceId,
      async (db) => {
        const brand = await db.brand.findFirstOrThrow({
          where: { deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });

        const existing = await db.contentItem.findFirst({
          where: { idempotencyKey: APPROVAL_IDEMPOTENCY_KEY },
          include: { variants: true },
        });

        if (existing) {
          /*
           * THE APPROVAL HISTORY IS CLEARED AS THE PLATFORM ROLE, not here.
           *
           * `20260915210000_phase_5b_3_approval_integrity` revoked DELETE on
           * `approval` from the application role: an approval is the record
           * that somebody reviewed something, and the application has no
           * business erasing one. Tenant offboarding and the retention purge
           * run as the platform role, and so does this reset — rather than the
           * production grant being widened to make a fixture convenient.
           */
          await platform.approval.deleteMany({ where: { contentItemId: existing.id } });
          await db.calendarSlot.updateMany({
            where: { contentItemId: existing.id, status: { not: 'CANCELLED' } },
            data: { status: 'CANCELLED', cancelledAt: new Date() },
          });
          await db.contentItem.update({
            where: { id: existing.id },
            data: { status: 'DRAFT' },
          });
        }
        await platform.approvalPolicy.deleteMany({ where: { brandId: brand.id } });

        const item =
          existing ??
          (await db.contentItem.create({
            data: {
              workspaceId,
              brandId: brand.id,
              title: APPROVAL_TITLE,
              contentType: 'POST',
              primaryLocale: 'EN',
              status: 'DRAFT',
              origin: 'HUMAN',
              idempotencyKey: APPROVAL_IDEMPOTENCY_KEY,
            },
          }));

        if (!existing || existing.variants.length === 0) {
          await db.contentVariant.create({
            data: {
              workspaceId,
              brandId: brand.id,
              contentItemId: item.id,
              platformKey: 'instagram',
              locale: 'EN',
              body: 'A short announcement, written for the approvals end-to-end fixture.',
              hashtags: ['launch'],
              characterCount: 66,
              validationState: 'VALID',
              origin: 'HUMAN',
            },
          });
        }

        // The second brand, and a draft in it. See the note by its constants.
        const secondBrand =
          (await db.brand.findFirst({ where: { slug: SECOND_BRAND_SLUG } })) ??
          (await db.brand.create({
            data: {
              workspaceId,
              slug: SECOND_BRAND_SLUG,
              name: SECOND_BRAND_NAME,
              defaultLocale: 'EN',
              status: 'ACTIVE',
            },
          }));
        await platform.approvalPolicy.deleteMany({ where: { brandId: secondBrand.id } });

        const secondExisting = await db.contentItem.findFirst({
          where: { idempotencyKey: SECOND_IDEMPOTENCY_KEY },
          include: { variants: true },
        });
        if (secondExisting) {
          await platform.approval.deleteMany({ where: { contentItemId: secondExisting.id } });
          await db.calendarSlot.updateMany({
            where: { contentItemId: secondExisting.id, status: { not: 'CANCELLED' } },
            data: { status: 'CANCELLED', cancelledAt: new Date() },
          });
          await db.contentItem.update({
            where: { id: secondExisting.id },
            data: { status: 'DRAFT' },
          });
        }
        const secondItem =
          secondExisting ??
          (await db.contentItem.create({
            data: {
              workspaceId,
              brandId: secondBrand.id,
              title: SECOND_TITLE,
              contentType: 'POST',
              primaryLocale: 'EN',
              status: 'DRAFT',
              origin: 'HUMAN',
              idempotencyKey: SECOND_IDEMPOTENCY_KEY,
            },
          }));
        if (!secondExisting || secondExisting.variants.length === 0) {
          await db.contentVariant.create({
            data: {
              workspaceId,
              brandId: secondBrand.id,
              contentItemId: secondItem.id,
              platformKey: 'instagram',
              locale: 'EN',
              body: 'A note belonging to the second brand, for the D-121 scope fixture.',
              hashtags: ['second'],
              characterCount: 65,
              validationState: 'VALID',
              origin: 'HUMAN',
            },
          });
        }
      },
      { prisma },
    );

    console.log(`\n✔ Schedulable draft ${'replayed' in result ? 'reset' : 'created'}: ${TITLE}`);
    console.log('  One DRAFT item with one caption. Nothing is scheduled and nothing publishes.');
    console.log(`✔ Reviewable draft reset: ${APPROVAL_TITLE}`);
    console.log('  One DRAFT item, no review history, and the brand back on its default policy.');
    console.log(`✔ Second brand and its draft reset: ${SECOND_TITLE}`);
    console.log('  So the D-121 per-brand grant can be shown admitting one brand and not another.');
  } finally {
    await prisma.$disconnect();
    await platform.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
