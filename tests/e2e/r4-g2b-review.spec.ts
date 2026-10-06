import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * ROUND 4, GATE 2b — THE OWNER'S REVIEW (item 4, a–i). One settings frame
 * whose save bar sits on the frame's bottom edge in every section; Publishing
 * defaults' times as chips; Data's three prototype rows first; one name for
 * two-step verification; the controls the prototype does not draw (the
 * campaign's notes, the publishing history, the popovers' "⋯") behind an
 * existing affordance; the Copilot's context on one line; a count on every
 * publishing tab; Look & voice's one field per column; and the Arabic caption
 * and Latin initials.
 */

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

/** The section's save bar: its form's last row, the bar with the status line. */
const BAR = ".bsp-sg-form > div[data-state]:has(> span[role='status']):last-child";

test.describe('Round 4 · Gate 2b review (4b) — one save bar, on the frame’s bottom edge', () => {
  // A short screen, so every section scrolls in the frame.
  test.use({ viewport: { width: 1440, height: 520 } });

  for (const section of ['', '/approvals', '/ai', '/notifications', '/publishing']) {
    test(`Settings${section || ' (General)'}: the bar is on the frame’s edge, clear of the Copilot`, async ({
      page,
    }) => {
      await signIn(page);
      await page.goto(`${DASHBOARD_BASE_URL}/en/settings${section}`);
      const bar = page.locator(BAR);
      // One frame: the section's last form carries the bar that closes the column.
      await expect(bar).toHaveCount(1);
      await expect(bar).toBeVisible();
      /*
       * With several brands each brand keeps its own form and bar; every bar
       * sits on the frame's bottom edge while its form crosses that edge, and
       * the last one, at the very end, rests on the page's bottom padding as
       * the prototype's bar does.
       */
      const measured = await page.evaluate(async () => {
        const scroller = document.querySelector<HTMLElement>('main.bsp-scroll');
        const pageFlow = document.querySelector<HTMLElement>('.bsp-page');
        if (!scroller || !pageFlow) return null;
        const frame = () => scroller.getBoundingClientRect();
        const settle = () => new Promise((done) => requestAnimationFrame(() => done(null)));
        const bars = Array.from(
          document.querySelectorAll<HTMLElement>(
            ".bsp-sg-main form > div[data-state]:has(> span[role='status']):last-child",
          ),
        );
        const crossing: number[] = [];
        for (const barEl of bars) {
          const form = barEl.parentElement as HTMLElement;
          // The form's first 120px in view at the frame's foot, the rest below it.
          scroller.scrollTop = 0;
          await settle();
          const want = form.getBoundingClientRect().top - (frame().bottom - 120);
          scroller.scrollTop = Math.max(0, want);
          await settle();
          const formBox = form.getBoundingClientRect();
          if (formBox.top <= frame().bottom - 100 && formBox.bottom > frame().bottom) {
            crossing.push(frame().bottom - barEl.getBoundingClientRect().bottom);
          }
        }
        scroller.scrollTop = scroller.scrollHeight;
        await settle();
        const last = bars[bars.length - 1];
        return {
          scrolls: scroller.scrollHeight > scroller.clientHeight,
          crossing,
          endGap: last ? frame().bottom - last.getBoundingClientRect().bottom : Infinity,
          padding: parseFloat(getComputedStyle(pageFlow).paddingBottom),
        };
      });
      expect(measured).not.toBeNull();
      expect(measured?.scrolls).toBe(true);
      // At least the column's own bar crossed the edge, and every bar that did sat on it.
      expect(measured?.crossing.length ?? 0).toBeGreaterThan(0);
      for (const gap of measured?.crossing ?? []) {
        // On the frame's bottom edge (its 8px inset), not carried down with the page.
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThanOrEqual(16);
      }
      expect(measured?.endGap ?? Infinity).toBeGreaterThanOrEqual(0);
      expect(measured?.endGap ?? Infinity).toBeLessThanOrEqual((measured?.padding ?? 0) + 1);

      // "Save" is never under the floating Copilot.
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('main.bsp-scroll');
        if (scroller) scroller.scrollTop = 0;
      });
      const save = await bar.locator('button[type="submit"]').boundingBox();
      const fab = await page.locator('.bsp-fab').first().boundingBox();
      expect(save).not.toBeNull();
      if (save && fab) {
        const overlaps =
          save.x < fab.x + fab.width &&
          fab.x < save.x + save.width &&
          save.y < fab.y + fab.height &&
          fab.y < save.y + save.height;
        expect(overlaps).toBe(false);
      }
    });
  }
});

