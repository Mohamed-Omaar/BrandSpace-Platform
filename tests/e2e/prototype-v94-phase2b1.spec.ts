import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v94, Phase 2B-1 — the read-only half, as a person meets it in a
 * real browser. Nothing here changes shared state, so it runs in the two
 * viewport projects; the suites that change workspace settings run serially in
 * `prototype-v94-settings.spec.ts`. The rules themselves are proven against
 * PostgreSQL in tests/isolation.
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

test.describe('UI-1 · one global scrollbar', () => {
  test('the one global scrollbar style reaches the page; the sidebar navigation keeps its bar hidden', async ({
    page,
    isMobile,
  }) => {
    // Phone emulation draws overlay scrollbars that take no width at all.
    test.skip(isMobile === true, 'desktop scrollbars only');
    await signIn(page);
    /*
     * The rules the BROWSER loaded, read from the CSSOM. Headless Chromium runs
     * with overlay scrollbars (`--hide-scrollbars`), so a bar's width cannot be
     * measured there; what can be proven is that the one global style reached
     * the page, and that the hidden areas compute `scrollbar-width: none`.
     */
    const rules = await page.evaluate(() => {
      const found: Record<string, string> = {};
      for (const sheet of Array.from(document.styleSheets)) {
        let list: CSSRuleList;
        try {
          list = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of Array.from(list)) {
          if (rule instanceof CSSStyleRule && rule.selectorText.includes('::-webkit-scrollbar')) {
            // The universal `*` may be dropped when the sheet is minified or
            // serialised (`*::x` and `::x` select the same elements).
            for (const selector of rule.selectorText.split(',')) {
              found[selector.trim().replace(/^\*/, '')] = rule.style.cssText;
            }
          }
        }
      }
      return found;
    });
    expect(rules['::-webkit-scrollbar']).toContain('width: 8px');
    expect(rules['::-webkit-scrollbar-button']).toContain('display: none');
    expect(rules['::-webkit-scrollbar-thumb']).toContain('var(--bs-scrollbar-thumb)');
    expect(rules['::-webkit-scrollbar-thumb:hover']).toContain('var(--bs-scrollbar-thumb-hover)');
    expect(rules['.bs-nav-scroll::-webkit-scrollbar']).toContain('display: none');

    const nav = page.locator('.bs-nav-scroll').first();
    await expect(nav).toBeVisible();
    const hidden = await nav.evaluate((element) => ({
      bar: (element as HTMLElement).offsetWidth - (element as HTMLElement).clientWidth,
      width: getComputedStyle(element).getPropertyValue('scrollbar-width'),
    }));
    expect(hidden.bar).toBe(0);
    expect(hidden.width).toBe('none');
    // An ordinary scroll area is NOT hidden: it keeps the platform default here
    // and is drawn by the global pseudo-element rules.
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.body).getPropertyValue('scrollbar-width'),
      ),
    ).toBe('auto');
  });
});

test.describe('Q1 / Q2 · the rail card opens the business switcher', () => {
  test('lists every business as role · plan, ticks the current one, and switches', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the rail card is desktop; the phone drawer is Phase 2E');
    const loaded = credentials();
    const { customer } = loaded;
    const secondId = await withPlatformPrisma(
      async (prisma) =>
        (
          await prisma.workspace.findUniqueOrThrow({
            where: { slug: customer.secondWorkspaceSlug },
            select: { id: true },
          })
        ).id,
    );
    await signIn(page);
    // The primary fixture workspace has several brands and multi-brand ON:
    // its rail keeps the brand selector (D-327).
    await expect(page.getByTestId('sidebar').getByTestId('brand-switcher')).toBeVisible();

    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await page.click(`[data-testid="choose-workspace-${customer.secondWorkspaceSlug}"]`);
    await page.waitForURL(/\/en\/overview$/);

    const rail = page.getByTestId('sidebar');
    // Multi-brand is OFF here: no brand selector, the card opens the switcher.
    await expect(rail.getByTestId('brand-switcher')).toHaveCount(0);
    const card = rail.getByTestId('workspace-switcher');
    await expect(card).toBeVisible();
    await expect(rail.getByTestId('active-brand-caption')).toContainText('Owner ·');
    await card.click();

    const current = page.getByTestId(`workspace-option-${secondId}`);
    const other = page.getByTestId(`workspace-option-${customer.workspaceId}`);
    await expect(current).toHaveAttribute('aria-current', 'true');
    await expect(current).toContainText('Owner ·');
    await expect(other).toBeVisible();
    await expect(other).not.toHaveAttribute('aria-current', 'true');

    // The owner's allowance: the fixture workspaces carry no plan, which states
    // no ceiling (D-326), so the usage shows and "+ New workspace" is offered.
    await expect(page.getByTestId('workspace-usage')).toContainText('Workspaces: ');
    const create = page.getByTestId('workspace-new');
    if ((await create.count()) > 0) {
      await expect(create).toHaveAttribute('href', '/en/onboarding/workspace');
    }

    await other.click();
    await page.waitForURL(/\/en\/overview$/);
    await expect(page.getByTestId('sidebar').getByTestId('brand-switcher')).toBeVisible();
  });
});

