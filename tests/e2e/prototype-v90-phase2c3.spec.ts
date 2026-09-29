import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { CreditLedgerService } from '@brandspace/entitlements';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v90, Phase 2C-3 — Item 4 in a real browser: Brand Brain chat modes
 * (D7), the Copilot's brand answers (D8), recorded usage in the Studio (D9),
 * a used fact that changed, expired or was replaced (D10), Home "Needs you",
 * and "Used in N posts" (D6).
 *
 * EVERY TEST BUILDS ITS OWN WORKSPACE — one brand, its own credits, its own
 * facts — so nothing another suite reads moves. A second member (the seeded
 * viewer USER) joins it with the role a test needs, which is how the
 * permission-dependent controls are proven as a person meets them. What each
 * path sends a model, and every refusal a direct call meets, is proven against
 * PostgreSQL in tests/isolation/phase2c3-*.test.ts.
 *
 * The AI is the development double (D-13), which answers the structured Ask,
 * the Copilot envelope and captions from the brand's own facts; the credit
 * amounts are the ACTIVE configuration's, read from the quote route, never a
 * number written here.
 */

test.setTimeout(150_000);

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

/** A workspace of its own, with one brand, credits, and optionally a second member. */
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
      const role = await prisma.role.findFirstOrThrow({
        where: { key: member.roleKey, workspaceId: null },
        select: { id: true },
      });
      await prisma.membership.create({
        data: {
          workspaceId,
          userId: viewer.id,
          roleId: role.id,
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
    // Credits of its own, through the real ledger, as the development seed does.
    await prisma.creditWallet.upsert({
      where: { workspaceId },
      create: { workspaceId },
      update: {},
    });
    await new CreditLedgerService({ prisma }).grant({
      workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 1_000,
      reason: 'Phase 2C-3 end-to-end allowance',
      idempotencyKey: `e2e-2c3-grant:${workspaceId}`,
    });
  });
  return { slug, workspaceId, brandId, ownerId };
}

/** Sign in as the workspace owner (or the second member) and enter the workspace. */
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

interface SeededFact {
  readonly id: string;
}

/** An approved fact with its first version row, as the service writes it. */
async function seedFact(
  target: World,
  input: {
    area: 'OFFERS' | 'IDENTITY';
    itemKey: string;
    title: string;
    body: string;
    validUntil?: Date | null;
  },
): Promise<SeededFact> {
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.brandKnowledgeItem.create({
      data: {
        workspaceId: target.workspaceId,
        brandId: target.brandId,
        area: input.area,
        memory: 'CANONICAL',
        origin: 'HUMAN',
        status: 'ACTIVE',
        itemKey: input.itemKey,
        title: { en: input.title },
        body: { en: input.body },
        version: 1,
        validUntil: input.validUntil ?? null,
      },
      select: { id: true },
    });
    await prisma.brandKnowledgeVersion.create({
      data: {
        workspaceId: target.workspaceId,
        brandId: target.brandId,
        knowledgeItemId: item.id,
        version: 1,
        area: input.area,
        memory: 'CANONICAL',
        origin: 'HUMAN',
        status: 'ACTIVE',
        title: { en: input.title },
        body: { en: input.body },
        validUntil: input.validUntil ?? null,
        changeKind: 'created',
      },
    });
    return item;
  });
}

