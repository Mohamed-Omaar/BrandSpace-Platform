import crypto from 'node:crypto';
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
  test('THE HAPPY PATH: workspace, then a brand, from the checklist itself', async ({ page }) => {
    await signUpVerifyAndSignIn(page);
    await createWorkspace(page);

    // The checklist is showing, and the brand step is not yet done.
    const brandStep = page.locator('[data-testid="onboarding-step-brand"]');
    await expect(brandStep).toBeVisible();

    /*
     * FOLLOW THE STEP'S OWN LINK. This is the whole assertion: before the fix
     * it led to `/settings/brand`, which has no way to create a brand, so the
     * customer could not finish the step the product had just asked them to.
     */
    await brandStep.locator('a').first().click();
    await page.waitForLoadState('domcontentloaded');

    const create = page.getByTestId('create-brand');
    await expect(create).toBeVisible();
    await page.fill('[data-testid="new-brand-name"]', BRAND_NAME);
    await create.click();
    await page.waitForLoadState('domcontentloaded');

    // A USABLE BRAND EXISTS, and the empty state is gone.
    await expect(page.getByTestId('brand-brain-no-brand')).toHaveCount(0);

    // And the checklist now says so, rather than the customer having to guess.
    await page.goto(`${DASHBOARD_BASE_URL}/en/onboarding`);
    await expect(page.locator('[data-testid="onboarding-step-brand"]')).toHaveAttribute(
      'data-complete',
      'true',
    );
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
});