test.describe('Round 4 · Gate 2b review — the sections', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('4d Publishing defaults: times as chips, "Other" opens the field, templates behind "⋯"', async ({
    page,
  }) => {
    const brandId = brandFixtures(credentials()).primaryBrandId;
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/publishing`);
    const form = page.getByTestId(`publishing-defaults-form-${brandId}`);
    await expect(form).toBeVisible();
    for (const time of ['09:00', '13:00', '18:00', 'other']) {
      await expect(page.getByTestId(`publishing-default-time-${brandId}-${time}`)).toHaveCount(1);
    }
    // No native time input on the surface…
    const field = page.getByTestId(`publishing-default-time-${brandId}`);
    await expect(field).toBeHidden();
    // …until "Other" asks for one.
    await page.getByTestId(`publishing-default-time-${brandId}-other`).check();
    await expect(field).toBeVisible();
    await page.getByTestId(`publishing-default-time-${brandId}-09:00`).check();
    await expect(field).toBeHidden();

    // A chosen channel looks chosen: its chip is the selected chip, an unchosen one is not.
    const chip = (key: string) =>
      page.locator('label.bsp-pd-chip', {
        has: page.getByTestId(`publishing-default-channel-${brandId}-${key}`),
      });
    const instagram = page.getByTestId(`publishing-default-channel-${brandId}-instagram`);
    await instagram.check();
    const linkedin = page.getByTestId(`publishing-default-channel-${brandId}-linkedin`);
    await linkedin.uncheck();
    // The chip's colour eases in (0.15s): judge the colour it settles on.
    const background = (key: string) =>
      chip(key).evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect.poll(() => background('instagram')).toBe('rgb(17, 17, 20)');
    await expect.poll(() => background('linkedin')).toBe('rgb(255, 255, 255)');

    // Post templates are behind the frame's "⋯", on their own view.
    await expect(page.getByTestId(`templates-${brandId}`)).toHaveCount(0);
    await page.getByTestId('publishing-more').click();
    await page.getByTestId('publishing-more-templates').click();
    await page.waitForURL((url) => url.searchParams.get('templates') === '1');
    await expect(page.getByTestId(`templates-${brandId}`)).toBeVisible();
    await expect(page.getByTestId('publishing-defaults-back')).toBeVisible();
  });

  test('4c Data: the prototype’s three rows first, in order; the rest behind one "More"', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/data`);
    const rows = page.locator('[data-testid="data-controls"] > section');
    await expect(rows).toHaveCount(3);
    const ids = await rows.evaluateAll((list) => list.map((el) => el.getAttribute('data-testid')));
    expect(ids).toEqual(['data-control-workspaceExport', 'data-retention', 'workspace-deletion']);
    await expect(page.getByTestId('data-retention')).toContainText('Data retention');
    // The product-only rows are closed under "More" until asked for.
    const more = page.getByTestId('data-more');
    await expect(more).not.toHaveAttribute('open', '');
    await more.locator('summary').click();
    await expect(more.getByTestId('data-control-retention')).toBeVisible();
  });

  test('4e Security: compact rows and one name, "Two-step verification"', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/security`);
    await expect(page.getByTestId('mfa-card')).toContainText('Two-step verification');
    const text = (await page.locator('.bsp-sg-main').innerText()).toLowerCase();
    for (const other of ['two-factor', 'mfa', '2fa', 'multi-factor']) {
      expect(text, `the page says "${other}"`).not.toContain(other);
    }
  });

  test('4f Off the surface: campaign notes, publishing history and the popovers’ "⋯"', async ({
    page,
  }) => {
    const loaded = credentials();
    const campaignId = await withPlatformPrisma(async (prisma) => {
      const campaign = await prisma.campaign.create({
        data: {
          workspaceId: loaded.customer.workspaceId,
          brandId: brandFixtures(loaded).primaryBrandId,
          name: `Review ${randomUUID().slice(0, 6)}`,
          objective: 'LAUNCH',
          status: 'ACTIVE',
          channels: ['instagram'],
        },
        select: { id: true },
      });
      return campaign.id;
    });
    try {
      // The campaign room: no Notes chip on the page; "⋯" opens them.
      await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns/${campaignId}`);
      await expect(page.getByTestId('campaign-paused-banner')).toHaveCount(0);
      await expect(page.getByTestId('campaign-notes')).toHaveCount(0);
      await page.getByTestId('campaign-more').click();
      await page.getByTestId('campaign-view-notes').click();
      await page.waitForURL((url) => url.searchParams.get('notes') === '1');
      await expect(page.getByTestId('campaign-notes')).toBeVisible();
    } finally {
      await withPlatformPrisma((prisma) =>
        prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'ARCHIVED', deletedAt: new Date() },
        }),
      );
    }

    // Accounts: the publishing history is a view behind "⋯", not a block on the page.
    await page.goto(`${DASHBOARD_BASE_URL}/en/integrations`);
    await expect(page.getByTestId('publishing-history')).toHaveCount(0);
    await page.getByTestId('integrations-more').click();
    await page.getByTestId('integrations-more-history').click();
    await page.waitForURL((url) => url.searchParams.get('history') === '1');
    await expect(page.getByTestId('publishing-history')).toBeVisible();

    // The notifications popover and the Copilot panel carry no "⋯".
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.getByTestId('topbar-notifications').click();
    const feed = page.getByTestId('notifications-feed');
    await expect(feed).toBeVisible();
    await expect(feed.locator('.bsp-fdis')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByTestId('topbar-copilot').click();
    const drawer = page.getByTestId('copilot-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('copilot-header').locator('.bsp-fdis')).toHaveCount(0);

    // The publishing log's tabs carry no "⋯" either.
    await page.goto(`${DASHBOARD_BASE_URL}/en/publishing`);
    await expect(page.locator('.bsp-pl-top .bsp-fdis')).toHaveCount(0);
  });

  test('4g/4i Copilot context and the brand caption fit on one line, in both languages', async ({
    page,
  }) => {
    for (const locale of ['en', 'ar']) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
      const caption = page.getByTestId('active-brand-caption').first();
      await expect(caption).toBeVisible();
      const captionFits = await caption.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
      expect(captionFits, `${locale}: the brand caption is cut`).toBe(true);

      await page.getByTestId('topbar-copilot').click();
      const context = page.getByTestId('copilot-drawer').getByTestId('copilot-context');
      await expect(context).toBeVisible();
      if (locale === 'en') await expect(context).toHaveText(/^Working on: Home · \S.*$/);
      const line = await context.evaluate((el) => {
        const style = getComputedStyle(el);
        const height = el.getBoundingClientRect().height;
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
        return {
          oneLine: height <= lineHeight * 1.5,
          // A name too long for the head ends in "…"; the whole line is its hover text.
          hover: el.getAttribute('title') === el.textContent,
        };
      });
      expect(line.oneLine, `${locale}: the context wraps`).toBe(true);
      expect(line.hover, `${locale}: the whole context is not on hover`).toBe(true);
      await page.keyboard.press('Escape');
    }
  });

  test('4h Publishing log: every tab carries its count', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/publishing`);
    const tabs = page.getByTestId('publishing-tabs');
    for (const id of ['queue', 'published', 'failed']) {
      await expect(tabs.getByTestId(`tab-${id}`).locator('.bsp-seg-n')).toHaveText(/^\d+$/);
    }
  });

  test('4a Look & voice: one field per column, the other language behind the row’s chip', async ({
    page,
  }) => {
    for (const [locale, reader, other] of [
      ['en', 'en', 'ar'],
      ['ar', 'ar', 'en'],
    ] as const) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain?tab=look`);
      await expect(page.getByTestId('voice-card')).toBeVisible();
      for (const row of ['voice-words', 'voice-do-add', 'voice-dont-add']) {
        await expect(page.getByTestId(`${row}-${reader}`)).toBeVisible();
        await expect(page.getByTestId(`${row}-${other}`)).toBeHidden();
      }
      // The row's own chip opens the other language for that row only.
      await page.getByTestId('voice-do-other-language').click();
      await expect(page.getByTestId(`voice-do-add-${other}`)).toBeVisible();
      await expect(page.getByTestId(`voice-dont-add-${other}`)).toBeHidden();
    }
  });

  test('4i Arabic: avatar initials stay Latin', async ({ page }) => {
    let seen = 0;
    for (const path of ['/ar/members', '/ar/settings/approvals']) {
      await page.goto(`${DASHBOARD_BASE_URL}${path}`);
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      const initials = await page
        .locator('.bsp-tm-av')
        .evaluateAll((list) => list.map((el) => (el.textContent ?? '').trim()));
      seen += initials.length;
      for (const value of initials) expect(value, path).toMatch(/^[A-Z0-9]{1,2}$/);
    }
    expect(seen, 'no avatars were drawn').toBeGreaterThan(0);
  });
});
