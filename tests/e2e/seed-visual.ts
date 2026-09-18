/**
 * The DETERMINISTIC VISUAL FIXTURE.
 *
 * A screenshot comparison is only evidence if the thing it photographs is the
 * same every time. The functional end-to-end tests deliberately leave state
 * behind — they upload documents, add knowledge, hold conversations — so a
 * visual test pointed at their workspace would photograph a different page on
 * every run and the only way to keep it green would be to keep re-approving the
 * baseline. That is the failure mode `docs/UI-FIDELITY-CONTRACT.md` §5 names in
 * as many words: "A baseline is never updated to make a failing test pass."
 *
 * So this provisions a workspace of its own and RESETS its Brand Brain to a
 * fixed state on every seed: one brand, a fixed set of approved knowledge, two
 * processed source documents, one pending suggestion. The numbers on the screen
 * — the completion percentage, the item and source counts, the attention list —
 * are then a property of this file rather than of test history, which is what
 * makes a pixel comparison mean something.
 *
 * NOTHING HERE IS A CREDENTIAL BEFORE IT RUNS. The password is generated, never
 * printed, and written to a git-ignored file that exists for the length of the
 * run.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { WorkspaceAdminService, hashPassword } from '@brandspace/auth';
import { CreditLedgerService } from '@brandspace/entitlements';
import { withWorkspace } from '@brandspace/database';
import { E2E_VISUAL_FILE, loadE2eEnv, type E2eVisualFixture } from './env';

loadE2eEnv();

const WORKSPACE_SLUG = 'e2e-visual';
const WORKSPACE_NAME = 'Northwind Retail';
const OWNER_EMAIL = 'e2e-visual@brandspace.test';
const BRAND_NAME = 'Northwind';
const BRAND_SLUG = 'northwind';

/**
 * The fixture's knowledge, written out so the screen it produces is readable
 * here rather than only in a PNG.
 *
 * Chosen to exercise the states the design has to render: areas that are
 * COMPLETE, one that NEEDS_ATTENTION because it is short of its minimum, and
 * several that are EMPTY. A fixture where everything is complete would never
 * photograph the amber badge or the attention card.
 */
const KNOWLEDGE: ReadonlyArray<{
  area: string;
  itemKey: string;
  titleEn: string;
  titleAr: string;
  bodyEn: string;
  bodyAr: string;
}> = [
  {
    area: 'IDENTITY',
    itemKey: 'positioning',
    titleEn: 'Positioning',
    titleAr: 'التموضع',
    bodyEn: 'Northwind helps independent retailers compete with national chains.',
    bodyAr: 'نورثويند تساعد تجار التجزئة المستقلين على منافسة السلاسل الوطنية.',
  },
  {
    area: 'IDENTITY',
    itemKey: 'mission',
    titleEn: 'Mission',
    titleAr: 'الرسالة',
    bodyEn: 'Make good merchandising available to shops of every size.',
    bodyAr: 'إتاحة التسويق الجيد لكل متجر مهما كان حجمه.',
  },
  {
    area: 'IDENTITY',
    itemKey: 'value-proposition',
    titleEn: 'Value proposition',
    titleAr: 'القيمة المقدمة',
    bodyEn: 'One team for strategy, content and reporting, at a shop-sized price.',
    bodyAr: 'فريق واحد للاستراتيجية والمحتوى والتقارير بسعر يناسب المتجر.',
  },
  {
    area: 'IDENTITY',
    itemKey: 'business-context',
    titleEn: 'Business context',
    titleAr: 'سياق العمل',
    bodyEn: 'Eleven years old, forty staff, retail clients across the Gulf.',
    bodyAr: 'إحدى عشرة سنة من العمل، أربعون موظفًا، وعملاء تجزئة في الخليج.',
  },
  {
    area: 'AUDIENCE',
    itemKey: 'primary-segment',
    titleEn: 'Primary segment',
    titleAr: 'الشريحة الأساسية',
    bodyEn: 'Founders of single-location retail businesses.',
    bodyAr: 'مؤسسو متاجر التجزئة ذات الفرع الواحد.',
  },
  {
    area: 'AUDIENCE',
    itemKey: 'motivations',
    titleEn: 'Motivations',
    titleAr: 'الدوافع',
    bodyEn: 'Growth without hiring a marketing department.',
    bodyAr: 'النمو دون الحاجة إلى بناء قسم تسويق.',
  },
  {
    area: 'OFFERS',
    itemKey: 'monthly-package',
    titleEn: 'Monthly package',
    titleAr: 'الباقة الشهرية',
    bodyEn: 'A content plan, twelve posts and a monthly performance review.',
    bodyAr: 'خطة محتوى واثنا عشر منشورًا ومراجعة أداء شهرية.',
  },
  {
    // ONE item where the area needs two, so the screen renders NEEDS_ATTENTION
    // and the attention card has something in it.
    area: 'TONE_OF_VOICE',
    itemKey: 'personality',
    titleEn: 'Personality',
    titleAr: 'الشخصية',
    bodyEn: 'Plain, practical and warm. Never grandiose.',
    bodyAr: 'واضحة وعملية ودافئة، بلا مبالغة.',
  },
];

