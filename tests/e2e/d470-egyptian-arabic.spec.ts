import crypto from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { withPlatformPrisma } from './platform-prisma';

/**
 * D-470 — THE INTERFACE ARABIC FOLLOWS THE WORKSPACE'S COUNTRY, IN A REAL BROWSER.
 *
 * Two strangers sign up and each creates a first workspace through the real
 * form: one in Egypt, one in Saudi Arabia. On the same `/ar` route, the
 * Egyptian workspace reads the Egyptian layer (`ar-EG`) and the Saudi one reads
 * the product's formal Arabic. The route, `dir` and `<html lang>` are the same
 * for both: only the words differ. English is untouched by either.
 *
 * The control read is the language square's name — on every workspace screen,
 * the same on a phone and a desktop, and different in the two dictionaries.
 * Nothing here depends on the date or on another suite's data: each test makes
 * its own person and its own workspace.
 */

const PASSWORD = 'an-end-to-end-fixture-password';
const EGYPTIAN = 'حوّل للإنجليزي';
const FORMAL = 'التبديل إلى الإنجليزية';

/** Sign up through the REAL form; mint the verification token's hash, as phase9-commerce does. */
async function signUpAndVerify(page: Page): Promise<string> {
  const email = `d470-${crypto.randomUUID().slice(0, 12)}@example.local`;
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-up`);
  await expect(page.locator('[data-testid="signup-form"]')).toBeVisible();
  await page.fill('#name', 'Dialect Check');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.fill('#password-confirm', PASSWORD);
  await page.fill('#timezone', 'Europe/London');
  await page.press('#timezone', 'Enter');
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
  await page.goto(`${DASHBOARD_BASE_URL}/en/verify?token=${encodeURIComponent(token)}`);
  await expect(page.locator('[data-testid="verify-success"]')).toBeVisible();
  return email;
}

async function signIn(page: Page, email: string, locale: 'en' | 'ar'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(new RegExp(`/${locale}/onboarding/workspace$`));
}

/** The first workspace, through the REAL form, in the given country. */
async function createWorkspace(page: Page, country: string): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/en/onboarding/workspace`);
  await expect(page.locator('[data-testid="create-workspace-form"]')).toBeVisible();
  await page.fill('#name', `Dialect ${country}`);
  await page.fill('#slug', `dialect-${country.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`);
  const countryName = new Intl.DisplayNames(['en'], { type: 'region' }).of(country) ?? country;
  await page.fill('[data-testid="country-select"]', countryName);
  await page.press('[data-testid="country-select"]', 'Enter');
  await page.selectOption('#defaultLocale', 'AR');
  await page.fill('[data-testid="timezone-select"]', 'Africa/Cairo');
  await page.press('[data-testid="timezone-select"]', 'Enter');
  await page.fill('#billingEmail', `finance-${crypto.randomUUID().slice(0, 8)}@example.local`);
  await page.click('[data-testid="create-workspace-submit"]');
  await page.waitForURL(/\/en\/onboarding$/, { timeout: 30_000 });
}

test.describe('D-470: Arabic follows the workspace country', () => {
  test('an Egyptian workspace reads Egyptian Arabic; the route, dir and html lang are unchanged', async ({
    page,
  }) => {
    const email = await signUpAndVerify(page);

    // BEFORE A WORKSPACE EXISTS there is no country: the Arabic sign-in is formal.
    await signIn(page, email, 'ar');
    await expect(page.locator('[lang="ar-EG"]')).toHaveCount(0);

    await createWorkspace(page, 'EG');
    // Review of #67 — onboarding is the standalone card with no app shell, so
    // the shell's dialect is read on Settings, a screen inside it.
    await page.goto(`${DASHBOARD_BASE_URL}/ar/settings`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', /^ar\b/);
    await expect(page.locator('[data-testid="app-shell"]')).toHaveAttribute('lang', 'ar-EG');
    await expect(page.locator('[data-testid="locale-switch"]')).toHaveAttribute(
      'aria-label',
      EGYPTIAN,
    );

    // English stays English for the same workspace.
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    await expect(page.locator('[data-testid="app-shell"]')).not.toHaveAttribute('lang', /.+/);
    await expect(page.locator('[data-testid="locale-switch"]')).toHaveAttribute(
      'aria-label',
      'Switch to Arabic',
    );
  });

  test('a non-Egyptian workspace reads the formal Arabic on the same route', async ({ page }) => {
    const email = await signUpAndVerify(page);
    await signIn(page, email, 'en');
    await createWorkspace(page, 'SA');

    await page.goto(`${DASHBOARD_BASE_URL}/ar/settings`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('[data-testid="app-shell"]')).not.toHaveAttribute('lang', /.+/);
    await expect(page.locator('[data-testid="locale-switch"]')).toHaveAttribute(
      'aria-label',
      FORMAL,
    );
    await expect(page.locator('[lang="ar-EG"]')).toHaveCount(0);
  });
});
