import crypto from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * ROUND 4, STEP 7 — WHAT THE FLOW WALK FOUND, held by tests. Each one was seen
 * on a fresh workspace walked end to end and fixed in the product.
 */

test.describe('Step 7 · 7.1 — the Business step asks two questions', () => {
  test('the address follows the business name, so Continue does not stop on it', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one sign-up per run; the desktop run covers it');
    const email = `walk-e2e-${crypto.randomUUID().slice(0, 12)}@example.local`;
    const password = 'a-step-seven-fixture-password';
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-up`);
    await page.fill('#name', 'Step Seven');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.check('[data-testid="accept-terms-of-service"] input[type="checkbox"]');
    await page.click('[data-testid="signup-submit"]');
    await expect(page.getByTestId('signup-sent')).toBeVisible();
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
    await page.goto(`${DASHBOARD_BASE_URL}/en/verify?token=${encodeURIComponent(token)}`);
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('[data-testid="signin-submit"]');
    await page.waitForURL(/\/en\/onboarding\/workspace$/);

    const name = `Step Seven Bakery ${crypto.randomUUID().slice(0, 6)}`;
    await page.fill('#name', name);
    await expect(page.locator('#slug')).toHaveValue(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    // A person who edits it keeps their own.
    await page.getByTestId('create-workspace-more').locator('summary').click();
    await page.fill('#slug', `my-own-${crypto.randomUUID().slice(0, 6)}`);
    await page.fill('#name', `${name} Two`);
    await expect(page.locator('#slug')).toHaveValue(/^my-own-/);
  });
});

test.describe('Step 7 · the Studio and the Team', () => {
  test('Escape closes the When panel; the media sheet’s chosen tab shows; an upload stays on Design', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace('step7-studio');
    await enter(page, own.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=write`);
    await page.getByTestId('content-caption').fill(`Step seven ${Date.now().toString(36)}`);
    await page.waitForURL((url) => url.searchParams.has('item'), { timeout: 60_000 });
    await expect(page.getByTestId('draft-editor')).toBeVisible();

    // The publish-time panel is a dialog: Escape closes it and focus returns.
    await page.getByTestId('editor-when').click();
    await expect(page.getByTestId('editor-when-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('editor-when-panel')).toBeHidden();
    await expect(page.getByTestId('editor-when')).toBeFocused();

    // The "Add media" sheet: the chosen tab is drawn, not white on white.
    await page.getByTestId('studio-tab-visual').click();
    await page.locator('[data-testid^="content-media-"][data-testid$="-add"]').first().click();
    const chosen = page.getByTestId('media-tab-library');
    await expect(chosen).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() => chosen.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe('rgb(255, 255, 255)');
    expect(await chosen.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(17, 17, 20)');
    expect(await chosen.evaluate((el) => getComputedStyle(el).fontSize)).toBe('12.5px');

    // An upload from Design comes back to Design.
    await page.getByTestId('media-tab-upload').click();
    await page
      .getByTestId('composer-upload-file')
      .setInputFiles(new URL('./parity-logo.png', import.meta.url).pathname);
    await page.getByTestId('composer-upload-submit').click();
    await page.waitForURL((url) => url.searchParams.get('open') === 'visual');
    await expect(page.getByTestId('studio-tab-visual')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a team of one is “1 person”', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace('step7-team');
    await enter(page, own.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    const seats = page.getByTestId('members-seats');
    await expect(seats).toBeVisible();
    // A plan with a seat limit says "n of N seats used" instead.
    const text = (await seats.innerText()).trim();
    if (!/seats/.test(text)) expect(text).toBe('1 person');
  });
});
