import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { inlineEndOverhang } from './overflow';

/**
 * PHASE 6 · P6-14 — EVERY CUSTOMER SCREEN, IN BOTH LANGUAGES, AT BOTH WIDTHS.
 *
 * Each workstream proved its own screens. This sweep proves the product as a
 * customer meets it after all of them: every signed-in route, in English and
 * Arabic, in the desktop AND the phone project (the two viewport projects run
 * this file), asserting what a locale regression actually breaks —
 *
 *   - the document carries the locale's `lang` and `dir`;
 *   - nothing overhangs the inline-end edge (measured properly, F-26 — in RTL
 *     that is the LEFT edge, which a scroll-width check cannot see);
 *   - axe reports NO violation at WCAG 2.2 AA — not "no serious one";
 *   - the Arabic screen's heading is in Arabic and it shows no raw enum state,
 *     and no screen shows a raw dictionary key or the word `undefined` (a
 *     missing key renders as that).
 *
 * READ-ONLY. It runs in both viewport projects in parallel against the shared
 * seeded workspace, so it navigates and measures and never submits.
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
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/);
}

/** Every signed-in customer route without a path parameter. */
const ROUTES = [
  '/overview',
  '/analytics',
  '/intelligence',
  '/brand-brain',
  '/copilot',
  '/automations',
  '/approvals',
  '/calendar',
  '/content',
  '/content/compose',
  '/campaigns',
  '/campaigns/new',
  '/assets',
  '/creative',
  '/strategy',
  '/notifications',
  '/integrations',
  '/members',
  '/permissions',
  '/activity',
  '/settings',
  '/settings/brand',
  '/settings/security',
  '/settings/data',
  '/plan',
  '/billing',
] as const;

/**
 * A raw dictionary key on screen: one of the dictionary's own top-level
 * prefixes followed by a dotted segment, e.g. `plan.usageOf`. Built from the
 * dictionary so it cannot drift, and anchored to whole words so a domain name
 * or a file name does not match.
 */
const PREFIXES = [...new Set(Object.keys(messages.en).map((key) => key.split('.')[0]))];
const RAW_KEY = new RegExp(`(^|\\s)(${PREFIXES.join('|')})\\.[a-zA-Z][a-zA-Z_.]*[a-zA-Z](?=\\s|$)`);

const ARABIC = /[\u0600-\u06FF]/;

/**
 * A database enum printed raw — `ACTIVE`, `NEEDS_REAUTH`. On an Arabic screen
 * that is untranslated state, which the heading and key checks cannot see
 * (P6-15 found the Team screen's member statuses this way). Checked in Arabic
 * only, where no English word belongs; an acronym like `AI` or `CSV` is not
 * a state and is too short or absent from the list to match.
 */
const RAW_STATE =
  /\b([A-Z]{2,}_[A-Z_]+|ACTIVE|PENDING|DRAFT|SCHEDULED|FAILED|PUBLISHED|REVOKED|EXPIRED|ARCHIVED|APPROVED|REJECTED|READY|PROCESSING|QUEUED|RUNNING|SUCCEEDED|CANCELLED|DISABLED|ENABLED|CONNECTED|INVITED|SUSPENDED|REMOVED|ACCEPTED|PAUSED|COMPLETED)\b/;

test.describe('P6-14 · every customer screen, both languages', () => {
  test.describe.configure({ timeout: 120_000 });

  for (const route of ROUTES) {
    test(`${route} is correct in English and Arabic`, async ({ page }) => {
      await signIn(page);
      for (const locale of ['en', 'ar'] as const) {
        const label = `${locale}${route}`;
        await page.goto(`${DASHBOARD_BASE_URL}/${locale}${route}`);
        await expect(page.locator('main').first(), label).toBeVisible();

        const html = page.locator('html');
        await expect(html, label).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
        await expect(html, label).toHaveAttribute('lang', new RegExp(`^${locale}`));

        const overhang = await inlineEndOverhang(page);
        expect(overhang.px, `${label} overhangs by ${overhang.px}px: ${overhang.offender}`).toBe(0);

        // `<code>` is an identifier shown on purpose (a permission key on the
        // Permissions screen), not copy — everything else is read as copy.
        // `innerText`, not `textContent`: the latter runs adjacent blocks
        // together ("settings." + "Open") into something that reads as a key.
        const text = await page.evaluate(() => {
          const main = document.querySelector('main') as HTMLElement | null;
          if (!main) return '';
          let rendered = main.innerText;
          for (const node of Array.from(main.querySelectorAll('code'))) {
            rendered = rendered.replace((node as HTMLElement).innerText, ' ');
          }
          return rendered;
        });
        expect(text, `${label} shows "undefined"`).not.toMatch(/\bundefined\b/);
        expect(text.match(RAW_KEY)?.[0] ?? null, `${label} shows a raw key`).toBeNull();

        if (locale === 'ar') {
          expect(text.match(RAW_STATE)?.[0] ?? null, `${label} shows a raw state`).toBeNull();
          const heading = (await page.locator('h1').first().innerText()).trim();
          expect(heading, `${label} heading`).toMatch(ARABIC);
        }

        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        const summary = results.violations.map(
          (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
        );
        expect(summary, label).toEqual([]);
      }
    });
  }
});
