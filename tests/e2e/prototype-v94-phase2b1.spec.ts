import { randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { hashPassword } from '@brandspace/auth';
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

test.describe('A10 / G2 / G3 · my notification switches, and the AI writing language', () => {
  test('a switched-off category stays out of my bell; the AI language saves per brand', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { customer } = credentials();
    const slug = `e2e-notify-${randomUUID().slice(0, 8)}`;
    const workspaceId = randomUUID();
    let ownerId = '';
    let brandId = '';
    // A workspace of its own, so its bell holds only what this test sends.
    await withPlatformPrisma(async (prisma) => {
      const owner = await prisma.user.findFirstOrThrow({
        where: { email: customer.email },
        select: { id: true },
      });
      ownerId = owner.id;
      const role = await prisma.role.findFirstOrThrow({
        where: { key: 'workspace_owner', workspaceId: null },
        select: { id: true },
      });
      await prisma.workspace.create({
        data: {
          id: workspaceId,
          workspaceId,
          slug,
          name: `E2E Notify ${slug.slice(-8)}`,
          ownerUserId: owner.id,
          status: 'ACTIVE',
          country: 'US',
          defaultLocale: 'EN',
          timezone: 'America/New_York',
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
      const brand = await prisma.brand.create({
        data: { workspaceId, slug: `${slug}-brand`, name: 'Notify Brand', status: 'ACTIVE' },
        select: { id: true },
      });
      brandId = brand.id;
    });

    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await page.click(`[data-testid="choose-workspace-${slug}"]`);
    await page.waitForURL(/\/en\/overview$/);

    // Everything is on until I say otherwise.
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/notifications`);
    const bar = page.getByTestId('notification-preferences-bar');
    await expect(bar).toHaveAttribute('data-state', 'clean');
    const approvals = page.getByTestId('notification-pref-approvals');
    await expect(approvals).toBeChecked();
    await expect(page.getByTestId('notification-pref-automations')).toBeChecked();
    await approvals.uncheck();
    await expect(bar).toHaveAttribute('data-state', 'dirty');
    await page.getByTestId('notification-preferences-save').click();
    await page.waitForURL(/ok=SETTINGS_SAVED/);
    await expect(page.getByTestId('notification-pref-approvals')).not.toBeChecked();
    await expect(page.getByTestId('notification-preferences-bar')).toHaveAttribute(
      'data-state',
      'clean',
    );

    // Two events reach me through the one notification writer; the bell shows
    // the one I did not switch off.
    const { NotificationService } = await import('@brandspace/notifications');
    await withPlatformPrisma(async (prisma) => {
      const service = new NotificationService({ db: prisma as never, workspaceId });
      await service.create({
        userIds: [ownerId],
        templateKey: 'approval.requested',
        idempotencyKey: `e2e-notify-approval-${slug}`,
      });
      await service.create({
        userIds: [ownerId],
        templateKey: 'publishing.published',
        idempotencyKey: `e2e-notify-published-${slug}`,
      });
    });
    await page.goto(`${DASHBOARD_BASE_URL}/en/notifications`);
    const list = page.getByTestId('notifications-list');
    await expect(list).toContainText('Your post was published');
    await expect(list).not.toContainText('A post is waiting for your review');

    // Settings → AI: the brand's writing language, under the same bar.
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);
    const aiBar = page.getByTestId(`ai-bar-${brandId}`);
    await expect(aiBar).toHaveAttribute('data-state', 'clean');
    await page.getByTestId(`ai-language-${brandId}`).selectOption('AR');
    await expect(aiBar).toHaveAttribute('data-state', 'dirty');
    await page.getByTestId(`ai-save-${brandId}`).click();
    await page.waitForURL(/ok=SETTINGS_SAVED/);
    await expect(page.getByTestId(`ai-language-${brandId}`)).toHaveValue('AR');

    // And in Arabic.
    await page.goto(`${DASHBOARD_BASE_URL}/ar/settings/notifications`);
    await expect(page.getByTestId('notification-preferences')).toContainText(
      'أتمتة تُعلمني أو تحتاج موافقتي',
    );
  });
});

test.describe('A11 / Q9 · an expired account warns in the Studio and does not block', () => {
  test('the channel reads "Expired", with what that means on the next line', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { customer } = credentials();
    const slug = `e2e-expired-${randomUUID().slice(0, 8)}`;
    const workspaceId = randomUUID();
    let itemId = '';
    // A workspace of its own: one brand, its LinkedIn account needing
    // reconnection, and a draft written for LinkedIn.
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
          name: `E2E Expired ${slug.slice(-8)}`,
          ownerUserId: owner.id,
          status: 'ACTIVE',
          country: 'US',
          defaultLocale: 'EN',
          timezone: 'America/New_York',
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
      const brand = await prisma.brand.create({
        data: { workspaceId, slug: `${slug}-brand`, name: 'Expired Brand', status: 'ACTIVE' },
        select: { id: true },
      });
      await prisma.socialConnection.create({
        data: {
          workspaceId,
          brandId: brand.id,
          provider: 'LINKEDIN',
          externalAccountId: `${slug}-linkedin`,
          displayName: 'Expired LinkedIn',
          targetKind: 'organization',
          status: 'NEEDS_REAUTH',
          grantedScopes: ['w_member_social'],
          connectedByUserId: owner.id,
          connectedAt: new Date(),
        },
      });
      const item = await prisma.contentItem.create({
        data: {
          workspaceId,
          brandId: brand.id,
          title: 'Expired channel post',
          contentType: 'POST',
          primaryLocale: 'EN',
          status: 'DRAFT',
          origin: 'HUMAN',
          createdByUserId: owner.id,
          idempotencyKey: `${slug}-item`,
        },
        select: { id: true },
      });
      itemId = item.id;
      await prisma.contentVariant.create({
        data: {
          workspaceId,
          brandId: brand.id,
          contentItemId: item.id,
          platformKey: 'linkedin',
          locale: 'EN',
          body: 'A post for an account that needs reconnecting.',
          hashtags: [],
          characterCount: 46,
          validationState: 'VALID',
          origin: 'HUMAN',
        },
      });
    });

    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await page.click(`[data-testid="choose-workspace-${slug}"]`);
    await page.waitForURL(/\/en\/overview$/);

    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?item=${itemId}`);
    const row = page.getByTestId('editor-channel-expired-linkedin');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.locator('b')).toHaveText('Expired');
    await expect(row).toContainText('Reconnect the account');
    await expect(row).toContainText('120 minutes');
    // A warning, not a block: the row is a warning and the draft can still be scheduled.
    await expect(row).toHaveClass(/warning/);

    await page.goto(`${DASHBOARD_BASE_URL}/ar/content/compose?item=${itemId}`);
    await expect(page.getByTestId('editor-channel-expired-linkedin').locator('b')).toHaveText(
      'منتهي الصلاحية',
    );
  });
});

test.describe('G4 / Q23 · two-step verification: QR, new phone, and the workspace requirement', () => {
  /** A code from the key the page printed — exactly what an authenticator app does. */
  function codeFromKey(printedKey: string): string {
    return new TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(printedKey.replace(/\s+/g, '')),
    }).generate();
  }

  async function signInAs(page: Page, email: string, password: string): Promise<void> {
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.click('[data-testid="signin-submit"]');
    await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  }

  test('the owner enrols by the printed key, requires it, moves to a new phone; a member is sent to set it up', async ({
    page,
    browser,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own accounts; the desktop run covers it');
    // FRESH ACCOUNTS: turning two-step on for the shared E2E owner would change
    // every other suite's sign-in.
    const suffix = randomUUID().slice(0, 8);
    const password = `e2e-${randomUUID()}`;
    const ownerEmail = `e2e-mfa-owner-${suffix}@brandspace.test`;
    const memberEmail = `e2e-mfa-member-${suffix}@brandspace.test`;
    const slug = `e2e-mfa-${suffix}`;
    await withPlatformPrisma(async (prisma) => {
      const passwordHash = await hashPassword(password);
      const make = (email: string, name: string) =>
        prisma.user.create({
          data: {
            email,
            name,
            status: 'ACTIVE',
            emailVerifiedAt: new Date(),
            passwordHash,
            locale: 'EN',
            timezone: 'UTC',
          },
          select: { id: true },
        });
      const owner = await make(ownerEmail, 'MFA Owner');
      const member = await make(memberEmail, 'MFA Member');
      const id = randomUUID();
      await prisma.workspace.create({
        data: {
          id,
          workspaceId: id,
          slug,
          name: `E2E MFA ${suffix}`,
          ownerUserId: owner.id,
          status: 'ACTIVE',
          country: 'US',
          defaultLocale: 'EN',
          timezone: 'America/New_York',
          currency: 'USD',
        },
      });
      for (const [userId, roleKey] of [
        [owner.id, 'workspace_owner'],
        [member.id, 'copywriter'],
      ] as const) {
        const role = await prisma.role.findFirstOrThrow({
          where: { key: roleKey, workspaceId: null },
          select: { id: true },
        });
        await prisma.membership.create({
          data: {
            workspaceId: id,
            userId,
            roleId: role.id,
            status: 'ACTIVE',
            acceptedAt: new Date(),
          },
        });
      }
    });

    // 1. The owner enrols: a QR code AND the key to type, drawn by the server.
    await signInAs(page, ownerEmail, password);
    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await page.click(`[data-testid="choose-workspace-${slug}"]`);
    await page.waitForURL(/\/en\/overview$/);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/security`);
    await page.getByTestId('mfa-begin').click();
    await page.waitForURL(/\/en\/settings\/security$/);
    expect(page.url()).not.toContain('otpauth');
    await expect(page.getByTestId('mfa-enrolment-qr')).toBeVisible();
    const firstKey = (await page.getByTestId('mfa-enrolment-key').textContent()) ?? '';
    expect(firstKey).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{1,4})+$/);
    await page.getByTestId('mfa-enrolment-code').fill(codeFromKey(firstKey));
    await page.getByTestId('mfa-enrolment-confirm').click();
    await page.waitForURL(/ok=MFA_ENABLED/);
    expect(page.url()).not.toContain('codes=');
    // The recovery codes, shown once, and gone once saved.
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
    await page.getByTestId('recovery-codes-saved').click();
    await expect(page.getByTestId('recovery-codes')).toHaveCount(0);

    // 2. The owner requires it for everyone; now nobody can turn theirs off.
    await page.getByTestId('mfa-require').check();
    await page.getByTestId('mfa-require-save').click();
    await page.waitForURL(/ok=SETTINGS_SAVED/);
    await expect(page.getByTestId('mfa-require')).toBeChecked();
    await expect(page.getByTestId('mfa-required-note')).toBeVisible();
    await expect(page.getByTestId('mfa-disable')).toHaveCount(0);

    // 3. "New phone": a current code, then the new phone's own code.
    await page.getByTestId('mfa-new-phone-code').fill(codeFromKey(firstKey));
    await page.getByTestId('mfa-new-phone-begin').click();
    await expect(page.getByTestId('mfa-new-phone-qr')).toBeVisible();
    const newKey = (await page.getByTestId('mfa-new-phone-key').textContent()) ?? '';
    expect(newKey).not.toBe(firstKey);
    await page.getByTestId('mfa-new-phone-code').fill(codeFromKey(newKey));
    await page.getByTestId('mfa-new-phone-confirm').click();
    await page.waitForURL(/ok=MFA_NEW_PHONE/);
    await expect(page.getByTestId('recovery-codes').locator('li')).toHaveCount(10);

    // 4. A member without two-step is sent to set it up before anything else.
    const memberContext = await browser.newContext();
    const member = await memberContext.newPage();
    await signInAs(member, memberEmail, password);
    await member.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await member.click(`[data-testid="choose-workspace-${slug}"]`);
    await member.waitForURL(/\/en\/mfa-setup$/);
    await member.goto(`${DASHBOARD_BASE_URL}/en/content`);
    await member.waitForURL(/\/en\/mfa-setup$/);
    await member.getByTestId('mfa-setup-begin').click();
    await expect(member.getByTestId('mfa-setup-qr')).toBeVisible();
    const memberKey = (await member.getByTestId('mfa-setup-key').textContent()) ?? '';
    await member.getByTestId('mfa-setup-code').fill(codeFromKey(memberKey));
    await member.getByTestId('mfa-setup-confirm').click();
    await member.waitForURL(/\/en\/settings\/security\?ok=MFA_ENABLED$/);
    // In, and unable to turn it off while the workspace requires it.
    await expect(member.getByTestId('mfa-required-note')).toBeVisible();
    await expect(member.getByTestId('mfa-disable')).toHaveCount(0);
    await member.goto(`${DASHBOARD_BASE_URL}/en/content`);
    await expect(member).toHaveURL(/\/en\/content$/);
    await memberContext.close();
  });
});

test.describe('G5 / Q22 · a time-zone change keeps local times, and says what it cannot keep', () => {
  test('the warning lists the post that would be too late, and its author is told after saving', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { customer } = credentials();
    const slug = `e2e-tz-${randomUUID().slice(0, 8)}`;
    const workspaceId = randomUUID();
    const local = (at: Date) => at.toISOString().slice(0, 16);
    // Two hours from now in UTC: in Tokyo (UTC+9) that clock time is already past.
    const soonUtc = new Date(Date.now() + 2 * 3_600_000);
    const laterUtc = new Date(Date.now() + 30 * 86_400_000);
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
          name: `E2E TZ ${slug.slice(-8)}`,
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
          roleId: role.id,
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });
      const brand = await prisma.brand.create({
        data: { workspaceId, slug: `${slug}-brand`, name: 'TZ Brand', status: 'ACTIVE' },
        select: { id: true },
      });
      for (const [title, at] of [
        ['Too late in Tokyo', soonUtc],
        ['Still fine in Tokyo', laterUtc],
      ] as const) {
        const item = await prisma.contentItem.create({
          data: {
            workspaceId,
            brandId: brand.id,
            title,
            contentType: 'POST',
            primaryLocale: 'EN',
            status: 'SCHEDULED',
            origin: 'HUMAN',
            createdByUserId: owner.id,
            idempotencyKey: `${slug}-${title}`,
          },
          select: { id: true },
        });
        await prisma.calendarSlot.create({
          data: {
            workspaceId,
            brandId: brand.id,
            contentItemId: item.id,
            scheduledAtUtc: at,
            scheduledLocalTime: local(at),
            timezone: 'UTC',
            status: 'SCHEDULED',
            platformKeys: ['linkedin'],
            createdByUserId: owner.id,
            usageIdempotencyKey: `calendar:${workspaceId}:${randomUUID()}`,
          },
        });
      }
    });

    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await page.click(`[data-testid="choose-workspace-${slug}"]`);
    await page.waitForURL(/\/en\/overview$/);

    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    await page.getByTestId('settings-timezone').click();
    await page.getByTestId('settings-timezone').fill('Tokyo');
    await page.getByRole('option', { name: /Tokyo/ }).first().click();
    // Before saving: one post keeps its time, one is listed as going back to planned.
    const warning = page.getByTestId('settings-timezone-warning');
    await expect(warning).toContainText('1 planned posts keep their local clock time');
    await expect(page.getByTestId('settings-timezone-unplanned')).toContainText(
      'Too late in Tokyo',
    );
    await expect(page.getByTestId('settings-timezone-unplanned')).not.toContainText(
      'Still fine in Tokyo',
    );
    await page.getByTestId('settings-save').click();
    await page.waitForURL(/ok=SETTINGS_SAVED/);

    // Its author — the owner here — is told in the app.
    await page.goto(`${DASHBOARD_BASE_URL}/en/notifications`);
    await expect(page.getByTestId('notifications-list')).toContainText(
      'The time zone changed and your post’s time would have passed',
    );
  });
});

test.describe('G8 / Q16 · sign-up, reset and a new workspace from inside the app', () => {
  test('a refused sign-up comes back with the name, email and time zone — never the password', async ({
    page,
  }) => {
    const email = `e2e-draft-${randomUUID().slice(0, 8)}@example.local`;
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-up`);
    await page.fill('#name', 'Draft Keeper');
    await page.fill('#email', email);
    await page.fill('#timezone', 'Africa/Cairo');
    await page.press('#timezone', 'Enter');
    // The browser's own length check is lifted so the SERVER refuses the
    // password — the refusal this feature is about.
    await page.evaluate(() => {
      for (const id of ['password', 'password-confirm']) {
        document.getElementById(id)?.removeAttribute('minlength');
      }
    });
    await page.fill('#password', 'short');
    await page.fill('#password-confirm', 'short');
    const terms = page.locator('[data-testid="accept-terms-of-service"] input[type="checkbox"]');
    if ((await terms.count()) > 0) await terms.check();
    await page.click('[data-testid="signup-submit"]');
    await page.waitForURL(/\/en\/sign-up\?error=/);
    await expect(page.locator('#name')).toHaveValue('Draft Keeper');
    await expect(page.locator('#email')).toHaveValue(email);
    await expect(page.locator('#timezone')).toHaveValue(/Cairo/);
    await expect(page.locator('#password')).toHaveValue('');
    await expect(page.locator('#password-confirm')).toHaveValue('');
    // The email is not in the address bar.
    expect(page.url()).not.toContain(encodeURIComponent(email));
  });

  test('a mismatched reset confirmation does not submit (the policy is unchanged, D-261)', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/reset/not-a-real-token`);
    await page.fill('#password', 'a-long-enough-password');
    await page.fill('#password-confirm', 'a-different-password');
    await page.click('[data-testid="reset-submit"]');
    // Nothing was sent: still on the form, no server answer in the URL.
    await expect(page).toHaveURL(/\/en\/reset\/not-a-real-token$/);
    expect(
      await page
        .locator('#password-confirm')
        .evaluate((input) => (input as HTMLInputElement).validity.customError),
    ).toBe(true);
    await page.fill('#password-confirm', 'a-long-enough-password');
    expect(
      await page
        .locator('#password-confirm')
        .evaluate((input) => (input as HTMLInputElement).validity.valid),
    ).toBe(true);
  });

  test('an owner starting another workspace gets a blank form, a city for Egypt only, and a way back', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/onboarding/workspace`);
    await expect(page.getByTestId('create-workspace-form')).toBeVisible();
    // Blank: nothing is copied from the current workspace.
    await expect(page.locator('#name')).toHaveValue('');
    await expect(page.getByTestId('city-select')).toHaveCount(0);
    const egypt = new Intl.DisplayNames(['en'], { type: 'region' }).of('EG') ?? 'Egypt';
    await page.fill('[data-testid="country-select"]', egypt);
    await page.press('[data-testid="country-select"]', 'Enter');
    await expect(page.getByTestId('city-select')).toBeVisible();
    const back = page.getByTestId('create-workspace-back');
    await expect(back).toHaveAttribute('href', '/en/overview');
    await back.click();
    await page.waitForURL(/\/en\/overview$/);
  });
});
