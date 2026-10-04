import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v90, Phase 2C-1 — Brand Brain v2: grounding (item 1) and knowledge,
 * review and completeness (item 2), as a person meets them in a real browser.
 *
 * EVERY TEST CREATES ITS OWN WORKSPACE with one brand, so nothing another suite
 * reads moves, and runs once (the desktop project) unless it is about the
 * phone. What each path SENDS a model is proven against PostgreSQL in
 * tests/isolation/phase2c-grounding.test.ts; this file proves the screens.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

/** A workspace of its own, owned by the e2e customer, with one ACTIVE brand. */
async function ownWorkspace(
  label: string,
  timezone = 'UTC',
): Promise<{ slug: string; brandId: string; workspaceId: string }> {
  const { customer } = credentials();
  const slug = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  const brandId = randomUUID();
  const workspaceId = randomUUID();
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    const role = await prisma.role.findFirstOrThrow({
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
        timezone,
        currency: 'USD',
      },
    });
    await prisma.membership.create({
      data: {
        workspaceId,
        userId: owner.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
    await prisma.brand.create({
      data: {
        id: brandId,
        workspaceId,
        slug: `${slug}-brand`,
        name: `${label} Brand`,
        status: 'ACTIVE',
      },
    });
  });
  return { slug, brandId, workspaceId };
}

async function enter(page: Page, slug: string, locale = 'en'): Promise<void> {
  await signIn(page, locale);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/workspaces`);
  await page.click(`[data-testid="choose-workspace-${slug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

async function noSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test.describe('Item 1 · Settings → AI "Use Brand Brain" (D9)', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the switch saves and reads back, by keyboard, in ${locale}`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const { slug, brandId } = await ownWorkspace(`bb-switch-${locale}`);
      await enter(page, slug, locale);

      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/ai`);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      const toggle = page.getByTestId(`ai-use-brand-brain-${brandId}`);
      await expect(toggle).toBeChecked();
      await noSeriousViolations(page);

      await toggle.focus();
      await page.keyboard.press('Space');
      await expect(toggle).not.toBeChecked();
      await page.getByTestId(`ai-save-${brandId}`).click();
      await page.waitForURL(/ok=SETTINGS_SAVED/);
      await expect(page.getByTestId(`ai-use-brand-brain-${brandId}`)).not.toBeChecked();

      const stored = await withPlatformPrisma((prisma) =>
        prisma.brand.findUniqueOrThrow({
          where: { id: brandId },
          select: { useBrandBrain: true },
        }),
      );
      expect(stored.useBrandBrain).toBe(false);
    });
  }
});

/* ------------------------------------------------------------------ item 2 */

interface SeededFact {
  readonly id: string;
}

async function seedFact(
  workspaceId: string,
  brandId: string,
  input: {
    area: 'IDENTITY' | 'OFFERS' | 'AUDIENCE' | 'TONE_OF_VOICE' | 'DO_DONT';
    itemKey: string;
    text: string;
    validUntil?: string;
    origin?: 'HUMAN' | 'DOCUMENT';
  },
): Promise<SeededFact> {
  return withPlatformPrisma(async (prisma) => {
    const item = await prisma.brandKnowledgeItem.create({
      data: {
        workspaceId,
        brandId,
        area: input.area,
        memory: 'CANONICAL',
        origin: input.origin ?? 'HUMAN',
        status: 'ACTIVE',
        itemKey: input.itemKey,
        title: { en: input.text },
        body: { en: input.text },
        version: 1,
        ...(input.validUntil ? { validUntil: new Date(`${input.validUntil}T00:00:00Z`) } : {}),
      },
      select: { id: true },
    });
    await prisma.brandKnowledgeVersion.create({
      data: {
        workspaceId,
        brandId,
        knowledgeItemId: item.id,
        version: 1,
        area: input.area,
        memory: 'CANONICAL',
        origin: input.origin ?? 'HUMAN',
        status: 'ACTIVE',
        title: { en: input.text },
        body: { en: input.text },
        changeKind: 'created',
      },
    });
    return item;
  });
}

