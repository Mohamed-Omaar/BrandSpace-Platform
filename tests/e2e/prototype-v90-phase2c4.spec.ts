import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';
import { CreditLedgerService } from '@brandspace/entitlements';
import { knowledgeSignatureOf } from '@brandspace/brand-brain';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v90, Phase 2C-4 — Item 5 (Sources: uploads) and Item 6 (D11
 * Performance "Save as learning", D12 Home Brand Brain rows, D13 Strategy
 * "Brand Brain changed"), plus the Strategy display-list fix, in a real
 * browser against the real worker.
 *
 * EVERY TEST BUILDS ITS OWN WORKSPACE — one brand, its own credits, its own
 * facts — so nothing another suite reads moves. Uploads travel the production
 * path: the dashboard validates and records, the worker (a separate process in
 * this suite) parses. What each path writes, and every refusal a direct call
 * meets, is proven against PostgreSQL in tests/isolation/phase2c4-*.test.ts.
 */

test.setTimeout(180_000);

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

interface World {
  readonly slug: string;
  readonly workspaceId: string;
  readonly brandId: string;
  readonly ownerId: string;
}

/**
 * A workspace of its own, with one brand and credits. The second member (the
 * seeded viewer USER) joins with a SYSTEM role — never a workspace-scoped
 * custom role: the viewer is shared by every suite, and its workspace list
 * reads roles outside any one workspace.
 */