/** A new version of a fact, as an edit elsewhere would write it. */
async function changeFact(
  target: World,
  id: string,
  change: {
    title?: string;
    body?: string;
    validUntil?: Date | null;
    status?: 'ARCHIVED';
    supersededByItemId?: string;
  },
): Promise<void> {
  await withPlatformPrisma(async (prisma) => {
    const current = await prisma.brandKnowledgeItem.findUniqueOrThrow({ where: { id } });
    const updated = await prisma.brandKnowledgeItem.update({
      where: { id },
      data: {
        version: current.version + 1,
        ...(change.title ? { title: { en: change.title } } : {}),
        ...(change.body ? { body: { en: change.body } } : {}),
        ...(change.validUntil !== undefined ? { validUntil: change.validUntil } : {}),
        ...(change.status
          ? {
              status: change.status,
              archivedAt: new Date(),
              supersededByItemId: change.supersededByItemId ?? null,
            }
          : {}),
      },
    });
    await prisma.brandKnowledgeVersion.create({
      data: {
        workspaceId: target.workspaceId,
        brandId: target.brandId,
        knowledgeItemId: id,
        version: updated.version,
        area: updated.area,
        memory: updated.memory,
        origin: updated.origin,
        status: updated.status,
        title: updated.title as never,
        body: updated.body as never,
        validUntil: updated.validUntil,
        changeKind: change.status ? 'archived' : 'edited',
      },
    });
  });
}

/**
 * Generate a caption through the real Studio path — the dashboard's API proxy,
 * called from the signed-in page itself so the browser's session cookie goes
 * with it, exactly as the composer's own request does.
 */
async function generate(page: Page, target: World, brief: string): Promise<string> {
  const result = await page.evaluate(
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
    { brandId: target.brandId, brief, key: `e2e-2c3-${randomUUID()}` },
  );
  expect(result.status, result.body).toBe(200);
  const payload = JSON.parse(result.body) as { itemId: string; variants: { id: string }[] };
  expect(payload.variants.length).toBeGreaterThan(0);
  return payload.itemId;
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

async function openChat(page: Page, locale: 'en' | 'ar' = 'en', query = ''): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain?tab=chat${query}`);
  await expect(page.getByTestId('brand-chat')).toBeVisible();
}

const COLD_BREW = {
  area: 'OFFERS' as const,
  itemKey: 'offers.current',
  title: 'Cold brew offer',
  body: 'Cold brew is two for one on Fridays.',
};

/* ================================================================ D7 · chat */

test.describe('D7 · Brand Brain chat — Ask and the Copilot handoff', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`Ask names the area; a job hands off to the Copilot, prefilled (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const target = await world(`ask-${locale}`);
      await seedFact(target, COLD_BREW);
      await enter(page, target, { locale });
      await openChat(page, locale);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

      // The modes are a radio group, reachable by keyboard.
      await page.getByTestId('chat-mode-ask').focus();
      await page.keyboard.press(locale === 'ar' ? 'ArrowLeft' : 'ArrowRight');
      await expect(page.getByTestId('chat-mode-add')).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('chat-mode-add')).toBeFocused();
      await page.getByTestId('chat-mode-ask').click();

      await page.getByTestId('chat-input').fill('What is the cold brew offer?');
      await page.getByTestId('chat-send').click();
      const answer = page.getByTestId('chat-message-assistant').last();
      await expect(answer).toBeVisible({ timeout: 60_000 });
      await expect(answer.getByTestId('chat-areas')).toContainText(
        locale === 'ar' ? 'العروض' : 'Offers',
      );
      await expect(answer).toContainText('two for one');

      await page.getByTestId('chat-input').fill('make 3 posts about cold brew');
      await page.getByTestId('chat-send').click();
      const job = page.getByTestId('chat-job');
      await expect(job).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('chat-citations').last()).toContainText('Cold brew offer');
      await noSeriousViolations(page, '[data-testid="brand-chat"]');

      const posts = () =>
        withPlatformPrisma((prisma) =>
          prisma.contentItem.count({ where: { workspaceId: target.workspaceId } }),
        );
      expect(await posts()).toBe(0);
      await page.getByTestId('chat-send-to-copilot').click();
      // The Copilot opens with the request written in, and nothing runs.
      await expect(page.getByTestId('copilot-request')).toHaveValue('make 3 posts about cold brew');
      await expect(page.getByTestId('copilot-plan')).toHaveCount(0);
      expect(await posts()).toBe(0);
    });
  }
});

/* ============================================================ D7 · Add */