async function seedCandidates(
  workspaceId: string,
  brandId: string,
  rows: readonly { itemKey: string; text: string; confidenceMilli: number; hits: number }[],
): Promise<string[]> {
  return withPlatformPrisma(async (prisma) => {
    const run = randomUUID().slice(0, 8);
    const document = await prisma.brandSourceDocument.create({
      data: {
        workspaceId,
        brandId,
        fileName: `guide-${run}.txt`,
        mimeType: 'text/plain',
        byteSize: 10,
        checksum: `e2e-${run}`,
        storageKey: `ws/${workspaceId}/brand-brain/e2e-${run}`,
        status: 'READY',
        idempotencyKey: `e2e-${run}`,
      },
      select: { id: true },
    });
    const ids: string[] = [];
    for (const row of rows) {
      const created = await prisma.brandKnowledgeCandidate.create({
        data: {
          workspaceId,
          brandId,
          sourceDocumentId: document.id,
          area: 'AUDIENCE',
          itemKey: row.itemKey,
          extractedTitle: { en: row.text },
          extractedBody: { en: row.text },
          confidenceMilli: row.confidenceMilli,
          evidence: [
            { locator: 'page 1', quote: row.text, method: 'keyword', keywordHits: row.hits },
          ],
          status: 'PENDING',
        },
        select: { id: true },
      });
      ids.push(created.id);
      // Oldest first in the inbox: keep the creation order observable.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return ids;
  });
}

/** "Review one by one" — a client toggle, pressed until the review card is there. */
async function openReview(page: Page): Promise<void> {
  await expect(async () => {
    await page.getByTestId('review-one-by-one').click();
    await expect(page.getByTestId('intel-card')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
}

async function openBrandBrain(page: Page, locale = 'en', tab?: string): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain${tab ? `?tab=${tab}` : ''}`);
  await expect(page.getByTestId('brand-brain-tabs')).toBeVisible();
}

test.describe('Item 2 · D1 tabs', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`four tabs, keyboard-operable, addressable — ${locale}`, async ({ page, isMobile }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const { slug } = await ownWorkspace(`bb-tabs-${locale}`);
      await enter(page, slug, locale);
      await openBrandBrain(page, locale);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');

      const tabs = page.getByTestId('brand-brain-tabs').getByRole('tab');
      await expect(tabs).toHaveCount(4);
      await expect(page.getByTestId('tab-knowledge')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('area-grid')).toBeVisible();
      await noSeriousViolations(page);

      // Arrow keys move along the list in reading order (right-to-left in Arabic).
      await page.getByTestId('tab-knowledge').focus();
      await page.keyboard.press(locale === 'ar' ? 'ArrowLeft' : 'ArrowRight');
      await expect(page.getByTestId('tab-look')).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId('voice-card')).toBeVisible();
      await expect(page).toHaveURL(/tab=look/);

      await page.getByTestId('tab-sources').click();
      await expect(page.getByTestId('sources-card')).toBeVisible();

      // "Talk with the brand" is the prototype's chat card, on its own.
      await page.getByTestId('tab-chat').click();
      await expect(page.getByTestId('brand-chat')).toBeVisible();
      await expect(page.getByTestId('area-grid')).toHaveCount(0);

      // The address survives a reload.
      await openBrandBrain(page, locale, 'sources');
      await expect(page.getByTestId('tab-sources')).toHaveAttribute('aria-selected', 'true');
    });
  }

  test('"Identity" reads "About the business"', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug } = await ownWorkspace('bb-rename');
    await enter(page, slug);
    await openBrandBrain(page);
    await expect(page.getByTestId('area-card-IDENTITY')).toContainText('About the business');
  });
});

test.describe('Item 2 · Q19 key questions and "What\'s missing"', () => {
  test('answered n of m; a missing question opens its area with its key and placeholder', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug } = await ownWorkspace('bb-questions');
    await enter(page, slug);
    await openBrandBrain(page);

    const hero = page.getByTestId('completion-answered');
    await expect(hero).toHaveText(/^answered 0 of \d+$/);
    await expect(hero).not.toContainText('%');
    await expect(page.getByTestId('area-answered-IDENTITY')).toHaveText(/^0 of 4 key questions/);

    const missing = page.getByTestId('brand-brain-missing-identity.what');
    await expect(missing).toBeVisible();
    await missing.click();
    const drawer = page.getByTestId('area-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('new-item-key')).toHaveValue('identity.what');
    await expect(page.getByTestId('new-item-body-en')).toHaveAttribute(
      'placeholder',
      'What does your business do?',
    );
    await page.getByTestId('new-item-title-en').fill('What we do');
    await page.getByTestId('new-item-body-en').fill('We roast coffee for offices.');
    await page.getByTestId('save-knowledge').click();
    await page.waitForURL(/ok=KNOWLEDGE_SAVED/);

    await expect(page.getByTestId('area-answered-IDENTITY')).toHaveText(/^1 of 4 key questions/);
    await expect(page.getByTestId('brand-brain-missing-identity.what')).toHaveCount(0);
  });
});

test.describe('Item 2 · D4 the one review inbox', () => {
  test('one card at a time, with confidence in words, Later and Accept', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId, workspaceId } = await ownWorkspace('bb-inbox');
    const [high, low] = await seedCandidates(workspaceId, brandId, [
      {
        itemKey: 'audience.founders',
        text: 'Founders of small cafés',
        confidenceMilli: 900,
        hits: 2,
      },
      { itemKey: 'audience.students', text: 'University students', confidenceMilli: 600, hits: 0 },
    ]);
    await enter(page, slug);
    await openBrandBrain(page);

    await expect(page.getByTestId('review-inbox-count')).toHaveText(
      '2 facts waiting for your review',
    );
    // The prototype's banner opens the one review card.
    await openReview(page);
    await expect(page.getByTestId(`intel-${high}`)).toBeVisible();
    await expect(page.getByTestId(`intel-${low}`)).toHaveCount(0);
    await expect(page.getByTestId(`intel-confidence-${high}`)).toContainText('High confidence');
    await expect(page.getByTestId(`intel-confidence-${high}`)).toContainText('holds 2');
    await expect(page.getByTestId(`inbox-snippet-${high}`)).toContainText(
      'Founders of small cafés',
    );
    await noSeriousViolations(page);

    await page.getByTestId(`later-${high}`).click();
    await expect(page.getByTestId(`intel-${low}`)).toBeVisible();
    await expect(page.getByTestId(`intel-confidence-${low}`)).toContainText('Low confidence');
    await page.getByTestId(`later-${low}`).click();

    await page.getByTestId(`accept-${high}`).click();
    await page.waitForURL(/ok=CANDIDATE_ACCEPTED/);
    await expect(page.getByTestId('review-inbox-count')).toHaveText(
      '1 facts waiting for your review',
    );
    // The card stays open across its own post.
    await expect(page.getByTestId(`intel-${low}`)).toBeVisible();
  });

  test('"Accept the confident ones" previews, asks, and accepts only those', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId, workspaceId } = await ownWorkspace('bb-bulk');
    const [a, b, lowId] = await seedCandidates(workspaceId, brandId, [
      { itemKey: 'audience.cafes', text: 'Café owners', confidenceMilli: 900, hits: 2 },
      { itemKey: 'audience.offices', text: 'Office managers', confidenceMilli: 950, hits: 3 },
      { itemKey: 'audience.guess', text: 'Maybe tourists', confidenceMilli: 500, hits: 0 },
    ]);
    await enter(page, slug);
    await openBrandBrain(page);

    await page.getByTestId('accept-confident-open').click();
    const dialog = page.getByTestId('accept-confident-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId(`accept-confident-${a}`)).toBeVisible();
    await expect(page.getByTestId(`accept-confident-${b}`)).toBeVisible();
    await expect(page.getByTestId(`accept-confident-${lowId}`)).toHaveCount(0);
    await noSeriousViolations(page);

    // Cancel changes nothing.
    await page.getByTestId('accept-confident-cancel').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('review-inbox-count')).toHaveText(
      '3 facts waiting for your review',
    );

    await page.getByTestId('accept-confident-open').click();
    await page.getByTestId('accept-confident-confirm').click();
    await page.waitForURL(/ok=CANDIDATES_ACCEPTED/);
    await expect(page.getByTestId('review-inbox-count')).toHaveText(
      '1 facts waiting for your review',
    );
    await openReview(page);
    await expect(page.getByTestId(`intel-${lowId}`)).toBeVisible();
  });

  test('a candidate that would replace a person’s fact: side by side, no Accept, Edit fact', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId, workspaceId } = await ownWorkspace('bb-conflict');
    await seedFact(workspaceId, brandId, {
      area: 'AUDIENCE',
      itemKey: 'audience.core',
      text: 'Busy parents',
    });
    const [proposal] = await seedCandidates(workspaceId, brandId, [
      { itemKey: 'audience.core', text: 'Retired teachers', confidenceMilli: 900, hits: 2 },
    ]);
    await enter(page, slug);
    await openBrandBrain(page);
    await openReview(page);

    await expect(page.getByTestId(`inbox-current-${proposal}`)).toContainText('Busy parents');
    await expect(page.getByTestId(`inbox-proposed-${proposal}`)).toContainText('Retired teachers');
    await expect(page.getByTestId(`accept-${proposal}`)).toHaveCount(0);
    await expect(page.getByTestId(`inbox-precedence-${proposal}`)).toBeVisible();
    await expect(page.getByTestId(`reject-${proposal}`)).toBeVisible();

    await page.getByTestId(`edit-fact-${proposal}`).click();
    await expect(page.getByTestId('area-drawer')).toBeVisible();
    await expect(page.getByTestId('area-drawer')).toContainText('Busy parents');
  });
});

test.describe('Item 2 · D6 valid until', () => {
  test('an expired fact says so; an end date is set in the workspace calendar', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId, workspaceId } = await ownWorkspace('bb-expiry', 'Asia/Riyadh');
    const expired = await seedFact(workspaceId, brandId, {
      area: 'OFFERS',
      itemKey: 'offers.summer',
      text: 'Summer two-for-one',
      validUntil: '2020-08-31',
    });
    const current = await seedFact(workspaceId, brandId, {
      area: 'OFFERS',
      itemKey: 'offers.what',
      text: 'Coffee beans and brewing kits',
    });
    await enter(page, slug);
    await openBrandBrain(page);

    await page.getByTestId('area-card-OFFERS').click();
    await expect(page.getByTestId(`bb-expired-${expired.id}`)).toHaveText(
      'Expired · not used in writing',
    );

    // The prototype's Edit button opens the fact's edit box in place.
    await page.getByTestId(`edit-item-${current.id}`).click();
    await page.getByTestId(`valid-until-${current.id}`).fill('2099-12-31');
    await page.getByTestId(`save-item-${current.id}`).click();
    await page.waitForURL(/ok=KNOWLEDGE_SAVED/);
    await page.getByTestId('area-card-OFFERS').click();
    await expect(page.getByTestId(`bb-valid-until-${current.id}`)).toHaveText(
      'Valid until 2099-12-31',
    );
  });
});

test.describe('Item 2 · C4 the Voice card', () => {
  test('voice words and a Do rule are saved to Brand Brain, in Arabic too', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug } = await ownWorkspace('bb-voice');
    await enter(page, slug, 'ar');
    await openBrandBrain(page, 'ar', 'look');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await noSeriousViolations(page);

    await page.getByTestId('voice-words-ar').fill('ودود، واضح');
    await page.getByTestId('voice-words-save').click();
    await page.waitForURL(/tab=look/);
    await expect(page.getByTestId('voice-words-value')).toHaveText('ودود، واضح');

    await page.getByTestId('voice-do-add-ar').fill('اذكر اسم الحي دائمًا');
    await page.getByTestId('voice-do-add-submit').click();
    await page.waitForURL(/tab=look/);
    await expect(page.getByTestId('voice-do')).toContainText('اذكر اسم الحي دائمًا');
  });
});

test.describe('Item 1 · the composer’s goal and pillar ideas are writing input (D-354)', () => {
  /*
   * Owner review of PR #52. Picking a goal or pillar idea puts its words into
   * the AI brief, and the recommended goal is appended to the brief the model
   * reads, so the composer reads them through the Brand Brain grounding layer:
   * never an expired goal, and nothing at all while "Use Brand Brain" is off.
   * The layer's rules are proven against PostgreSQL in
   * tests/isolation/phase2c-grounding-layer.test.ts; this is the screen.
   */
  test('an expired goal and "Use Brand Brain" off each take the Brand Brain ideas away', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId, workspaceId } = await ownWorkspace('bb-composer');
    const seeded = await withPlatformPrisma(async (prisma) => {
      const fact = (itemKey: string, title: string) =>
        prisma.brandKnowledgeItem.create({
          data: {
            workspaceId,
            brandId,
            area: 'STRATEGY',
            memory: 'STRATEGY',
            origin: 'HUMAN',
            status: 'ACTIVE',
            itemKey,
            title: { en: title },
            body: { en: title },
            version: 1,
          },
          select: { id: true },
        });
      // The objective's own English label, so the goal is recognised (D-278).
      const goal = await fact('goal.primary', 'Launch something');
      const pillar = await fact('pillar.recipes', 'Seasonal recipes');
      return { goalId: goal.id, pillarId: pillar.id };
    });
    const compose = (mode: 'idea' | 'ai') =>
      page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=${mode}`);
    const setGoalValidUntil = (validUntil: Date | null) =>
      withPlatformPrisma((prisma) =>
        prisma.brandKnowledgeItem.update({ where: { id: seeded.goalId }, data: { validUntil } }),
      );
    const setSwitch = (useBrandBrain: boolean) =>
      withPlatformPrisma((prisma) =>
        prisma.brand.update({ where: { id: brandId }, data: { useBrandBrain } }),
      );

    await enter(page, slug);

    // Usable, and the switch on: both ideas, and the recommendation.
    await compose('idea');
    await expect(page.getByTestId('create-idea-goal')).toContainText('Launch something');
    await expect(page.getByTestId(`create-idea-pillar-${seeded.pillarId}`)).toContainText(
      'Seasonal recipes',
    );
    await compose('ai');
    // Review of #67 — the goal and its recommendation are under "⋯".
    await page.getByTestId('content-more').click();
    await expect(page.getByTestId('content-goal-recommended')).toBeVisible();

    // The goal EXPIRED: no goal idea and no recommendation; the pillar stays.
    await setGoalValidUntil(new Date('2000-01-01T00:00:00Z'));
    await compose('idea');
    await expect(page.getByTestId(`create-idea-pillar-${seeded.pillarId}`)).toBeVisible();
    await expect(page.getByTestId('create-idea-goal')).toHaveCount(0);
    await compose('ai');
    await expect(page.getByTestId('content-brief')).toBeVisible();
    await expect(page.getByTestId('content-goal-recommended')).toHaveCount(0);

    // Usable again, but "Use Brand Brain" OFF: nothing from Brand Brain at all.
    await setGoalValidUntil(null);
    await setSwitch(false);
    await compose('idea');
    await expect(page.getByTestId('create-idea-goal')).toHaveCount(0);
    await expect(page.getByTestId(`create-idea-pillar-${seeded.pillarId}`)).toHaveCount(0);
    await compose('ai');
    await expect(page.getByTestId('content-brief')).toBeVisible();
    await expect(page.getByTestId('content-goal-recommended')).toHaveCount(0);
  });
});