const SOURCES: ReadonlyArray<{ fileName: string; pages: number; chunks: number }> = [
  { fileName: 'Brand Guidelines 2026.pdf', pages: 24, chunks: 36 },
  { fileName: 'Services and Offers.docx', pages: 18, chunks: 22 },
];

function platformClient(): PrismaClient {
  const connectionString = process.env['DATABASE_PLATFORM_URL'];
  if (!connectionString) throw new Error('DATABASE_PLATFORM_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

function tenantClient(): PrismaClient {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

async function main(): Promise<void> {
  if (process.env['APP_ENV'] === 'production' || process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to seed a visual fixture in a production environment.');
  }

  const platform = platformClient();
  const tenant = tenantClient();

  try {
    const owner = await platform.platformUser.findFirstOrThrow({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, roleId: true },
    });
    const grants = await platform.rolePermission.findMany({
      where: { roleId: owner.roleId },
      include: { permission: true },
    });
    const actor = {
      platformUserId: owner.id,
      roleKey: 'platform_owner',
      mfaVerified: true,
      permissionKeys: grants.map((grant) => grant.permission.key),
    };

    if (!(await platform.workspace.findUnique({ where: { slug: WORKSPACE_SLUG } }))) {
      await new WorkspaceAdminService({ prisma: platform }).create(actor, {
        name: WORKSPACE_NAME,
        slug: WORKSPACE_SLUG,
        ownerEmail: OWNER_EMAIL,
        ownerName: 'Visual Fixture Owner',
        defaultLocale: 'EN',
        // EXPLICIT (D-194), for the reason the admin seed gives.
        country: 'US',
        timezone: 'UTC',
        currency: 'USD',
      });
    }
    const workspace = await platform.workspace.findUniqueOrThrow({
      where: { slug: WORKSPACE_SLUG },
    });

    const password = `e2e-${randomBytes(18).toString('base64url')}`;
    const user = await platform.user.update({
      where: { email: OWNER_EMAIL },
      data: {
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: await hashPassword(password),
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    const ownerRole = await platform.role.findFirstOrThrow({
      where: { key: 'workspace_owner', workspaceId: null },
    });
    await platform.membership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      create: {
        workspaceId: workspace.id,
        userId: user.id,
        roleId: ownerRole.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
        brandScope: [],
      },
      update: { status: 'ACTIVE', roleId: ownerRole.id, acceptedAt: new Date() },
    });

    /*
     * RESET, then rebuild. The fixture is only deterministic if a second run
     * produces the same page as the first, and a seed that only ever adds would
     * drift a little further from its baseline each time it ran.
     *
     * On the TENANT pool inside the workspace's own context, so the reset is
     * subject to the same RLS as everything else — a seed does not get a private
     * door (the same rule the repository seed follows).
     */
    const brandId = await withWorkspace(
      workspace.id,
      async (db) => {
        const existing = await db.brand.findFirst({ where: { slug: BRAND_SLUG } });
        if (existing) {
          await db.brandKnowledgeCandidate.deleteMany({ where: { brandId: existing.id } });
          await db.brandSourceChunk.deleteMany({ where: { brandId: existing.id } });
          await db.brandIngestionJob.deleteMany({ where: { brandId: existing.id } });
          await db.brandSourceDocument.deleteMany({ where: { brandId: existing.id } });
          await db.brandBrainMessage.deleteMany({ where: { brandId: existing.id } });
          await db.brandBrainConversation.deleteMany({ where: { brandId: existing.id } });
          /*
           * NO VERSION DELETE, because NEITHER ROLE MAY DELETE ONE. The change
           * history is append-only by privilege, not by convention — the
           * migration grants only SELECT and INSERT on it to both roles.
           *
           * The fixture therefore writes items DIRECTLY and never through the
           * knowledge service, so it creates no version rows and has none to
           * clear. If a future change gave it some, this delete would fail on
           * the foreign key and say so, which is the right outcome: a fixture
           * quietly unable to reset itself is how a "deterministic" baseline
           * stops being deterministic.
           */
          await db.brandKnowledgeItem.deleteMany({ where: { brandId: existing.id } });
          await db.brand.delete({ where: { id: existing.id } });
        }

        const brand = await db.brand.create({
          data: {
            workspaceId: workspace.id,
            name: BRAND_NAME,
            slug: BRAND_SLUG,
            status: 'ACTIVE',
          },
        });

        // A FIXED review date, far in the future, so nothing in the fixture is
        // ever stale and the attention card says the same thing in June as in
        // December.
        const reviewDueAt = new Date('2099-01-01T00:00:00.000Z');
        for (const entry of KNOWLEDGE) {
          await db.brandKnowledgeItem.create({
            data: {
              workspaceId: workspace.id,
              brandId: brand.id,
              area: entry.area as never,
              memory: 'CANONICAL',
              origin: 'HUMAN',
              status: 'ACTIVE',
              itemKey: entry.itemKey,
              title: { en: entry.titleEn, ar: entry.titleAr },
              body: { en: entry.bodyEn, ar: entry.bodyAr },
              createdByUserId: user.id,
              version: 1,
              lastReviewedAt: new Date('2026-01-01T00:00:00.000Z'),
              reviewDueAt,
            },
          });
        }

        let firstDocumentId = '';
        for (const source of SOURCES) {
          const created = await db.brandSourceDocument.create({
            data: {
              workspaceId: workspace.id,
              brandId: brand.id,
              fileName: source.fileName,
              mimeType: 'application/pdf',
              byteSize: 1_024,
              checksum: `visual-${source.fileName.replace(/\W+/g, '-').toLowerCase()}`,
              storageKey: `visual/${brand.id}/${source.fileName}`,
              status: 'READY',
              pageCount: source.pages,
              chunkCount: source.chunks,
              idempotencyKey: `visual-${brand.id}-${source.fileName}`,
              uploadedByUserId: user.id,
            },
          });
          firstDocumentId ||= created.id;
        }

        // One pending suggestion, so the intelligence card renders its
        // populated state rather than its empty one.
        await db.brandKnowledgeCandidate.create({
          data: {
            workspaceId: workspace.id,
            brandId: brand.id,
            // Candidates are always traceable to the document they came from —
            // a suggestion with no source is not evidence (D-65).
            sourceDocumentId: firstDocumentId,
            area: 'COMPETITORS',
            itemKey: 'competitor-profile',
            extractedTitle: { en: 'A competitor profile', ar: 'ملف منافس' },
            extractedBody: {
              en: 'A national chain opened two stores in the same district this year.',
              ar: 'سلسلة وطنية افتتحت متجرين في الحي نفسه هذا العام.',
            },
            confidenceMilli: 720,
            evidence: [{ locator: 'page 4', quote: 'two stores in the same district' }],
            status: 'PENDING',
          },
        });

        return brand.id;
      },
      { prisma: tenant },
    );

    /*
     * CREDITS, because a chat turn reserves before it calls.
     *
     * `seed-ai.ts` grants to the workspaces that exist when it runs, and this
     * one is created afterwards — so without this the visual suite's chat panel
     * shows the red failure and photographs it. Granted here rather than by
     * reordering the seeds, because a fixture that depends on the order two
     * scripts happen to run in is a fixture that will break silently.
     */
    const ledger = new CreditLedgerService({ prisma: platform });
    await platform.creditWallet.upsert({
      where: { workspaceId: workspace.id },
      create: { workspaceId: workspace.id },
      update: {},
    });
    await ledger.grant({
      workspaceId: workspace.id,
      source: 'PROMOTIONAL_GRANT',
      credits: 5_000,
      reason: 'Visual fixture allowance',
      idempotencyKey: `visual-fixture-grant:${workspace.id}`,
    });

    const counts = await withWorkspace(
      workspace.id,
      async (db) => ({
        knowledgeItems: await db.brandKnowledgeItem.count({
          where: { brandId, status: 'ACTIVE' },
        }),
        sourceDocuments: await db.brandSourceDocument.count({
          where: { brandId, deletedAt: null },
        }),
        pendingCandidates: await db.brandKnowledgeCandidate.count({
          where: { brandId, status: 'PENDING' },
        }),
      }),
      { prisma: tenant },
    );

    const fixture: E2eVisualFixture = {
      email: OWNER_EMAIL,
      password,
      workspaceSlug: WORKSPACE_SLUG,
      brandName: BRAND_NAME,
      ...counts,
    };
    mkdirSync(path.dirname(E2E_VISUAL_FILE), { recursive: true });
    writeFileSync(E2E_VISUAL_FILE, JSON.stringify(fixture, null, 2), { mode: 0o600 });

    console.log(`Visual fixture ready: ${WORKSPACE_SLUG} (${KNOWLEDGE.length} knowledge items)`);
  } finally {
    await platform.$disconnect();
    await tenant.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