test.describe('D7 · Add — Add & approve, Send for review, and who sees which', () => {
  test('Add & approve (edit + review) updates the area without a reload; a missing title says so', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('add-approve');
    await enter(page, target);
    await openChat(page);
    await page.getByTestId('chat-mode-add').click();
    await expect(page.getByTestId('chat-add-send-review')).toHaveCount(0);
    await page.getByTestId('chat-add-area').selectOption('OFFERS');
    await page.getByTestId('chat-add-body').fill('Open daily from 8.');
    await page.getByTestId('chat-add-approve').click();
    await expect(page.getByTestId('chat-mode-error')).toContainText('short title');

    await page.getByTestId('chat-add-title').fill('Opening hours');
    await page.getByTestId('chat-add-approve').click();
    await expect(page.getByTestId('chat-mode-done')).toContainText('Added and approved');
    await noSeriousViolations(page, '[data-testid="brand-chat"]');

    // No reload: the Knowledge tab already counts the new fact.
    await page.getByTestId('brand-brain-tabs').getByRole('tab').first().click();
    await expect(page.getByTestId('metric-items')).toHaveText('1');
    const stored = await withPlatformPrisma((prisma) =>
      prisma.brandKnowledgeItem.findFirstOrThrow({
        where: { brandId: target.brandId },
        select: { status: true, origin: true },
      }),
    );
    expect(stored).toEqual({ status: 'ACTIVE', origin: 'HUMAN' });
  });

  for (const locale of ['en', 'ar'] as const) {
    test(`edit without review: Send for review only — a pending MEMBER proposal (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const target = await world(`send-review-${locale}`, { roleKey: 'content_creator' });
      await enter(page, target, { locale, as: 'member' });
      await openChat(page, locale);
      await page.getByTestId('chat-mode-add').click();
      await expect(page.getByTestId('chat-add-approve')).toHaveCount(0);
      await page.getByTestId('chat-add-area').selectOption('OFFERS');
      await page.getByTestId('chat-add-title').fill('Late opening');
      await page.getByTestId('chat-add-body').fill('Open until 11 on Fridays.');
      await page.getByTestId('chat-add-send-review').click();
      await expect(page.getByTestId('chat-mode-done')).toBeVisible();
      const rows = await withPlatformPrisma(async (prisma) => ({
        items: await prisma.brandKnowledgeItem.count({ where: { brandId: target.brandId } }),
        candidate: await prisma.brandKnowledgeCandidate.findFirst({
          where: { brandId: target.brandId },
          select: { status: true, sourceKind: true, proposedByUserId: true },
        }),
      }));
      expect(rows.items).toBe(0);
      expect(rows.candidate).toMatchObject({ status: 'PENDING', sourceKind: 'MEMBER' });
      expect(rows.candidate?.proposedByUserId).not.toBeNull();
    });
  }

  test('review without edit, and a member without edit: Ask only — no Add, Edit or Remove', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('approver', { roleKey: 'approver' });
    await enter(page, target, { as: 'member' });
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain?tab=chat`);
    await expect(page.getByTestId('chat-modes')).toHaveCount(0);
    await expect(page.getByTestId('chat-mode-add')).toHaveCount(0);
  });
});

/* ====================================================== D7 · Edit, Remove */

