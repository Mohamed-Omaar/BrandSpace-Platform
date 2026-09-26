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