async function world(label: string, member?: { roleKey: string }): Promise<World> {
  const { customer } = credentials();
  const slug = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  const brandId = randomUUID();
  const workspaceId = randomUUID();
  let ownerId = '';
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    ownerId = owner.id;
    const ownerRole = await prisma.role.findFirstOrThrow({
      where: { key: 'workspace_owner', workspaceId: null },
      select: { id: true },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        workspaceId,
        slug,
        name: `E2E ${label} ${slug.slice(-8)}`,
        ownerUserId: owner.id,
        status: 'ACTIVE',
        country: 'US',
        defaultLocale: 'EN',
        timezone: 'UTC',
        currency: 'USD',
      },
    });
    await prisma.membership.create({
      data: {
        workspaceId,
        userId: owner.id,
        roleId: ownerRole.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
    if (member) {
      const viewer = await prisma.user.findFirstOrThrow({
        where: { email: customer.viewerEmail },
        select: { id: true },
      });
      const roleId = (
        await prisma.role.findFirstOrThrow({
          where: { key: member.roleKey, workspaceId: null },
          select: { id: true },
        })
      ).id;
      await prisma.membership.create({
        data: {
          workspaceId,
          userId: viewer.id,
          roleId,
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });
    }
    await prisma.brand.create({
      data: {
        id: brandId,
        workspaceId,
        slug: `${slug}-brand`,
        name: `${label} Brand`,
        status: 'ACTIVE',
        defaultLocale: 'EN',
        supportedLocales: ['EN', 'AR'],
      },
    });
    await prisma.creditWallet.upsert({
      where: { workspaceId },
      create: { workspaceId },
      update: {},
    });
    await new CreditLedgerService({ prisma }).grant({
      workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 1_000,
      reason: 'Phase 2C-4 end-to-end allowance',
      idempotencyKey: `e2e-2c4-grant:${workspaceId}`,
    });
  });
  return { slug, workspaceId, brandId, ownerId };
}

async function enter(
  page: Page,
  target: World,
  options: { locale?: 'en' | 'ar'; as?: 'owner' | 'member' } = {},
): Promise<void> {
  const locale = options.locale ?? 'en';
  const { customer } = credentials();
  const email = options.as === 'member' ? customer.viewerEmail : customer.email;
  const password = options.as === 'member' ? customer.viewerPassword : customer.password;
  await useBrand(page, target.workspaceId, target.brandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/workspaces`);
  await page.click(`[data-testid="choose-workspace-${target.slug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

async function noSeriousViolations(page: Page, include?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21a',
    'wcag21aa',
    'wcag22aa',
  ]);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const blocking = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/* ------------------------------------------------------------------ files */

interface FileSpec {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function contentTypes(main: string, part: string): Uint8Array {
  return strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      `<Override PartName="${part}" ContentType="${main}"/></Types>`,
  );
}

/** Two sentences that start with words unique to this run, so each run proposes its own facts. */
function sentences(tag: string): string[] {
  return [
    `${tag} audience is founders of independent bakeries in the Gulf region.`,
    `${tag} service includes a monthly content package for every client.`,
    `${tag} tone of voice is warm and we never speak in hype.`,
  ];
}

const tagOf = () => `z${randomUUID().slice(0, 8)}`;

function textFile(name: string, tag: string): FileSpec {
  return {
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(sentences(tag).join('\n\n'), 'utf8'),
  };
}

function docxFile(name: string, tag: string): FileSpec {
  const body = sentences(tag)
    .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
    .join('');
  return {
    name,
    mimeType: DOCX_TYPE,
    buffer: Buffer.from(
      zipSync({
        '[Content_Types].xml': contentTypes(
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
          '/word/document.xml',
        ),
        'word/document.xml': strToU8(
          `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`,
        ),
      }),
    ),
  };
}

function pptxFile(name: string, tag: string): FileSpec {
  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': contentTypes(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
      '/ppt/presentation.xml',
    ),
  };
  sentences(tag).forEach((line, index) => {
    entries[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      `<?xml version="1.0"?><p:sld xmlns:a="x" xmlns:p="y"><p:cSld><p:spTree><a:p><a:r><a:t>${line}</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
    );
  });
  return { name, mimeType: PPTX_TYPE, buffer: Buffer.from(zipSync(entries)) };
}

function pdfFile(name: string, tag: string): FileSpec {
  const lines = sentences(tag);
  const content = lines
    .map((line, index) => `BT /F1 10 Tf 10 ${180 - index * 20} Td (${line}) Tj ET`)
    .join('\n');
  const source = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${content.length}>>stream
${content}
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
`;
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(source, 'latin1') };
}

/* ------------------------------------------------------------ source steps */

const sourcesUrl = (locale: string) => `${DASHBOARD_BASE_URL}/${locale}/brand-brain?tab=sources`;

/** Upload one file through the real form; returns the redirect's query. */
async function upload(page: Page, locale: 'en' | 'ar', file: FileSpec): Promise<URLSearchParams> {
  await page.goto(sourcesUrl(locale));
  await page.getByTestId('upload-input').setInputFiles(file);
  await page.getByTestId('upload-submit').click();
  await page.waitForURL(/[?&](ok|error)=/, { timeout: 60_000 });
  return new URL(page.url()).searchParams;
}

const rowFor = (page: Page, fileName: string) =>
  page.locator('li[data-status]').filter({ hasText: fileName });

/** Reload until the source reaches `status` — the worker runs in its own process. */
async function waitForStatus(
  page: Page,
  locale: 'en' | 'ar',
  fileName: string,
  status: 'READY' | 'FAILED',
): Promise<void> {
  await expect(async () => {
    await page.goto(sourcesUrl(locale));
    await expect(rowFor(page, fileName)).toHaveAttribute('data-status', status, { timeout: 1_500 });
  }).toPass({ timeout: 120_000, intervals: [1_000, 2_000, 3_000] });
}

async function sourceIdOf(page: Page, fileName: string): Promise<string> {
  const testId = await rowFor(page, fileName).getAttribute('data-testid');
  return (testId ?? '').replace('source-', '');
}

async function acceptFirstPending(target: World, documentId: string): Promise<string> {
  // Through the inbox would be a second journey; the review path itself is
  // proven in phase2c's suites. What matters here is an APPROVED fact that
  // came from this document — written as the review service writes it.
  return withPlatformPrisma(async (prisma) => {
    const candidate = await prisma.brandKnowledgeCandidate.findFirstOrThrow({
      where: { sourceDocumentId: documentId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
    });
    const item = await prisma.brandKnowledgeItem.create({
      data: {
        workspaceId: target.workspaceId,
        brandId: target.brandId,
        area: candidate.area,
        memory: 'CANONICAL',
        origin: 'DOCUMENT',
        status: 'ACTIVE',
        itemKey: candidate.itemKey,
        title: candidate.extractedTitle as never,
        body: candidate.extractedBody as never,
        sourceDocumentId: documentId,
        version: 1,
      },
    });
    await prisma.brandKnowledgeVersion.create({
      data: {
        workspaceId: target.workspaceId,
        brandId: target.brandId,
        knowledgeItemId: item.id,
        version: 1,
        area: item.area,
        memory: item.memory,
        origin: item.origin,
        status: 'ACTIVE',
        title: item.title as never,
        body: item.body as never,
        changeKind: 'approved',
      },
    });
    await prisma.brandKnowledgeCandidate.update({
      where: { id: candidate.id },
      data: {
        status: 'ACCEPTED',
        reviewedByUserId: target.ownerId,
        reviewedAt: new Date(),
        resultingVersion: 1,
      },
    });
    return item.id;
  });
}

/* ============================================================= Item 5 · uploads */

test.describe('Item 5 · uploads — every format through the worker', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`PDF, DOCX, PPTX and text read to READY, and propose PENDING facts (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const target = await world(`upload-${locale}`);
      await enter(page, target, { locale });
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

      const files = [
        pdfFile('brand.pdf', tagOf()),
        docxFile('guidelines.docx', tagOf()),
        pptxFile('deck.pptx', tagOf()),
        textFile('notes.txt', tagOf()),
      ];
      for (const file of files) {
        const query = await upload(page, locale, file);
        expect(query.get('ok'), `${file.name}: ${query.toString()}`).toBe('SOURCE_UPLOADED');
      }
      for (const file of files) await waitForStatus(page, locale, file.name, 'READY');

      // Each row: type, size, date and counts; its facts on demand, by keyboard.
      const row = rowFor(page, 'notes.txt');
      const id = await sourceIdOf(page, 'notes.txt');
      await expect(page.getByTestId(`source-meta-${id}`)).toContainText(
        locale === 'ar' ? 'بانتظار المراجعة' : 'pending',
      );
      await page.getByTestId(`source-toggle-${id}`).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId(`source-toggle-${id}`)).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expect(page.getByTestId(`source-facts-${id}`)).toBeVisible();
      await expect(row.locator('[data-testid^="source-pending-"]').first()).toBeVisible();
      await noSeriousViolations(page, '[data-testid="sources-card"]');

      // The proposals wait in the ONE review inbox.
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain`);
      await expect(page.getByTestId('intel-card')).toBeVisible();
      await expect(page.getByTestId('review-inbox-count')).not.toHaveText('0');
    });
  }
});

