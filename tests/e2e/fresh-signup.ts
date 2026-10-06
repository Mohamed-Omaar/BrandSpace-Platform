import crypto from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { withPlatformPrisma } from './platform-prisma';

/**
 * A NEW CUSTOMER, AS THEY ARRIVE: signed up through the real form, the email
 * verified, signed in, and standing on onboarding step 1 with no workspace.
 * The mailbox is not the subject, so the verification token is minted
 * directly, as `onboarding-first-brand.spec.ts` does.
 */
export async function freshSignUp(page: Page, locale = 'en'): Promise<string> {
  const email = `fresh-${crypto.randomUUID().slice(0, 12)}@example.local`;
  const password = 'a-fresh-sign-up-fixture-password';
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-up`);
  await page.fill('#name', 'Fresh Customer');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.check('[data-testid="accept-terms-of-service"] input[type="checkbox"]');
  await page.click('[data-testid="signup-submit"]');
  await expect(page.locator('[data-testid="signup-sent"]')).toBeVisible();
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
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(new RegExp(`/${locale}/onboarding/workspace$`), { timeout: 30_000 });
  return email;
}

/** Onboarding step 1 (the business), filled with the least it needs. */
export async function createFreshWorkspace(page: Page, locale = 'en'): Promise<string> {
  const slug = `fresh-${crypto.randomUUID().slice(0, 8)}`;
  await page.fill('#name', `Fresh Cafe ${slug.slice(6)}`);
  await page.fill('[data-testid="country-select"]', 'Egypt');
  await page.press('[data-testid="country-select"]', 'Enter');
  if (!(await page.locator('#slug').inputValue())) {
    await page.getByTestId('create-workspace-more').locator('summary').click();
    await page.fill('#slug', slug);
  }
  await page.click('[data-testid="create-workspace-submit"]');
  await page.waitForURL(new RegExp(`/${locale}/onboarding(\\?|$)`), { timeout: 30_000 });
  return slug;
}

/** Onboarding step 2 (the brand), then straight past Teach, Accounts and Goal. */
export async function finishFreshOnboarding(page: Page, locale = 'en'): Promise<void> {
  await page.fill('[data-testid="setup-brand-name"]', 'Fresh Cafe');
  await page.getByTestId('setup-create-brand').click();
  await page.waitForURL(/step=learn/, { timeout: 30_000 });
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/onboarding?step=connect`);
  await page.getByTestId('setup-skip').click();
  await page.waitForURL(/step=goal/);
  await page.getByTestId('setup-goal-leads').check();
  await page.getByTestId('setup-goal-submit').click();
  await page.waitForURL(/step=done/);
}
