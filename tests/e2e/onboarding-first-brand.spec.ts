import crypto from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { withPlatformPrisma } from './platform-prisma';

/**
 * ONBOARDING HAS TO END WITH A USABLE BRAND.
 *
 * THE DEFECT. The checklist's BRAND step pointed at `/settings/brand`, which
 * EDITS a brand: that page calls `requiredBrand`, so a workspace with none of
 * them has nothing for it to show and no way to make one. The first step of
 * onboarding sent a new customer to a screen that could not complete it, and
 * they finished the wizard holding a workspace and no brand — with every module
 * downstream of a brand (content, the calendar, approvals, publishing,
 * analytics) unreachable behind that gap.
 *
 * The second defect is next to it: `createBrandAction` had no replay guard at
 * all, so a double submit or a second walk through the checklist made ANOTHER
 * brand with the same name and a different slug. Nothing in the product merges
 * those afterwards, and a workspace with two identical-looking brands has its
 * content, knowledge and analytics split between them.
 *
 * A BROWSER TEST, because both defects are in the wiring between pages: the
 * services were never wrong.
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'an-end-to-end-fixture-password';
const BRAND_NAME = 'Onboarding Brand';

async function signUpVerifyAndSignIn(page: Page, locale = 'en'): Promise<string> {
  const email = `onb-e2e-${crypto.randomUUID().slice(0, 12)}@example.local`;

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-up`);
  await expect(page.locator('[data-testid="signup-form"]')).toBeVisible();
  await page.fill('#name', 'Onboarding Journey');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  // P6-03a: sign-up now asks for the password twice. The confirmation is the
  // customer's own check against a typo — the server validates the password
  // itself and never reads this field — but it IS required, so a journey that
  // skips it is a journey the browser will not submit.
  await page.fill('#password-confirm', PASSWORD);
  await page.fill('#timezone', 'Europe/London');
  await page.press('#timezone', 'Enter');
  await page.check('[data-testid="accept-terms-of-service"] input[type="checkbox"]');
  await page.click('[data-testid="signup-submit"]');
  await expect(page.locator('[data-testid="signup-sent"]')).toBeVisible();

  // The mailbox is not the subject here, so the token is minted directly.
  const token = await withPlatformPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const raw = crypto.randomBytes(32).toString('base64url');
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return raw;
  });

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/verify?token=${encodeURIComponent(token)}`);
  await expect(page.locator('[data-testid="verify-success"]')).toBeVisible();

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(new RegExp(`/${locale}/onboarding/workspace$`), { timeout: 30_000 });
  return email;
}

async function createWorkspace(page: Page, locale = 'en'): Promise<void> {
  await expect(page.locator('[data-testid="create-workspace-form"]')).toBeVisible();
  await page.fill('#name', 'Onboarding Workspace');
  await page.fill('#slug', `onb-${crypto.randomUUID().slice(0, 8)}`);
  const countryName = new Intl.DisplayNames(['en'], { type: 'region' }).of('GB') ?? 'GB';
  await page.fill('[data-testid="country-select"]', countryName);
  await page.press('[data-testid="country-select"]', 'Enter');
  await page.selectOption('#defaultLocale', 'EN');
  await page.fill('[data-testid="timezone-select"]', 'Europe/London');
  await page.press('[data-testid="timezone-select"]', 'Enter');
  await page.fill('#billingEmail', `finance-${crypto.randomUUID().slice(0, 8)}@example.local`);
  await page.click('[data-testid="create-workspace-submit"]');
  await page.waitForURL(new RegExp(`/${locale}/onboarding$`), { timeout: 30_000 });
}

test.describe('onboarding reaches a first real brand', () => {
  /*
   * PHASE 6 FINAL (D-277 §6): THE CHECKLIST BECAME A GUIDED WIZARD.
   *
   * The defect above cannot recur in the same shape — the brand is created ON
   * the wizard's own first step, not on a page a link points at — but the
   * assertion that matters is the same: a new customer finishes setup holding
   * a real brand. This walks the whole journey the owner specified, against
   * the real services and the real worker: add a brand, give the Brand Brain a
   * document, review what it extracted, skip connecting, choose a first goal,
   * land on "You're ready to start".
   */
  test('THE HAPPY PATH: the wizard walks from a new workspace to “You’re ready to start”', async ({
    page,
  }) => {
    test.slow();
    const email = await signUpVerifyAndSignIn(page);
    await createWorkspace(page);

    // The wizard is showing, on the brand step, and only the workspace is done.
    const wizard = page.getByTestId('setup-wizard');
    await expect(wizard).toHaveAttribute('data-view', 'brand');
    await expect(page.locator('[data-testid="onboarding-step-workspace"]')).toHaveAttribute(
      'data-complete',
      'true',
    );
    const brandStep = page.locator('[data-testid="onboarding-step-brand"]');
    await expect(brandStep).toHaveAttribute('data-complete', 'false');

    // English is preselected as the brand's content language (D-277).
    await expect(page.getByTestId('setup-brand-locale')).toHaveValue('EN');

    // --- Step 2: the brand, created on the wizard's own screen.
    await page.fill('[data-testid="setup-brand-name"]', BRAND_NAME);
    await page.fill('#setup-brand-website', 'https://onboarding.example');
    await page.fill('#setup-brand-industry', 'Retail');
    await page.getByTestId('setup-create-brand').click();
    await page.waitForURL(/step=learn/);
    await expect(page).toHaveURL(/ok=BRAND_CREATED/);
    await expect(wizard).toHaveAttribute('data-view', 'learn');
    await expect(brandStep).toHaveAttribute('data-complete', 'true');

    // --- Step 3: the Brand Brain's own upload, returning here.
    await page.getByTestId('setup-upload-input').setInputFiles({
      name: `setup-notes-${Date.now()}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(
        [
          'Our mission is to help independent retailers compete with national chains.',
          '',
          'Our audience is founders of small retail businesses in the Gulf region.',
          '',
          'We never make price comparisons against named competitors.',
        ].join('\n'),
        'utf8',
      ),
    });
    await page.getByTestId('setup-upload-submit').click();
    await page.waitForURL(/step=learn/);
    await expect(page).toHaveURL(/ok=SOURCE_UPLOADED/);
    await expect(page.locator('[data-testid="onboarding-step-learn"]')).toHaveAttribute(
      'data-complete',
      'true',
    );

    // --- Step 4: review. The worker reads the document on its own; the page
    // is polled, never the queue.
    await page.getByTestId('setup-continue').click();
    await page.waitForURL(/step=review/);
    const candidate = page.locator('[data-testid^="setup-candidate-"]').first();
    const allDone = page.getByTestId('setup-review-done');
    await expect(async () => {
      await page.reload();
      await expect(candidate.or(allDone)).toBeVisible();
    }).toPass({ timeout: 60_000, intervals: [1_000, 2_000, 3_000] });
    if (await candidate.isVisible()) {
      await candidate.locator('[data-testid^="setup-accept-"]').first().click();
      await page.waitForURL(/step=review/);
      await expect(page).toHaveURL(/ok=CANDIDATE_ACCEPTED/);
    }

    // --- Step 5: connecting is offered, and skipping is a link — no post, no
    // provider call.
    await page.goto(`${DASHBOARD_BASE_URL}/en/onboarding?step=connect`);
    await expect(page.getByTestId('setup-connect')).toBeVisible();
    await page.getByTestId('setup-skip').click();
    await page.waitForURL(/step=goal/);

    // --- Step 6: the first goal, into the brand's strategy memory.
    await page.getByTestId('setup-goal-leads').check();
    await page.getByTestId('setup-goal-submit').click();
    await page.waitForURL(/step=done/);
    await expect(page).toHaveURL(/ok=GOAL_SAVED/);
    await expect(page.locator('[data-testid="onboarding-step-goal"]')).toHaveAttribute(
      'data-complete',
      'true',
    );

    // --- Step 7: the finish line, with a real next action.
    await expect(page.getByTestId('setup-done')).toBeVisible();
    await expect(
      page.getByTestId('setup-create-post').or(page.getByTestId('setup-plan')).first(),
    ).toBeVisible();
    await expect(page.getByTestId('setup-home')).toHaveAttribute('href', '/en/overview');

    // THE DATA, not the screen: one brand, audited; the goal is a HUMAN
    // knowledge item in STRATEGY memory — not a wizard-only field.
    const stored = await withPlatformPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { memberships: { select: { workspaceId: true }, take: 1 } },
      });
      const workspaceId = user.memberships[0]?.workspaceId ?? '';
      const brands = await prisma.brand.findMany({
        where: { workspaceId, deletedAt: null },
        select: { id: true, defaultLocale: true, websiteUrl: true, industry: true },
      });
      const goal = await prisma.brandKnowledgeItem.findFirst({
        where: { workspaceId, itemKey: 'goal.primary' },
        select: { area: true, memory: true, origin: true, status: true, title: true },
      });
      const audits = await prisma.auditEvent.count({
        where: { workspaceId, action: 'brand.created' },
      });
      return { brands, goal, audits };
    });
    expect(stored.brands).toHaveLength(1);
    expect(stored.brands[0]).toMatchObject({
      defaultLocale: 'EN',
      websiteUrl: 'https://onboarding.example',
      industry: 'Retail',
    });
    expect(stored.goal).toMatchObject({
      area: 'STRATEGY',
      memory: 'STRATEGY',
      origin: 'HUMAN',
      status: 'ACTIVE',
      title: { en: 'Generate leads' },
    });
    expect(stored.audits).toBe(1);

    // The wizard in Arabic: right-to-left, and clean under an accessibility scan.
    await page.goto(`${DASHBOARD_BASE_URL}/ar/onboarding?step=goal`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('setup-goal-leads')).toBeChecked();
    const results = await new AxeBuilder({ page })
      .include('[data-testid="setup-wizard"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
      ),
    ).toEqual([]);
  });

  test('“I’M NOT SURE” STORES NOTHING, and the wizard still ends', async ({ page }) => {
    const email = await signUpVerifyAndSignIn(page);
    await createWorkspace(page);
    await page.fill('[data-testid="setup-brand-name"]', BRAND_NAME);
    await page.getByTestId('setup-create-brand').click();
    await page.waitForURL(/step=learn/);

    await page.goto(`${DASHBOARD_BASE_URL}/en/onboarding?step=goal`);
    await page.getByTestId('setup-goal-unsure').check();
    await page.getByTestId('setup-goal-submit').click();
    await page.waitForURL(/step=done/);
    await expect(page.getByTestId('setup-done')).toBeVisible();
    await expect(page.locator('[data-testid="onboarding-step-goal"]')).toHaveAttribute(
      'data-complete',
      'false',
    );

    const goals = await withPlatformPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { memberships: { select: { workspaceId: true }, take: 1 } },
      });
      return prisma.brandKnowledgeItem.count({
        where: { workspaceId: user.memberships[0]?.workspaceId ?? '', itemKey: 'goal.primary' },
      });
    });
    expect(goals).toBe(0);
  });

  test('THE RETRY PATH: creating the same brand twice makes one brand', async ({ page }) => {
    const email = await signUpVerifyAndSignIn(page);
    await createWorkspace(page);

    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    await page.fill('[data-testid="new-brand-name"]', BRAND_NAME);
    await page.getByTestId('create-brand').click();
    await page.waitForLoadState('domcontentloaded');

    /*
     * THE SAME REQUEST AGAIN — somebody walking the checklist a second time, or
     * a browser replaying a submit. Before the fix this made a SECOND brand
     * with the same name and a different slug, and nothing in the product
     * merges those afterwards.
     */
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    const secondForm = page.getByTestId('new-brand-name');
    if (await secondForm.isVisible().catch(() => false)) {
      await secondForm.fill(BRAND_NAME);
      await page.getByTestId('create-brand').click();
      await page.waitForLoadState('domcontentloaded');
    }

    const brands = await withPlatformPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { memberships: { select: { workspaceId: true }, take: 1 } },
      });
      const workspaceId = user.memberships[0]?.workspaceId ?? '';
      return prisma.brand.count({
        where: { workspaceId, deletedAt: null, name: BRAND_NAME },
      });
    });

    expect(brands).toBe(1);
  });

  /*
   * THE PLAN'S BRAND CEILING IS ENFORCED WHERE A BRAND IS CREATED.
   *
   * `limit.brands` was in the plan catalogue, the quota projection, the Control
   * Center's plan editor and the downgrade impact check, and no code path
   * consulted it. A limit that only appears in a form an operator fills in is
   * not a limit, and only a test that tries to CREATE A BRAND THROUGH THE
   * PRODUCT can tell the difference.
   *
   * THE CEILING IS ZERO AND THE BRAND IS THE FIRST ONE, which is not an
   * arbitrary choice of numbers. There is exactly ONE brand-creation path in
   * the product — the empty state on Brand Brain — and it is reachable only
   * while the workspace has no brand at all: once one exists, the form is
   * replaced by the brand's own screen and nothing else offers to make another.
   * So "the first brand, refused" is the only refusal this product can
   * currently reach, and a test that set the ceiling to one and asked for a
   * second would be asserting against a screen that does not exist. That the
   * product cannot create a second brand is recorded separately (D-243); it is
   * a gap in the customer UX, not in the enforcement.
   *
   * THE CEILING IS SET THE WAY AN OPERATOR WOULD SET IT: a workspace override,
   * which the precedence engine resolves ahead of the plan. No plan, price or
   * approved number is written anywhere (AC-04.3).
   */
  test('THE PLAN CEILING: a brand past the limit is refused, and none is created', async ({
    page,
  }) => {
    const email = await signUpVerifyAndSignIn(page);
    await createWorkspace(page);

    const workspaceId = await withPlatformPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true, memberships: { select: { workspaceId: true }, take: 1 } },
      });
      const id = user.memberships[0]?.workspaceId ?? '';
      const owner = await prisma.platformUser.findFirstOrThrow({ select: { id: true } });
      await prisma.workspaceOverride.create({
        data: {
          workspaceId: id,
          featureKey: 'limit.brands',
          enabled: true,
          // NONE. Not unlimited — the two are different numbers, and a caller
          // that collapses them locks out exactly the customers who negotiated
          // no limit.
          limitValue: 0,
          reason: 'End-to-end fixture: a brand ceiling of none.',
          grantedByPlatformUserId: owner.id,
        },
      });
      return id;
    });

    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain`);
    await page.fill('[data-testid="new-brand-name"]', BRAND_NAME);
    await page.getByTestId('create-brand').click();
    await page.waitForLoadState('domcontentloaded');

    // The customer is TOLD, in their own language, that a plan limit stopped
    // them — not shown a page that reloaded unchanged.
    await expect(page).toHaveURL(/error=QUOTA_EXCEEDED/);

    const brands = await withPlatformPrisma(async (prisma) =>
      prisma.brand.count({ where: { workspaceId, deletedAt: null } }),
    );
    expect(brands).toBe(0);
  });
});