test.describe('Item 5 · refused and failed files are FAILED rows, never a 500', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`unsupported, oversize and spoofed files; the same bytes again (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const target = await world(`refused-${locale}`);
      await enter(page, target, { locale });

      const unsupported: FileSpec = {
        name: 'installer.exe',
        mimeType: 'application/x-msdownload',
        buffer: Buffer.from(`MZ ${randomUUID()}`),
      };
      const legacy: FileSpec = {
        name: 'old.doc',
        mimeType: 'application/msword',
        buffer: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]),
      };
      const oversize: FileSpec = {
        name: 'huge.txt',
        mimeType: 'text/plain',
        buffer: Buffer.alloc(20 * 1024 * 1024 + 1, 0x61),
      };
      const spoofed: FileSpec = {
        ...pdfFile('renamed.docx', tagOf()),
        name: 'renamed.docx',
        mimeType: DOCX_TYPE,
      };
      const expectations: [FileSpec, RegExp][] = [
        [unsupported, locale === 'ar' ? /غير مدعوم/ : /not supported/],
        [legacy, locale === 'ar' ? /غير مدعوم/ : /not supported/],
        [oversize, locale === 'ar' ? /أكبر من الحجم المسموح/ : /larger than the size allowed/],
        [spoofed, locale === 'ar' ? /لا يطابق نوعه/ : /match its type/],
      ];
      for (const [file, reason] of expectations) {
        const query = await upload(page, locale, file);
        expect(query.get('error'), file.name).toBe('SOURCE_REFUSED');
        const id = await sourceIdOf(page, file.name);
        await expect(rowFor(page, file.name)).toHaveAttribute('data-status', 'FAILED');
        await expect(page.getByTestId(`source-detail-${id}`)).toHaveText(reason);
        // Nothing was stored, so there is nothing to read again.
        await expect(page.getByTestId(`source-read-again-${id}`)).toHaveCount(0);
      }

      // The same refused bytes again: that row, its reason — never INTERNAL.
      const again = await upload(page, locale, unsupported);
      expect(again.get('error')).toBe('SOURCE_ALREADY_FAILED');
      await expect(
        page.locator('li[data-status]').filter({ hasText: 'installer.exe' }),
      ).toHaveCount(1);

      // A file that fails DURING processing: accepted, stored, failed by the worker.
      const empty: FileSpec = {
        name: 'blank.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from(`   \n\n   ${' '.repeat(3)}\n`, 'utf8'),
      };
      expect((await upload(page, locale, empty)).get('ok')).toBe('SOURCE_UPLOADED');
      await waitForStatus(page, locale, 'blank.txt', 'FAILED');
      const blankId = await sourceIdOf(page, 'blank.txt');
      await expect(page.getByTestId(`source-detail-${blankId}`)).toHaveText(
        locale === 'ar' ? /لا يحتوي هذا الملف على نص/ : /no readable text/,
      );
      const repeat = await upload(page, locale, empty);
      expect(repeat.get('error')).toBe('SOURCE_ALREADY_FAILED');

      // Read again retries it through the worker and reaches the same safe state.
      await page.goto(sourcesUrl(locale));
      await page.getByTestId(`source-read-again-${blankId}`).click();
      await page.waitForURL(/ok=SOURCE_READ_AGAIN/);
      await waitForStatus(page, locale, 'blank.txt', 'FAILED');
      const jobs = await withPlatformPrisma((prisma) =>
        prisma.brandIngestionJob.count({ where: { sourceDocumentId: blankId } }),
      );
      expect(jobs).toBe(2);
      await noSeriousViolations(page, '[data-testid="sources-card"]');
    });
  }
});

/* ============================================================ Read again, Remove */

test.describe('Item 5 · Read again, Remove with Keep or Drop, and re-upload', () => {
  test('Read again re-runs a completed read and duplicates no approved fact', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('reread');
    await enter(page, target);
    const file = textFile('reread.txt', tagOf());
    await upload(page, 'en', file);
    await waitForStatus(page, 'en', 'reread.txt', 'READY');
    const id = await sourceIdOf(page, 'reread.txt');
    const itemId = await acceptFirstPending(target, id);
    const approvedKey = await withPlatformPrisma(async (prisma) => {
      const item = await prisma.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } });
      return item.itemKey;
    });

    await page.goto(sourcesUrl('en'));
    await expect(page.getByTestId(`source-meta-${id}`)).toContainText('1 approved');
    await page.getByTestId(`source-read-again-${id}`).click();
    await page.waitForURL(/ok=SOURCE_READ_AGAIN/);
    await waitForStatus(page, 'en', 'reread.txt', 'READY');

    const state = await withPlatformPrisma(async (prisma) => ({
      jobs: await prisma.brandIngestionJob.findMany({ where: { sourceDocumentId: id } }),
      items: await prisma.brandKnowledgeItem.count({
        where: { brandId: target.brandId, itemKey: approvedKey },
      }),
      candidates: await prisma.brandKnowledgeCandidate.findMany({
        where: { sourceDocumentId: id },
      }),
    }));
    // A second, completed job: the re-read really ran.
    expect(state.jobs).toHaveLength(2);
    expect(state.jobs.every((job) => job.stage === 'COMPLETED')).toBe(true);
    expect(state.items).toBe(1);
    expect(state.candidates.filter((c) => c.itemKey === approvedKey)).toHaveLength(1);
    expect(
      state.candidates.filter((c) => c.status !== 'ACCEPTED').every((c) => c.status === 'PENDING'),
    ).toBe(true);
  });

  test('Remove → Keep leaves approved facts; the same file uploads again afterwards', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('keep');
    await enter(page, target);
    const file = textFile('keep.txt', tagOf());
    await upload(page, 'en', file);
    await waitForStatus(page, 'en', 'keep.txt', 'READY');
    const id = await sourceIdOf(page, 'keep.txt');
    const itemId = await acceptFirstPending(target, id);

    await page.goto(sourcesUrl('en'));
    await page.getByTestId(`source-remove-${id}`).click();
    const dialog = page.getByTestId(`source-remove-dialog-${id}`);
    await expect(dialog).toBeVisible();
    await noSeriousViolations(page, `[data-testid="source-remove-dialog-${id}"]`);
    await expect(page.getByTestId(`source-remove-keep-${id}`)).toBeChecked();
    await page.getByTestId(`source-remove-confirm-${id}`).click();
    await page.waitForURL(/ok=SOURCE_REMOVED/);
    await expect(rowFor(page, 'keep.txt')).toHaveCount(0);

    const fact = await withPlatformPrisma((prisma) =>
      prisma.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(fact.status).toBe('ACTIVE');

    // M6: the removed file released its checksum.
    const again = await upload(page, 'en', file);
    expect(again.get('ok')).toBe('SOURCE_UPLOADED');
    await waitForStatus(page, 'en', 'keep.txt', 'READY');
  });

  test('Remove → Drop archives only current source facts; D10 flags a post that used one', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('drop');
    await enter(page, target);
    const tag = tagOf();
    await upload(page, 'en', textFile('drop.txt', tag));
    await waitForStatus(page, 'en', 'drop.txt', 'READY');
    const id = await sourceIdOf(page, 'drop.txt');
    const owned = await acceptFirstPending(target, id);
    const edited = await acceptFirstPending(target, id);
    // A person edits the second fact afterwards: its current version is theirs.
    await withPlatformPrisma(async (prisma) => {
      const current = await prisma.brandKnowledgeItem.findUniqueOrThrow({ where: { id: edited } });
      await prisma.brandKnowledgeItem.update({
        where: { id: edited },
        data: { version: current.version + 1, body: { en: 'Rewritten by a person later.' } },
      });
    });

    // A post whose caption used the owned fact.
    const post = await page.evaluate(
      async ({ brandId, brief, key }) => {
        const response = await fetch('/api/content/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            brandId,
            brief,
            locale: 'EN',
            platformKeys: ['instagram'],
            idempotencyKey: key,
          }),
        });
        return { status: response.status, body: await response.text() };
      },
      {
        brandId: target.brandId,
        brief: `${tag} audience founders independent bakeries Gulf region`,
        key: `e2e-2c4-${randomUUID()}`,
      },
    );
    expect(post.status, post.body).toBe(200);
    const postId = (JSON.parse(post.body) as { itemId: string }).itemId;
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${postId}`);
    await expect(page.getByTestId(`variant-fact-${owned}`)).toBeVisible();

    await page.goto(sourcesUrl('en'));
    await page.getByTestId(`source-remove-${id}`).click();
    await page.getByTestId(`source-remove-drop-${id}`).check();
    await page.getByTestId(`source-remove-confirm-${id}`).click();
    await page.waitForURL(/ok=SOURCE_REMOVED_DROPPED/);

    const after = await withPlatformPrisma(async (prisma) => ({
      owned: await prisma.brandKnowledgeItem.findUniqueOrThrow({ where: { id: owned } }),
      edited: await prisma.brandKnowledgeItem.findUniqueOrThrow({ where: { id: edited } }),
      pending: await prisma.brandKnowledgeCandidate.count({
        where: { sourceDocumentId: id, status: 'PENDING' },
      }),
      superseded: await prisma.brandKnowledgeCandidate.count({
        where: { sourceDocumentId: id, status: 'SUPERSEDED' },
      }),
      rejected: await prisma.brandKnowledgeCandidate.count({
        where: { sourceDocumentId: id, status: 'REJECTED' },
      }),
    }));
    expect(after.owned.status).toBe('ARCHIVED');
    expect(after.edited.status).toBe('ACTIVE');
    expect(after.pending).toBe(0);
    expect(after.rejected).toBe(0);
    // What the source still proposed was superseded, not rejected.
    expect(after.superseded).toBeGreaterThan(0);

    // The EXISTING D10 banner: the fact the caption used was removed.
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${postId}`);
    await expect(page.getByTestId('fact-change-banner')).toBeVisible();
    await expect(page.getByTestId(`fact-change-${owned}`)).toHaveAttribute('data-kind', 'removed');
  });

  test('the Remove dialog offers Keep and, with brand_brain.edit, Drop — by keyboard', async ({
    page,
    isMobile,
  }) => {
    /*
     * "Upload without edit → Keep only" is proven where a member with exactly
     * that grant can exist: no SYSTEM role holds `brand_brain.upload` without
     * `brand_brain.edit`, so the refusal of a direct Drop is in
     * tests/isolation/phase2c4-sources.test.ts and the control's gating in
     * tests/unit/phase2c4-item6.test.ts. Here the owner, who holds both.
     */
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('keep-drop');
    await enter(page, target);
    await upload(page, 'en', textFile('choice.txt', tagOf()));
    await waitForStatus(page, 'en', 'choice.txt', 'READY');
    const id = await sourceIdOf(page, 'choice.txt');
    await page.getByTestId(`source-remove-${id}`).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`source-remove-dialog-${id}`)).toBeVisible();
    await expect(page.getByTestId(`source-remove-keep-${id}`)).toBeChecked();
    await expect(page.getByTestId(`source-remove-drop-${id}`)).toBeVisible();
    // Escape closes it and nothing was removed.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`source-remove-dialog-${id}`)).toHaveCount(0);
    await expect(rowFor(page, 'choice.txt')).toBeVisible();
  });

  test('without brand_brain.upload there is no Upload, Read again or Remove', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('no-upload', { roleKey: 'analyst' });
    await enter(page, target);
    await upload(page, 'en', textFile('owner.txt', tagOf()));
    await waitForStatus(page, 'en', 'owner.txt', 'READY');
    const id = await sourceIdOf(page, 'owner.txt');

    await page.context().clearCookies();
    await enter(page, target, { as: 'member' });
    await page.goto(sourcesUrl('en'));
    await expect(rowFor(page, 'owner.txt')).toBeVisible();
    await expect(page.getByTestId('upload-form')).toHaveCount(0);
    await expect(page.getByTestId(`source-read-again-${id}`)).toHaveCount(0);
    await expect(page.getByTestId(`source-remove-${id}`)).toHaveCount(0);
  });
});

/* ================================================================ D11 */

async function seedPerformance(target: World): Promise<string> {
  return withPlatformPrisma(async (prisma) => {
    const connection = await prisma.socialConnection.create({
      data: {
        workspaceId: target.workspaceId,
        brandId: target.brandId,
        provider: 'LINKEDIN',
        externalAccountId: `e2e-2c4-${randomUUID()}`,
        displayName: 'E2E account',
        targetKind: 'ORGANIZATION',
        status: 'ACTIVE',
      },
    });
    const start = new Date('2026-07-01T00:00:00.000Z');
    const days = 25;
    const values: Record<string, (day: number) => number> = {
      impressions: (day) => (day < 21 ? 1_200 + (day % 3) * 10 : 4_800),
      engagements: (day) => (day < 21 ? 60 + (day % 3) : 260),
      reach: (day) => (day < 21 ? 1_000 + (day % 3) * 10 : 4_000),
    };
    for (const [metricKey, valueOf] of Object.entries(values)) {
      for (let day = 0; day < days; day += 1) {
        const periodStart = new Date(start.getTime() + day * 86_400_000);
        const periodEnd = new Date(periodStart.getTime() + 86_400_000);
        await prisma.metricObservation.create({
          data: {
            workspaceId: target.workspaceId,
            brandId: target.brandId,
            socialConnectionId: connection.id,
            provider: 'LINKEDIN',
            subjectType: 'ACCOUNT',
            subjectExternalId: connection.externalAccountId,
            metricKey,
            granularity: 'DAY',
            periodStart,
            periodEnd,
            value: BigInt(valueOf(day)),
            unit: 'COUNT',
            observedAt: periodEnd,
            sourceKind: 'MOCK',
            sourceVersion: 'e2e-2c4',
            observationKey: createHash('sha256')
              .update(`${connection.id}|${metricKey}|${periodStart.toISOString()}`)
              .digest('hex'),
          },
        });
      }
    }
    const insight = await prisma.insight.create({
      data: {
        workspaceId: target.workspaceId,
        brandId: target.brandId,
        type: 'ANOMALY',
        status: 'NEW',
        basis: 'OWN_PERFORMANCE',
        title: { en: 'Impressions jumped', ar: 'قفزت مرات الظهور' },
        body: {},
        periodStart: start,
        periodEnd: new Date(start.getTime() + days * 86_400_000),
        generatedByUserId: target.ownerId,
      },
    });
    return insight.id;
  });
}

test.describe('D11 · Performance — Save as learning', () => {
  test('saves a PENDING learning once, shows it saved, and needs brand_brain.edit', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('learning', { roleKey: 'analyst' });
    const insightId = await seedPerformance(target);
    await enter(page, target);
    const analytics = `${DASHBOARD_BASE_URL}/en/analytics?brand=${target.brandId}`;
    // A SECOND TAB opened now keeps the button after the first tab saves: the
    // stale form re-posts the same insight, which must add nothing.
    const stale = await page.context().newPage();
    await stale.goto(analytics);
    await page.goto(analytics);
    const save = page.getByTestId(`insight-save-learning-${insightId}`);
    await expect(save).toBeVisible();
    await save.click();
    await page.waitForURL(/ok=LEARNING_SAVED/);
    await expect(page.getByTestId(`insight-learning-${insightId}`)).toHaveText(
      /Saved as learning · waiting for review/,
    );
    await expect(page.getByTestId(`insight-save-learning-${insightId}`)).toHaveCount(0);

    const pending = () =>
      withPlatformPrisma((prisma) =>
        prisma.brandKnowledgeCandidate.findMany({ where: { insightId } }),
      );
    const first = await pending();
    expect(first.length).toBeGreaterThan(0);
    expect(
      first.every(
        (c) => c.status === 'PENDING' && c.area === 'LEARNINGS' && c.sourceKind === 'ANALYTICS',
      ),
    ).toBe(true);

    await stale.getByTestId(`insight-save-learning-${insightId}`).click();
    await stale.waitForURL(/ok=LEARNING_SAVED/);
    expect((await pending()).map((c) => c.id).sort()).toEqual(first.map((c) => c.id).sort());
    await stale.close();

    // It lands in the ONE review inbox.
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    await expect(page.getByTestId('review-inbox-count')).not.toHaveText('0');

    // A member without brand_brain.edit gets no button.
    await page.context().clearCookies();
    await enter(page, target, { as: 'member' });
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?brand=${target.brandId}`);
    await expect(page.getByTestId(`insight-save-learning-${insightId}`)).toHaveCount(0);
  });
});

