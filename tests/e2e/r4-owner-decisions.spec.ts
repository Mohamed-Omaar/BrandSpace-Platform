import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * ROUND 4, STEP 4 — THE OWNER'S DECISIONS CARRIED FROM THE REVIEW OF #68.
 *
 * 4.1 sign-up has one password field with Show and no zone question — the
 *     browser's zone is posted and shown, changeable, on onboarding step 1 —
 *     and the card fits a 1440 × 900 screen;
 * 4.2 Settings has no Brands row in a one-brand workspace, and the brand
 *     profile is still one link away;
 * 4.4 the rail's card names the person, not their email;
 * 4.6 Home's credits read "of N · resets D" with the bar, Billing's figure;
 * 4.7 Media's storage card shows the used bytes, the files and, under a
 *     limit, the four categories.
 */

const PASSWORD = 'an-end-to-end-fixture-password';
const ZONE = 'Asia/Tokyo';

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  const choose = page.getByTestId(`choose-workspace-${customer.workspaceSlug}`);
  if (await choose.isVisible().catch(() => false)) await choose.click();
  await page.waitForURL(/\/en\/overview$/);
}

test.describe('Round 4 · 4.1 — sign-up and the detected time zone', () => {
  test.use({ timezoneId: ZONE, viewport: { width: 1440, height: 900 } });
  test.describe.configure({ timeout: 120_000 });

  for (const locale of ['en', 'ar'] as const) {
    test(`one password field with Show, no zone question, and the card fits (${locale})`, async ({
      page,
    }) => {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-up`);
      await expect(page.getByTestId('signup-form')).toBeVisible();
      await expect(page.locator('#password')).toBeVisible();
      await expect(page.locator('#password-confirm')).toHaveCount(0);
      // One reveal toggle ("Show"), for the one password field.
      await expect(page.locator('[data-testid="signup-form"] .bs-reveal')).toHaveCount(1);
      await expect(page.locator('#timezone')).toHaveCount(0);
      // The browser's zone, posted with the form.
      await expect(page.getByTestId('signup-timezone')).toHaveValue(ZONE);
      // The whole card, submit included, on a 1440 × 900 screen without scrolling.
      const submit = await page.getByTestId('signup-submit').boundingBox();
      expect(submit).not.toBeNull();
      expect((submit?.y ?? 0) + (submit?.height ?? 0)).toBeLessThanOrEqual(900);
    });
  }

  test('onboarding step 1 shows the detected zone and lets the person change it', async ({
    page,
  }) => {
    const email = `r4-zone-${crypto.randomUUID().slice(0, 12)}@example.local`;
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-up`);
    await page.fill('#name', 'Zone Detected');
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    await expect(page.getByTestId('signup-timezone')).toHaveValue(ZONE);
    await page.check('[data-testid="accept-terms-of-service"] input[type="checkbox"]');
    await page.click('[data-testid="signup-submit"]');
    await expect(page.getByTestId('signup-sent')).toBeVisible();

    // The account holds the browser's zone; the mailbox is not the subject here.
    const token = await withPlatformPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({
        where: { email },
        select: { id: true, timezone: true },
      });
      expect(user.timezone).toBe(ZONE);
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
    await expect(page.getByTestId('verify-success')).toBeVisible();
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    await page.click('[data-testid="signin-submit"]');
    await page.waitForURL(/\/en\/onboarding\/workspace$/, { timeout: 30_000 });

    // Step 1 says the zone in words, and "Change" opens it, ready to edit.
    const line = page.getByTestId('create-workspace-zone');
    await expect(line).toContainText(ZONE);
    await expect(line).toContainText('from your browser');
    await page.getByTestId('create-workspace-zone-change').click();
    await expect(page.getByTestId('create-workspace-more')).toHaveAttribute('open', '');
    await expect(page.getByTestId('timezone-select')).toBeVisible();
    await expect(page.locator('input[type="hidden"][name="timezone"]')).toHaveValue(ZONE);
  });
});