test.describe('D7 · Edit and Remove — local matching, explicit choice, changed since, Undo', () => {
  test('Edit shows the old text struck through, saves, and refuses a stale version', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('edit');
    const fact = await seedFact(target, COLD_BREW);
    await enter(page, target);
    await openChat(page);
    await page.getByTestId('chat-mode-edit').click();
    await page.getByTestId('chat-input').fill('cold brew');
    await page.getByTestId('chat-send').click();
    // Nothing is chosen for the person.
    await expect(page.getByTestId(`chat-match-${fact.id}`)).toBeVisible();
    await expect(page.getByTestId('chat-edit-form')).toHaveCount(0);
    await page.getByTestId(`chat-match-${fact.id}`).click();
    await expect(page.getByTestId('chat-edit-old').locator('s')).toContainText('two for one');
    await page.getByTestId('chat-edit-body').fill('Cold brew is three for two on Fridays.');
    await page.getByTestId('chat-edit-save').click();
    await expect(page.getByTestId('chat-mode-done')).toBeVisible();

    // Somebody else edits it now; saving over the version on screen is refused.
    await changeFact(target, fact.id, { body: 'Cold brew is half price on Mondays.' });
    await page.getByTestId('chat-edit-body').fill('My later edit.');
    await page.getByTestId('chat-edit-save').click();
    await expect(page.getByTestId('chat-mode-error')).toContainText(/changed since/i);
    await expect(page.getByTestId('chat-edit-old').locator('s')).toContainText('half price');
    const stored = await withPlatformPrisma((prisma) =>
      prisma.brandKnowledgeItem.findUniqueOrThrow({ where: { id: fact.id } }),
    );
    expect(stored.body).toEqual({ en: 'Cold brew is half price on Mondays.' });
  });

  test('Remove archives the chosen fact and Undo restores it, once', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('remove');
    const fact = await seedFact(target, COLD_BREW);
    await enter(page, target);
    await openChat(page);
    await page.getByTestId('chat-mode-remove').click();
    await page.getByTestId('chat-input').fill('cold brew');
    await page.getByTestId('chat-send').click();
    await page.getByTestId(`chat-match-${fact.id}`).click();
    await page.getByTestId('chat-remove-go').click();
    await expect(page.getByTestId('chat-removed')).toBeVisible();
    const status = () =>
      withPlatformPrisma(
        async (prisma) =>
          (await prisma.brandKnowledgeItem.findUniqueOrThrow({ where: { id: fact.id } })).status,
      );
    expect(await status()).toBe('ARCHIVED');
    await noSeriousViolations(page, '[data-testid="brand-chat"]');
    await page.getByTestId('chat-undo').click();
    await expect(page.getByTestId('chat-mode-done')).toBeVisible();
    expect(await status()).toBe('ACTIVE');
    await expect(page.getByTestId('chat-undo')).toHaveCount(0);
  });
});

/* ============================================================ D8 · Copilot */

test.describe('D8 · the Copilot answers from the same facts and never saves one', () => {
  test('areas named, a missing fact said, and a save handed to Brand Brain Add', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('copilot');
    await seedFact(target, COLD_BREW);
    await enter(page, target);
    await page.goto(`${DASHBOARD_BASE_URL}/en/copilot`);

    await page.getByTestId('copilot-request').fill('What is the cold brew offer?');
    await page.getByTestId('copilot-propose').click();
    await expect(page.getByTestId('copilot-brand-areas')).toContainText('Offers', {
      timeout: 60_000,
    });

    await page.getByTestId('copilot-request').fill('What are your prices?');
    await page.getByTestId('copilot-propose').click();
    await expect(page.getByTestId('copilot-brand-missing')).toContainText(
      'Brand Brain doesn’t have',
      { timeout: 60_000 },
    );

    const before = await withPlatformPrisma((prisma) =>
      prisma.brandKnowledgeItem.count({ where: { brandId: target.brandId } }),
    );
    await page.getByTestId('copilot-request').fill('Save that we open at 8 on Sundays');
    await page.getByTestId('copilot-propose').click();
    await expect(page.getByTestId('copilot-save-handoff')).toBeVisible({ timeout: 60_000 });
    expect(
      await withPlatformPrisma((prisma) =>
        prisma.brandKnowledgeItem.count({ where: { brandId: target.brandId } }),
      ),
    ).toBe(before);
    await page.getByTestId('copilot-save-handoff-link').click();
    await expect(page.getByTestId('chat-add-form')).toBeVisible();
    await expect(page.getByTestId('chat-add-title')).toHaveValue(
      'Save that we open at 8 on Sundays',
    );
    // Still nothing saved until the person adds it.
    expect(
      await withPlatformPrisma((prisma) =>
        prisma.brandKnowledgeItem.count({ where: { brandId: target.brandId } }),
      ),
    ).toBe(before);
  });
});

