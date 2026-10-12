import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { noticedSuggestion } from './pr-e-fixtures';
import { withPlatformPrisma } from './platform-prisma';

/**
 * FIX PR 2c (D-506) — THE SCREEN FIXES, THROUGH THE SCREEN.
 *
 *   - Plan & billing: plain names for every quota, the storage unit, the
 *     "Allowance" and "Availability" headers, and no limit on a feature that
 *     is off.
 *   - Automations: "Duplicate" opens the builder filled from the rule and
 *     saves a new, switched-on rule; "New rule" is not offered under the
 *     archived-brand refusal.
 *   - Campaigns: Pause on an active card, audited as a person's pause.
 *   - Onboarding: the industry chosen on the Business step reaches the brand
 *     step, where a finished brand can be edited and saved.
 *   - The Copilot button stays FLOATING (Q2, owner's answer (c)): the last
 *     row of the longest table scrolls fully clear of it; it steps aside
 *     while a modal dialog is open; narrowing the window never pushes the
 *     page sideways.
 *   - The workspace list rests on whole rows: no row is cut to an empty bar.
 *   - Home: no "0 pieces of evidence" line; the Notes card's button says Close.
 */

const LOCALES = ['en', 'ar'] as const;
/** The industry `seed-calendar-fixture.ts` configures (importing it would run it). */
const FIXTURE_INDUSTRY = 'e2e-fixture-industry';

for (const locale of LOCALES) {
  test(`Plan & billing: plain names, units, headers, no limit where none applies (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`fix2c-plan-${locale}`);
    await withPlatformPrisma((prisma) =>
      prisma.usageCounter.create({
        data: {
          workspaceId: own.workspaceId,
          featureKey: 'limit.storage_gb',
          // The storage meter's one "total" window (`quotaWindow('total')`).
          periodStart: new Date(Date.UTC(1970, 0, 1)),
          periodEnd: new Date(Date.UTC(9999, 0, 1)),
          usedValue: 1,
          usedBytes: BigInt(300 * 1024 * 1024),
        },
      }),
    );
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/plan`);

    const quota = page.getByTestId('quota-table');
    await expect(quota.locator('th').first()).toHaveText(locale === 'ar' ? 'الحصة' : 'Allowance');
    const storage = page.getByTestId('quota-limit.storage_gb');
    await expect(storage.locator('td').first()).toHaveText(locale === 'ar' ? 'التخزين' : 'Storage');
    await expect(storage.locator('td').nth(1)).toHaveText(locale === 'ar' ? '1 غيغابايت' : '1 GB');

    const features = page.getByTestId('features-table');
    await expect(features.locator('th').nth(1)).toHaveText(
      locale === 'ar' ? 'التوفّر' : 'Availability',
    );
    // No raw `limit.*` key anywhere a person reads.
    for (const id of ['quota-table', 'features-table']) {
      await expect(page.getByTestId(id)).not.toContainText('limit.');
    }
    // A feature that is off has no limit: "—", said as "Not applicable".
    const rows = features.locator('tbody tr');
    const off = locale === 'ar' ? 'معطّلة' : 'Disabled';
    let offRows = 0;
    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      if ((await row.locator('td').nth(1).innerText()).trim() !== off) continue;
      offRows++;
      const limit = row.locator('td').nth(2);
      await expect(limit.locator('[aria-hidden="true"]')).toHaveText('—');
      await expect(limit).toContainText(locale === 'ar' ? 'لا ينطبق' : 'Not applicable');
    }
    expect(offRows).toBeGreaterThan(0);
  });
}

test('Automations: Duplicate opens the builder filled, and saves a new rule that is on', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  const own = await ownWorkspace('fix2c-dup');
  const ruleId = randomUUID();
  const name = `Schedule what is approved ${Date.now().toString(36)}`;
  await withPlatformPrisma((prisma) =>
    prisma.automationRule.create({
      data: {
        id: ruleId,
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        name,
        enabled: false,
        triggerType: 'CONTENT_APPROVED',
        triggerConfig: {},
        conditions: [],
        actionType: 'SCHEDULE_NEXT_FREE_SLOT',
        actionConfig: {},
        maxRunsPerDay: 0,
        createdByUserId: own.ownerId,
      },
    }),
  );
  await enter(page, own.slug, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);
  await page.getByTestId(`automation-more-${ruleId}`).click();
  await page.getByTestId(`automation-duplicate-${ruleId}`).click();
  await page.waitForURL(new RegExp(`/automations\\?new=1&from=${ruleId}$`));
  await expect(page.getByTestId('automation-new-dialog')).toBeVisible();
  await expect(page.getByTestId('automation-name')).toHaveValue(`${name} (copy)`);
  await page.getByTestId('automation-submit').click();
  await page.waitForURL(/\/automations\?.*ok=/);

  const rules = await withPlatformPrisma((prisma) =>
    prisma.automationRule.findMany({
      where: { workspaceId: own.workspaceId },
      select: { id: true, name: true, enabled: true, triggerType: true, actionType: true },
    }),
  );
  const copy = rules.find((rule) => rule.id !== ruleId);
  expect(copy).toMatchObject({
    name: `${name} (copy)`,
    enabled: true,
    triggerType: 'CONTENT_APPROVED',
    actionType: 'SCHEDULE_NEXT_FREE_SLOT',
  });
  // The rule it came from is untouched.
  expect(rules.find((rule) => rule.id === ruleId)).toMatchObject({ name, enabled: false });
});