test.describe('A8 · the owner deletes a workspace, it waits, and the owner cancels', () => {
  test('two confirmations, a closed workspace, and cancel restores it', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { customer } = credentials();
    const slug = `e2e-delete-${randomUUID().slice(0, 8)}`;
    const name = `E2E Deletion ${slug.slice(-8)}`;
    // A workspace of its own, so asking to delete it touches nothing another
    // suite reads. Written the way the platform creates one: owner + membership.
    await withPlatformPrisma(async (prisma) => {
      const owner = await prisma.user.findFirstOrThrow({
        where: { email: customer.email },
        select: { id: true },
      });
      const role = await prisma.role.findFirstOrThrow({
        where: { key: 'workspace_owner', workspaceId: null },
        select: { id: true },
      });
      const id = randomUUID();
      await prisma.workspace.create({
        data: {
          id,
          workspaceId: id,
          slug,
          name,
          ownerUserId: owner.id,
          status: 'ACTIVE',
          country: 'EG',
          defaultLocale: 'EN',
          timezone: 'Africa/Cairo',
          currency: 'USD',
        },
      });
      await prisma.membership.create({
        data: {
          workspaceId: id,
          userId: owner.id,
          roleId: role.id,
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });
    });

    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await page.click(`[data-testid="choose-workspace-${slug}"]`);
    await page.waitForURL(/\/en\/overview$/);

    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/data`);
    await page.getByTestId('workspace-deletion-open').click();
    // A wrong name is refused on the server, and nothing is scheduled.
    await page.getByTestId('workspace-deletion-name').fill('not the name');
    await page.getByTestId('workspace-deletion-password').fill(customer.password);
    await page.getByTestId('workspace-deletion-confirm').click();
    await page.waitForURL(/error=DELETION_NAME_MISMATCH/);

    await page.getByTestId('workspace-deletion-open').click();
    await page.getByTestId('workspace-deletion-name').fill(name);
    await page.getByTestId('workspace-deletion-password').fill(customer.password);
    await page.getByTestId('workspace-deletion-confirm').click();
    await page.waitForURL(/\/en\/deletion-pending$/);
    await expect(page.getByTestId('deletion-pending-date')).toContainText(name);

    // Closed: every page of the workspace lands on this screen.
    for (const path of ['/en/content', '/en/settings', '/en/overview']) {
      await page.goto(`${DASHBOARD_BASE_URL}${path}`);
      await page.waitForURL(/\/en\/deletion-pending$/);
    }
    // Marked in the chooser.
    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await expect(page.getByTestId(`workspace-pending-deletion-${slug}`)).toBeVisible();

    await page.goto(`${DASHBOARD_BASE_URL}/en/deletion-pending`);
    await page.getByTestId('deletion-cancel').click();
    await page.waitForURL(/\/en\/settings\/data\?ok=DELETION_CANCELLED$/);
    await page.goto(`${DASHBOARD_BASE_URL}/en/content`);
    await expect(page).toHaveURL(/\/en\/content$/);
  });
});

test.describe('G6 · the calendar: a ★ holiday opens the Studio for its day; suggested times', () => {
  test('a holiday chip, the Studio for that day, and "Suggested time" in the schedule dialog', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the month grid is desktop; the agenda carries the same chip');
    // `seed-calendar-fixture.ts`: a fixture holiday three days after the seed, in
    // the fixture workspaces' country, and suggested times for that country.
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar?month=${day.slice(0, 7)}`);
    const chip = page.getByTestId(`calendar-marker-${day}-0`);
    await expect(chip).toContainText('E2E Fixture Holiday');
    await expect(chip).toHaveAttribute('data-kind', 'holiday');
    await expect(chip).toHaveAttribute('href', `/en/content/compose?date=${day}`);

    await page.getByTestId('calendar-schedule-open').click();
    const suggested = page.getByTestId('schedule-suggested');
    await expect(suggested).toContainText('Suggested time');
    await expect(suggested).not.toContainText(/best time/i);
    await page.getByTestId('schedule-suggested-13:00').click();
    await expect(page.getByTestId('schedule-time')).toHaveValue('13:00');
    await page.keyboard.press('Escape');

    await chip.click();
    await page.waitForURL(new RegExp(`/en/content/compose\\?date=${day}$`));
    await expect(page.getByTestId('composer-planned-date')).toContainText('E2E Fixture Holiday');
    // The day travels with the choice of how to start, like a campaign does.
    await page.getByTestId('create-mode-write').click();
    await page.waitForURL(/mode=write/);
    expect(new URL(page.url()).searchParams.get('date')).toBe(day);
    await expect(page.getByTestId('composer-planned-date')).toContainText('E2E Fixture Holiday');
  });
});