/* ============================================================== D9 · usage */

test.describe('D9 · the Studio shows the facts a caption used', () => {
  test('Used N Brand Brain facts, Fix it for brand_brain.edit, and Used in N posts', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('usage', { roleKey: 'analyst' });
    const offer = await seedFact(target, COLD_BREW);
    await seedFact(target, {
      area: 'IDENTITY',
      itemKey: 'identity.location',
      title: 'Downtown kiosk',
      body: 'Our cold brew kiosk is downtown.',
    });
    await enter(page, target);
    const itemId = await generate(page, target, 'cold brew downtown');
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    await expect(page.getByTestId('variant-facts-count')).toHaveText('Used 2 Brand Brain facts');
    await expect(page.getByTestId(`variant-fact-${offer.id}`)).toContainText('Cold brew offer');
    await expect(page.getByTestId(`variant-fact-state-${offer.id}`)).toHaveText('current');
    await noSeriousViolations(page, '[data-testid="variant-facts"]');

    // "Used in N posts" on the fact, from the recorded usage.
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    await page.getByTestId('area-card-OFFERS').click();
    await expect(page.getByTestId(`bb-used-in-${offer.id}`)).toHaveText('Used in 1 post');

    // Fix it opens that fact in Brand Brain's Edit mode.
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    await page.getByTestId(`variant-fact-fix-${offer.id}`).click();
    await expect(page.getByTestId('chat-edit-form')).toBeVisible();
    await expect(page.getByTestId('chat-edit-title')).toHaveValue('Cold brew offer');

    // A member without brand_brain.edit reads the list, and gets no Fix it.
    await page.context().clearCookies();
    await enter(page, target, { as: 'member' });
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    await expect(page.getByTestId(`variant-fact-${offer.id}`)).toBeVisible();
    await expect(page.getByTestId(`variant-fact-fix-${offer.id}`)).toHaveCount(0);
  });
});

/* ================================================================ D10 */