test('Automations: no "New rule" under the archived-brand refusal', async ({ page, isMobile }) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  const own = await ownWorkspace('fix2c-archived');
  await enter(page, own.slug, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);
  await expect(page.getByTestId('automation-new')).toBeVisible();
  await page.goto(`${DASHBOARD_BASE_URL}/en/automations?error=AUTOMATION_BRAND_ARCHIVED`);
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByTestId('automation-new')).toHaveCount(0);
});

test('Campaigns: Pause on an active card pauses it, audited as a person’s pause', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  const own = await ownWorkspace('fix2c-pause');
  const campaignId = randomUUID();
  await withPlatformPrisma((prisma) =>
    prisma.campaign.create({
      data: {
        id: campaignId,
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        name: 'Autumn launch',
        objective: 'LAUNCH',
        status: 'ACTIVE',
        createdByUserId: own.ownerId,
      },
    }),
  );
  await enter(page, own.slug, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns?status=ACTIVE`);
  await page.getByTestId(`campaign-pause-${campaignId}`).click();
  await page.waitForURL(/\/campaigns\?status=PAUSED&ok=CAMPAIGN_PAUSED$/);
  // Paused: the card is under Paused now, and offers no Pause.
  await expect(page.getByTestId(`campaign-pause-${campaignId}`)).toHaveCount(0);

  const stored = await withPlatformPrisma(async (prisma) => ({
    campaign: await prisma.campaign.findUniqueOrThrow({
      where: { id: campaignId },
      select: { status: true },
    }),
    audit: await prisma.auditEvent.findFirst({
      where: { workspaceId: own.workspaceId, resourceId: campaignId },
      orderBy: { occurredAt: 'desc' },
      select: { reason: true, actorId: true },
    }),
  }));
  expect(stored.campaign.status).toBe('PAUSED');
  expect(stored.audit).toMatchObject({ reason: 'manual_pause', actorId: own.ownerId });
});

test('Onboarding: the industry chosen on the Business step is saved with the brand', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  const own = await ownWorkspace('fix2c-onb');
  await enter(page, own.slug, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/onboarding?step=business`);
  await page.getByTestId(`setup-business-industry-${FIXTURE_INDUSTRY}`).check();
  await page.getByTestId('setup-continue').click();
  await page.waitForURL(
    (url) =>
      url.searchParams.get('step') === 'brand' &&
      url.searchParams.get('industry') === FIXTURE_INDUSTRY,
  );

  // The finished brand step is a form now, with the industry carried in.
  const form = page.getByTestId('setup-brand-edit');
  await expect(form).toBeVisible();
  await expect(page.getByTestId('setup-brand-industry')).toHaveValue(FIXTURE_INDUSTRY);
  // One "Industry" on the step: the field's own label, no second line above it.
  await expect(form.getByText('Industry', { exact: true })).toHaveCount(1);
  const renamed = `Renamed brand ${Date.now().toString(36)}`;
  await page.getByTestId('setup-brand-name').fill(renamed);
  await page.getByTestId('setup-continue').click();
  await page.waitForURL(
    (url) =>
      url.searchParams.get('step') === 'learn' &&
      url.searchParams.get('ok') === 'SETUP_BRAND_SAVED',
  );

  const brand = await withPlatformPrisma((prisma) =>
    prisma.brand.findUniqueOrThrow({
      where: { id: own.brandId },
      select: { name: true, industry: true },
    }),
  );
  expect(brand).toEqual({ name: renamed, industry: FIXTURE_INDUSTRY });
});

/**
 * How far the last row of the longest table — Settings → Team & roles → "All
 * permissions", one row per workspace permission — ends above the floating
 * Copilot button, with the page scrolled to its end — and the page's last
 * line under it too.
 */
async function lastRowClearance(page: Page) {
  return page.evaluate(() => {
    const fab = document.querySelector('.bsp-fab');
    const rows = document.querySelectorAll('[data-testid="permissions-table"] tbody tr');
    const last = rows[rows.length - 1];
    if (!fab || !last) return null;
    const top = fab.getBoundingClientRect().top;
    // The page's own last line, under the table: nothing may end under the button.
    const end = document.querySelector('[data-testid="permissions-logged"]');
    return {
      rows: rows.length,
      gap: Math.min(
        top - last.getBoundingClientRect().bottom,
        end ? top - end.getBoundingClientRect().bottom : Infinity,
      ),
    };
  });
}