/* ================================================================ D12 */

test.describe('D12 · Home — facts waiting for review and what is missing', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`one review row, the missing question, and their links (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const target = await world(`home-${locale}`, { roleKey: 'copywriter' });
      await enter(page, target, { locale });
      // Nothing waiting yet: no review row.
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
      await expect(page.getByTestId('attention-brand-brain-review-waiting')).toHaveCount(0);

      await upload(page, locale, textFile('home.txt', tagOf()));
      await waitForStatus(page, locale, 'home.txt', 'READY');
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
      const review = page.getByTestId('attention-brand-brain-review-waiting');
      await expect(review).toContainText(locale === 'ar' ? 'عقل العلامة ·' : 'Brand Brain ·');
      await expect(page.getByTestId('attention-learnings-pending')).toHaveCount(0);
      const missing = page.getByTestId('attention-brand-brain-missing');
      await expect(missing).toContainText(
        locale === 'ar' ? 'عقل العلامة ينقصه:' : 'Brand Brain is missing:',
      );
      await noSeriousViolations(page, '[data-testid="attention-card"]');

      // The missing row opens that area with the question as the placeholder.
      const question = (await missing.textContent())?.split(':').slice(1).join(':').trim() ?? '';
      await page.getByTestId('attention-action-brand-brain-missing').click();
      await expect(page.getByTestId('area-drawer')).toBeVisible();
      await expect(page.getByTestId('new-item-body-en')).toHaveAttribute('placeholder', /.+/);
      expect(question.length).toBeGreaterThan(0);

      // The review row opens the inbox.
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
      await page.getByTestId('attention-action-brand-brain-review-waiting').click();
      await expect(page.getByTestId('intel-card')).toBeVisible();

      // A copywriter (edit, no review) sees the missing row and no review row.
      await page.context().clearCookies();
      await enter(page, target, { locale, as: 'member' });
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
      await expect(page.getByTestId('attention-brand-brain-review-waiting')).toHaveCount(0);
      await expect(page.getByTestId('attention-brand-brain-missing')).toBeVisible();
    });
  }
});

/* ================================================================ D13 + lists */

async function seedAudience(
  target: World,
  input: { key: string; title: string; status?: 'ACTIVE' | 'STALE'; validUntil?: Date | null },
): Promise<string> {
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.brandKnowledgeItem.create({
      data: {
        workspaceId: target.workspaceId,
        brandId: target.brandId,
        area: 'AUDIENCE',
        memory: 'CANONICAL',
        origin: 'HUMAN',
        status: input.status ?? 'ACTIVE',
        itemKey: input.key,
        title: { en: input.title },
        body: { en: `${input.title}.` },
        version: 1,
        validUntil: input.validUntil ?? null,
      },
      select: { id: true },
    });
    return item.id;
  });
}

/** The usable-fact signature, computed from stored rows exactly as the layer does. */
async function currentSignature(target: World): Promise<string> {
  const today = new Date(new Date().toISOString().slice(0, 10));
  return withPlatformPrisma(async (prisma) => {
    const rows = await prisma.brandKnowledgeItem.findMany({
      where: {
        brandId: target.brandId,
        status: { in: ['ACTIVE', 'STALE'] },
        OR: [{ validUntil: null }, { validUntil: { gte: today } }],
      },
      select: { id: true, version: true },
    });
    return knowledgeSignatureOf(rows.map((row) => ({ itemId: row.id, version: row.version })));
  });
}

async function acceptedStrategy(target: World, signature: string | null): Promise<string> {
  return withPlatformPrisma(async (prisma) => {
    const insight = await prisma.insight.create({
      data: {
        workspaceId: target.workspaceId,
        brandId: target.brandId,
        type: 'STRATEGY',
        status: 'ACCEPTED',
        basis: 'BRAND_CONTEXT',
        title: { en: 'Strategy', ar: 'استراتيجية' },
        body: { summary: { en: 'A plan to grow.', ar: 'خطة للنمو.' }, pillars: [], channelMix: [] },
        periodStart: new Date('2026-09-01T00:00:00Z'),
        periodEnd: new Date('2026-09-30T00:00:00Z'),
        generatedByUserId: target.ownerId,
        reviewedByUserId: target.ownerId,
        reviewedAt: new Date(),
        knowledgeSignature: signature,
      },
    });
    return insight.id;
  });
}

test.describe('D13 · Strategy — "Brand Brain changed" only when usable facts change', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`version change and expiry alert; a pending candidate does not (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const target = await world(`strategy-${locale}`);
      const fact = await seedAudience(target, {
        key: 'audience.primary',
        title: 'Bakery founders',
      });
      const strategyId = await acceptedStrategy(target, await currentSignature(target));
      await enter(page, target, { locale });
      const strategyUrl = `${DASHBOARD_BASE_URL}/${locale}/strategy`;
      await page.goto(strategyUrl);
      await expect(page.getByTestId('strategy-objective')).toBeVisible();
      await expect(page.getByTestId('strategy-brain-changed')).toHaveCount(0);

      // A PENDING candidate changes nothing that is usable.
      await withPlatformPrisma((prisma) =>
        prisma.brandKnowledgeCandidate.create({
          data: {
            workspaceId: target.workspaceId,
            brandId: target.brandId,
            sourceKind: 'MEMBER',
            proposedByUserId: target.ownerId,
            area: 'AUDIENCE',
            itemKey: 'audience.pending',
            extractedTitle: { en: 'Only proposed' },
            extractedBody: { en: 'Only proposed.' },
            confidenceMilli: 900,
            evidence: [],
          },
        }),
      );
      await page.goto(strategyUrl);
      await expect(page.getByTestId('strategy-brain-changed')).toHaveCount(0);

      // A new version of a usable fact: the alert.
      await withPlatformPrisma((prisma) =>
        prisma.brandKnowledgeItem.update({
          where: { id: fact },
          data: { version: 2, title: { en: 'Bakery and café founders' } },
        }),
      );
      await page.goto(strategyUrl);
      const alert = page.getByTestId('strategy-brain-changed');
      await expect(alert).toContainText(
        locale === 'ar' ? 'تغيّر عقل العلامة.' : 'Brand Brain changed.',
      );
      await noSeriousViolations(page, '[data-testid="strategy-brain-changed"]');

      // Re-baselined on the current facts, then the fact EXPIRES: the alert again.
      const baseline = await currentSignature(target);
      await withPlatformPrisma((prisma) =>
        prisma.insight.update({
          where: { id: strategyId },
          data: { knowledgeSignature: baseline },
        }),
      );
      await page.goto(strategyUrl);
      await expect(page.getByTestId('strategy-brain-changed')).toHaveCount(0);
      await withPlatformPrisma((prisma) =>
        prisma.brandKnowledgeItem.update({
          where: { id: fact },
          data: { validUntil: new Date('2020-01-01T00:00:00Z') },
        }),
      );
      await page.goto(strategyUrl);
      await expect(page.getByTestId('strategy-brain-changed')).toBeVisible();
    });
  }

  test('an older strategy with no stored signature never alerts', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('strategy-null');
    await seedAudience(target, { key: 'audience.primary', title: 'Bakery founders' });
    await acceptedStrategy(target, null);
    await enter(page, target);
    await page.goto(`${DASHBOARD_BASE_URL}/en/strategy`);
    await expect(page.getByTestId('strategy-objective')).toBeVisible();
    await expect(page.getByTestId('strategy-brain-changed')).toHaveCount(0);
  });

  test('the display lists show usable STALE facts and hide expired ones', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('strategy-lists');
    await seedAudience(target, { key: 'audience.active', title: 'Active audience fact' });
    await seedAudience(target, {
      key: 'audience.stale',
      title: 'Stale but usable audience fact',
      status: 'STALE',
    });
    await seedAudience(target, {
      key: 'audience.expired',
      title: 'Expired audience fact',
      validUntil: new Date('2020-01-01T00:00:00Z'),
    });
    await enter(page, target);
    await page.goto(`${DASHBOARD_BASE_URL}/en/strategy`);
    const audience = page.getByTestId('strategy-audience');
    await expect(audience).toContainText('Active audience fact');
    await expect(audience).toContainText('Stale but usable audience fact');
    await expect(audience).not.toContainText('Expired audience fact');
  });
});