test.describe('D10 · a used fact changed, expired or was replaced', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`changed: banner, Keep as is, and the alert returns on a new change (${locale})`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const target = await world(`changed-${locale}`);
      const offer = await seedFact(target, COLD_BREW);
      await enter(page, target, { locale });
      const itemId = await generate(page, target, 'cold brew');
      await changeFact(target, offer.id, { body: 'Cold brew is three for two on Fridays.' });

      const compose = `${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`;
      await page.goto(compose);
      const banner = page.getByTestId('fact-change-banner');
      await expect(banner).toBeVisible();
      await expect(page.getByTestId(`fact-change-${offer.id}`)).toHaveAttribute(
        'data-kind',
        'changed',
      );
      const rewrite = page.getByTestId('fact-rewrite');
      await expect(rewrite).toHaveText(
        locale === 'ar'
          ? /أعد الكتابة بالمعلومة الجديدة · نحو [\d٠-٩.,]+ رصيد/
          : /Rewrite with the new fact · about [\d.,]+ credits/,
      );
      await noSeriousViolations(page, '[data-testid="fact-change-banner"]');

      await page.getByTestId(`fact-keep-${offer.id}`).click();
      await page.waitForURL(/ok=FACT_CHANGE_KEPT/);
      await expect(page.getByTestId('fact-change-banner')).toHaveCount(0);

      await changeFact(target, offer.id, { body: 'Cold brew is half price all week.' });
      await page.goto(compose);
      await expect(page.getByTestId('fact-change-banner')).toBeVisible();
    });
  }

  test('expired: "Rewrite without this fact", priced by the quote path, records the new usage', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('expired');
    const offer = await seedFact(target, COLD_BREW);
    const place = await seedFact(target, {
      area: 'IDENTITY',
      itemKey: 'identity.location',
      title: 'Downtown kiosk',
      body: 'Our cold brew kiosk is downtown.',
    });
    await enter(page, target);
    const itemId = await generate(page, target, 'cold brew downtown');
    await changeFact(target, offer.id, { validUntil: new Date('2020-01-01T00:00:00Z') });

    const quoted = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/content/tool-quote') &&
        (response.request().postData() ?? '').includes('refresh_facts'),
    );
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    const quote = (await (await quoted).json()) as { estimateMilli: string };
    expect(Number(quote.estimateMilli)).toBeGreaterThan(0);
    await expect(page.getByTestId(`fact-change-${offer.id}`)).toHaveAttribute(
      'data-kind',
      'expired',
    );
    const rewrite = page.getByTestId('fact-rewrite');
    await expect(rewrite).toHaveText(/^Rewrite without this fact · about [\d.,]+ credits$/);

    const ran = page.waitForResponse((response) => response.url().endsWith('/api/content/tool'));
    await rewrite.click();
    expect((await ran).status()).toBe(200);
    await expect(page.getByTestId('fact-change-banner')).toHaveCount(0, { timeout: 30_000 });

    const usage = await withPlatformPrisma((prisma) =>
      prisma.contentKnowledgeUsage.findMany({
        where: { contentItemId: itemId, supersededAt: null },
        select: { knowledgeItemId: true },
      }),
    );
    expect(usage.map((row) => row.knowledgeItemId)).toEqual([place.id]);
  });

  test('replaced: old → replacement, and the rewrite uses the replacement', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('replaced');
    const old = await seedFact(target, COLD_BREW);
    await enter(page, target);
    const itemId = await generate(page, target, 'cold brew');
    const replacement = await seedFact(target, {
      area: 'OFFERS',
      itemKey: 'offers.autumn',
      title: 'Autumn cold brew offer',
      body: 'Cold brew comes with a free pastry this autumn.',
    });
    await changeFact(target, old.id, { status: 'ARCHIVED', supersededByItemId: replacement.id });
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    const line = page.getByTestId(`fact-change-${old.id}`);
    await expect(line).toHaveAttribute('data-kind', 'replaced');
    await expect(line).toContainText('Autumn cold brew offer');
    await expect(page.getByTestId('fact-rewrite')).toHaveText(/Rewrite with the new fact/);
    await page.getByTestId('fact-rewrite').click();
    await expect(page.getByTestId('fact-change-banner')).toHaveCount(0, { timeout: 30_000 });
    const usage = await withPlatformPrisma((prisma) =>
      prisma.contentKnowledgeUsage.findMany({
        where: { contentItemId: itemId, supersededAt: null },
        select: { knowledgeItemId: true },
      }),
    );
    expect(usage.map((row) => row.knowledgeItemId)).toEqual([replacement.id]);
  });

  test('Home "Needs you" lists a scheduled post whose fact changed — and it stays scheduled', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const target = await world('needs-you');
    const offer = await seedFact(target, COLD_BREW);
    await enter(page, target);
    const itemId = await generate(page, target, 'cold brew');
    await withPlatformPrisma((prisma) =>
      prisma.contentItem.update({ where: { id: itemId }, data: { status: 'SCHEDULED' } }),
    );
    await changeFact(target, offer.id, { body: 'Cold brew is half price all week.' });
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const row = page.getByTestId('attention-brand-brain-fact-changed');
    await expect(row).toBeVisible();
    await expect(page.getByTestId('attention-action-brand-brain-fact-changed')).toHaveAttribute(
      'href',
      `/en/content/compose?item=${itemId}`,
    );
    const stored = await withPlatformPrisma((prisma) =>
      prisma.contentItem.findUniqueOrThrow({ where: { id: itemId }, select: { status: true } }),
    );
    expect(stored.status).toBe('SCHEDULED');
  });
});