for (const locale of LOCALES) {
  test(`the last row of the longest table scrolls fully clear of the floating Copilot (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the phone layout docks the button in the header (D-468 (b))');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`fix2c-table-${locale}`);
    await enter(page, own.slug, locale);
    for (const size of [
      { width: 1280, height: 800 },
      { width: 1536, height: 864 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(size);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/permissions`);
      await page.getByTestId('permissions-all').click();
      const rows = page.locator('[data-testid="permissions-table"] tbody tr');
      await expect(rows.last()).toBeVisible();
      expect(await rows.count()).toBeGreaterThan(20);
      // Floating, as the prototype draws it.
      const fab = page.locator('.bsp-fab');
      await expect(fab).toHaveCSS('position', 'fixed');
      await page.locator('main.bsp-scroll').evaluate((main) => {
        main.scrollTop = main.scrollHeight;
      });
      await expect
        .poll(async () => (await lastRowClearance(page))?.gap ?? -1, {
          message: `${size.width}px: the last row ends above the button`,
        })
        .toBeGreaterThanOrEqual(8);
    }
  });
}

test('the floating Copilot steps aside under a modal dialog, and narrowing never scrolls sideways', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  const own = await ownWorkspace('fix2c-fab');
  await page.setViewportSize({ width: 1440, height: 900 });
  await enter(page, own.slug, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);
  await expect(page.locator('.bsp-fab')).toBeVisible();
  await page.goto(`${DASHBOARD_BASE_URL}/en/automations?new=1`);
  await expect(page.getByTestId('automation-new-dialog')).toBeVisible();
  await expect(page.locator('.bsp-fab')).toBeHidden();

  await page.goto(`${DASHBOARD_BASE_URL}/en/analytics`);
  for (const width of [1440, 860, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${width}px scrolls sideways`).toBeLessThanOrEqual(1);
  }
});

for (const locale of LOCALES) {
  test(`the workspace list rests on whole rows, top and end (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the phone layout scrolls the page (post-launch)');
    test.setTimeout(150_000);
    // Enough workspaces to overflow a short window, whatever else exists.
    const own = await ownWorkspace(`fix2c-list-${locale}`);
    for (let i = 0; i < 8; i++) await ownWorkspace(`fix2c-list-${locale}-${i}`);
    await enter(page, own.slug, locale);
    await page.setViewportSize({ width: 1280, height: 640 });
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/workspaces`);
    const list = page.locator('.bsp-auth-wslist');
    await expect(list).toBeVisible();

    const cut = () =>
      list.evaluate((l) => {
        const top = l.getBoundingClientRect().top;
        const clipped = [...l.children]
          .map((li) => li.getBoundingClientRect())
          .find((r) => r.top < top - 0.5 && r.bottom > top + 0.5);
        return {
          overflows: l.scrollHeight > l.clientHeight,
          clipped: clipped ? clipped.bottom - top : 0,
        };
      });
    expect((await cut()).overflows).toBe(true);
    expect((await cut()).clipped).toBe(0);

    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 3; step++) {
      await page.mouse.wheel(0, 97);
      await expect.poll(async () => (await cut()).clipped).toBe(0);
    }
    // The very end lands on a row too.
    await list.evaluate((l) => l.scrollTo({ top: l.scrollHeight }));
    await expect.poll(async () => (await cut()).clipped).toBe(0);
  });
}

test('Home: no evidence line for a suggestion with none; the Notes card says Close', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  const own = await ownWorkspace('fix2c-home');
  const bare = await noticedSuggestion(own, 'Post more reels on weekdays');
  const backed = await noticedSuggestion(own, 'Mornings reach more people');
  await withPlatformPrisma((prisma) =>
    prisma.insightEvidence.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        insightId: backed,
        ordinal: 1,
        kind: 'ABSENCE',
        labelKey: 'content.pillar_unpublished',
      },
    }),
  );
  await page.setViewportSize({ width: 1536, height: 864 });
  await enter(page, own.slug, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
  await expect(page.getByTestId(`home-recommendation-${bare}`)).toBeVisible();
  await expect(page.getByTestId(`home-recommendation-evidence-${bare}`)).toHaveCount(0);
  await expect(page.getByTestId(`home-recommendation-${bare}`)).not.toContainText(
    'pieces of evidence',
  );
  await expect(page.getByTestId(`home-recommendation-evidence-${backed}`)).toContainText(
    '1 pieces of evidence',
  );

  await page.getByTestId('notes-popover-trigger').locator('a').first().click();
  const popover = page.getByTestId('notes-popover');
  await expect(popover).toBeVisible();
  await expect(popover.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(popover).not.toContainText('Dismiss');
  await popover.getByRole('button', { name: 'Close' }).click();
  await expect(popover).toHaveCount(0);

  // The bell's feed says Close too (it only ever closed the feed).
  await page.getByTestId('topbar-notifications').click();
  const feed = page.getByTestId('notifications-feed');
  await expect(feed).toBeVisible();
  await expect(feed.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(feed).not.toContainText('Dismiss');
});