test.describe('A9 / G1 · Settings → General, under the save bar', () => {
  test('clean until changed, Cancel restores, and a saved week start moves the calendar', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { customer } = credentials();
    const slug = `e2e-general-${randomUUID().slice(0, 8)}`;
    const name = `E2E General ${slug.slice(-8)}`;
    // A workspace of its own with its one brand, so changing its country and
    // week start touches nothing another suite reads.
    await withPlatformPrisma(async (prisma) => {
      const owner = await prisma.user.findFirstOrThrow({
        where: { email: customer.email },
        select: { id: true },
      });
      const role = await prisma.role.findFirstOrThrow({
        where: { key: 'workspace_owner', workspaceId: null },
        select: { id: true },
      });
      const id = randomUUID();
      await prisma.workspace.create({
        data: {
          id,
          workspaceId: id,
          slug,
          name,
          ownerUserId: owner.id,
          status: 'ACTIVE',
          country: 'US',
          defaultLocale: 'EN',
          // The country's usual zone, so choosing Egypt replaces it (Q7); a
          // zone the owner picked themselves would be kept.
          timezone: 'America/New_York',
          currency: 'USD',
        },
      });
      await prisma.membership.create({
        data: {
          workspaceId: id,
          userId: owner.id,
          roleId: role.id,
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });
      await prisma.brand.create({
        data: { workspaceId: id, slug: `${slug}-brand`, name: `${name} Brand`, status: 'ACTIVE' },
      });
    });

    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await page.click(`[data-testid="choose-workspace-${slug}"]`);
    await page.waitForURL(/\/en\/overview$/);

    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    const bar = page.getByTestId('settings-bar');
    const save = page.getByTestId('settings-save');
    // Clean: said, and nothing to save.
    await expect(bar).toHaveAttribute('data-state', 'clean');
    await expect(page.getByTestId('settings-bar-status')).toHaveText('All changes saved');
    await expect(save).toBeDisabled();
    await expect(page.getByTestId('settings-bar-cancel')).toHaveCount(0);

    // Dirty, then Cancel puts the saved value back.
    await page.fill('#name', 'Something else entirely');
    await expect(bar).toHaveAttribute('data-state', 'dirty');
    await expect(page.getByTestId('settings-bar-status')).toHaveText('Unsaved changes');
    await expect(save).toBeEnabled();
    await page.getByTestId('settings-bar-cancel').click();
    await expect(page.locator('#name')).toHaveValue(name);
    await expect(bar).toHaveAttribute('data-state', 'clean');
    await expect(save).toBeDisabled();

    // Egypt preselects its zone and asks for a city; Monday starts the week.
    await expect(page.getByTestId('settings-city')).toHaveCount(0);
    await page.getByTestId('settings-country').click();
    await page.getByTestId('settings-country').fill('Egypt');
    await page.getByRole('option', { name: 'Egypt' }).click();
    await expect(page.locator('input[type="hidden"][name="timezone"]')).toHaveValue('Africa/Cairo');
    await page.getByTestId('settings-city').click();
    await page.getByTestId('settings-city').fill('Alexandria');
    await page.getByRole('option', { name: 'Alexandria' }).click();
    await page.getByTestId('settings-week-start').selectOption('1');
    await page.getByTestId('settings-website').fill('https://general.example');
    await expect(bar).toHaveAttribute('data-state', 'dirty');
    await save.click();
    await page.waitForURL(/ok=SETTINGS_SAVED/);

    // Saved, and clean again.
    await expect(page.getByTestId('settings-bar')).toHaveAttribute('data-state', 'clean');
    await expect(page.locator('input[type="hidden"][name="country"]')).toHaveValue('EG');
    await expect(page.locator('input[type="hidden"][name="city"]')).toHaveValue('EG-ALX');
    await expect(page.getByTestId('settings-week-start')).toHaveValue('1');
    await expect(page.getByTestId('settings-website')).toHaveValue('https://general.example');

    // The calendar follows the workspace's own week start.
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    const headers = await page
      .getByTestId('calendar-month-grid')
      .locator('[role="columnheader"]')
      .allTextContents();
    expect(headers[0]).toMatch(/mon/i);

    // Approvals is a draftable tab too.
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/approvals`);
    const policyBar = page.locator('[data-testid^="policy-bar-"]').first();
    await expect(policyBar).toHaveAttribute('data-state', 'clean');
    const self = page.locator('[data-testid^="policy-self-"]').first();
    const wasChecked = await self.isChecked();
    await self.click();
    await expect(policyBar).toHaveAttribute('data-state', 'dirty');
    await policyBar.locator('[data-testid$="-cancel"]').click();
    await expect(page.locator('[data-testid^="policy-self-"]').first()).toBeChecked({
      checked: wasChecked,
    });
    await expect(policyBar).toHaveAttribute('data-state', 'clean');

    // And in Arabic.
    await page.goto(`${DASHBOARD_BASE_URL}/ar/settings`);
    await expect(page.getByTestId('settings-bar-status')).toHaveText('تم حفظ كل التغييرات');
  });
});