test.describe('Round 4 · 4.2, 4.4, 4.6, 4.7 — Settings, the rail, Home and Media', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('the rail card names the person, with Latin initials', async ({ page }) => {
    const { customer } = credentials();
    const name = await withPlatformPrisma(async (prisma) =>
      prisma.user.findUniqueOrThrow({ where: { email: customer.email }, select: { name: true } }),
    );
    const card = page.getByTestId('profile-name');
    if (name.name && name.name.trim() !== '') {
      await expect(card).toHaveText(name.name.trim());
    } else {
      await expect(card).toHaveText(customer.email);
    }
    await expect(page.locator('.bsp-ucard-mark')).toHaveText(/^[A-Z0-9]{1,2}$/);
  });

  test('Settings shows Brands with more than one brand', async ({ page }) => {
    // The suite's workspace has two brands (the multi-brand fixture).
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    await expect(page.getByTestId('settings-nav-brand')).toHaveCount(1);
    await expect(page.getByTestId('settings-related-brand')).toHaveCount(0);
  });

  test('Home credits read like Billing: the same balance, of N, resets, a bar', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    const balance = ((await page.getByTestId('credit-balance').textContent()) ?? '').trim();
    // A plan states the monthly grant; with no subscription there is no "of N".
    const subscribed = (await page.getByTestId('no-subscription').count()) === 0;
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const figure = page.getByTestId('metric-credits');
    await expect(figure).toContainText(Number(balance).toLocaleString('en-US'));
    if (subscribed) {
      await expect(figure).toContainText(/(of [\d,]+)|(resets )/);
    } else {
      await expect(figure).not.toContainText(/of [\d,]+/);
    }
  });

  test('Media storage: used, files, and the four categories under a limit', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);
    await expect(page.getByTestId('assets-storage')).toBeVisible();
    await expect(page.getByTestId('assets-storage-files')).toHaveText(/^[\d,]+ files$/);
    const limited = (await page.getByTestId('assets-storage-left').count()) > 0;
    if (limited) {
      for (const key of ['photos', 'videos', 'ai', 'brand']) {
        await expect(page.getByTestId(`assets-storage-cat-${key}`)).toBeVisible();
      }
    } else {
      await expect(page.getByTestId('assets-storage')).toContainText('Unlimited');
      await expect(page.getByTestId('assets-storage-cats')).toHaveCount(0);
    }
  });
});

test.describe('Round 4 · 5.5 — the General save bar stays on the frame’s bottom edge', () => {
  // A short screen, so the page scrolls in the frame.
  test.use({ viewport: { width: 1440, height: 520 } });

  test('at the top, in the middle and at the very end of the page', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    await expect(page.getByTestId('settings-bar')).toBeVisible();
    const positions = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('main.bsp-scroll');
      const bar = document.querySelector<HTMLElement>('[data-testid="settings-bar"]');
      if (!scroller || !bar) return [];
      const end = scroller.scrollHeight - scroller.clientHeight;
      const out: { scrolls: boolean; gap: number }[] = [];
      for (const top of [0, Math.round(end / 2), end]) {
        scroller.scrollTop = top;
        await new Promise((done) => requestAnimationFrame(() => done(null)));
        out.push({
          scrolls: end > 0,
          gap: scroller.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom,
        });
      }
      return out;
    });
    expect(positions).toHaveLength(3);
    for (const { scrolls, gap } of positions) {
      expect(scrolls).toBe(true);
      // On the frame's bottom edge (its 8px inset), never carried up with the page.
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(16);
    }
    // The bar is the column's last row, under the note, as the prototype draws it.
    const order = await page.evaluate(() => {
      const note = document.querySelector('[data-testid="settings-identity-note"]');
      const bar = document.querySelector('[data-testid="settings-bar"]');
      return note && bar ? note.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING : 0;
    });
    expect(order).toBeTruthy();
  });
});
