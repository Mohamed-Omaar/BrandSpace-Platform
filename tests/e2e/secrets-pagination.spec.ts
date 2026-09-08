import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_BASE_URL } from './apps';
import { signIn } from './admin-session';
import { expectNoHorizontalOverflow } from './overflow';
import { deleteTestSecrets, testSecretProvider } from '../support/secret-fixtures';
import { withPlatformPrisma } from './platform-prisma';

/**
 * The secrets listing, paginated — F-53, through the browser.
 *
 * `admin-console.spec.ts` proves a secret is stored and never shown. This file
 * proves the OTHER half of F-53: that a listing large enough to have broken the
 * page still renders one bounded page, tells the operator how many records
 * exist, and can be navigated with a keyboard in both writing directions.
 *
 * The dataset is seeded DIRECTLY rather than through the form: the property
 * under test is how the page behaves with many records, and typing sixty
 * secrets into a form would take minutes to assert something the seeding is
 * incidental to. Every seeded row carries this run's cleanup token, and the
 * `afterAll` removes exactly those rows and no others.
 */

test.describe.configure({ mode: 'serial' });

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

/** Enough rows that a 25-row page is neither the first nor the last of two. */
const SEEDED = 60;
const PAGE_SIZE = 25;
const PROVIDER = testSecretProvider();
const CATEGORY = 'ai_provider';

function seededName(index: number): string {
  return `${PROVIDER} row ${String(index).padStart(3, '0')}`;
}

/** The listing URL for this run's rows only, so other suites cannot perturb it. */
function listUrl(locale: 'ar' | 'en', extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({ q: PROVIDER, size: String(PAGE_SIZE), ...toStrings(extra) });
  return `${ADMIN_BASE_URL}/${locale}/console/secrets?${params.toString()}`;
}

function toStrings(input: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)]));
}

async function expectNoBlockingA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ''));
  const detail = blocking
    .map(
      (v) =>
        `  [${v.impact}] ${v.id}: ${v.help}\n${v.nodes.map((n) => `      ${n.target.join(' ')}`).join('\n')}`,
    )
    .join('\n');
  expect(blocking, `serious/critical a11y violations on ${label}:\n${detail}`).toEqual([]);
}

test.beforeAll(async () => {
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.platformUser.findFirst({ select: { id: true } });
    if (!owner) {
      throw new Error('No platform user exists; run `pnpm e2e:seed` before the end-to-end suite.');
    }
    // Idempotent: a retried file re-runs this hook in the same worker, where
    // the token — and therefore every ref — is unchanged. Clearing first keeps
    // the seed from colliding with itself on `[ref, environment]`.
    await deleteTestSecrets(prisma, PROVIDER);
    await prisma.secretRecord.createMany({
      data: Array.from({ length: SEEDED }, (_, i) => ({
        // The token sits in the ref AND the name: the ref is what cleanup
        // matches on, the name is what the search box is typed with.
        ref: `${CATEGORY}/${PROVIDER}/development/row-${String(i).padStart(3, '0')}`,
        name: seededName(i),
        category: CATEGORY,
        environment: 'DEVELOPMENT' as const,
        status: 'ACTIVE' as const,
        createdByPlatformUserId: owner.id,
      })),
    });
  });
});

test.afterAll(async () => {
  const removed = await withPlatformPrisma((prisma) => deleteTestSecrets(prisma, PROVIDER));
  // The suite must leave the table exactly as it found it. F-53 began as a
  // slow page; it became a slow page because runs like this one never tidied up.
  expect(removed).toBe(SEEDED);
});

test.describe('the secrets listing pages rather than loading everything', () => {
  test('renders one page and reports the true total', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en'));

    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 1–25 of ${SEEDED}`);
    // One page of rows in the DOM, not sixty. This is the defect itself.
    await expect(page.locator('[data-testid^="secret-row-"]')).toHaveCount(PAGE_SIZE);
    await expect(page.getByTestId('secret-pagination')).toBeVisible();
  });

  test('walks first, middle and last page with the right range each time', async ({ page }) => {
    await signIn(page, 'en');

    await page.goto(listUrl('en', { page: 1 }));
    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 1–25 of ${SEEDED}`);
    // Page one has nowhere to go back to, and that step is not a link.
    await expect(page.getByTestId('secret-pagination-prev')).toHaveCount(0);
    await expect(page.getByTestId('secret-pagination-prev-disabled')).toBeVisible();

    await page.goto(listUrl('en', { page: 2 }));
    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 26–50 of ${SEEDED}`);
    await expect(page.getByTestId('secret-pagination-prev')).toBeVisible();
    await expect(page.getByTestId('secret-pagination-next')).toBeVisible();

    await page.goto(listUrl('en', { page: 3 }));
    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 51–60 of ${SEEDED}`);
    // The final page is short, and has no next step.
    await expect(page.locator('[data-testid^="secret-row-"]')).toHaveCount(SEEDED - 2 * PAGE_SIZE);
    await expect(page.getByTestId('secret-pagination-next')).toHaveCount(0);
    await expect(page.getByTestId('secret-pagination-next-disabled')).toBeVisible();
  });

  test('every seeded record is reachable by paging, exactly once', async ({ page }) => {
    await signIn(page, 'en');
    const seen: string[] = [];

    for (const pageNumber of [1, 2, 3]) {
      await page.goto(listUrl('en', { page: pageNumber }));
      const refs = await page
        .locator('[data-testid^="secret-row-"]')
        .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset['testid'] ?? ''));
      seen.push(...refs);
    }

    // No record skipped at a page boundary, none shown twice: the total order
    // the service sorts by is what makes this true.
    expect(seen).toHaveLength(SEEDED);
    expect(new Set(seen).size).toBe(SEEDED);
  });

  test('recovers from an out-of-range page instead of showing nothing', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en', { page: 999 }));

    // A stale bookmark lands on the last page, not on an error or a blank table.
    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 51–60 of ${SEEDED}`);
    await expect(page.locator('[data-testid^="secret-row-"]').first()).toBeVisible();
  });

  test('preserves its state across a reload and the back button', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en', { page: 1 }));
    await page.getByTestId('secret-pagination-next').click();

    await expect(page).toHaveURL(/[?&]page=2\b/);
    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 26–50 of ${SEEDED}`);

    await page.reload();
    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 26–50 of ${SEEDED}`);

    await page.goBack();
    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 1–25 of ${SEEDED}`);
  });

  test('searches on the server and resets to the first page', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en', { page: 3 }));
    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 51–60 of ${SEEDED}`);

    // A search narrows the TOTAL, not merely the rows on this page — which is
    // what proves the filter is applied by the database and not by the browser.
    await page.getByTestId('secret-search').fill(seededName(7));
    await page.getByTestId('secret-search-apply').click();

    await expect(page.getByTestId('secret-range')).toHaveText('Showing 1–1 of 1');
    await expect(page.locator('[data-testid^="secret-row-"]')).toHaveCount(1);
    // Submitting the filter form must not carry the old page number with it.
    await expect(page).not.toHaveURL(/[?&]page=3\b/);
  });

  test('says so plainly when a search matches nothing', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/secrets?q=${PROVIDER}-no-such-secret-anywhere`);

    await expect(page.getByTestId('secret-range')).toHaveText('Showing 0–0 of 0');
    await expect(page.getByTestId('empty-state')).toBeVisible();
    await expect(page.getByTestId('secret-pagination')).toHaveCount(0);
  });
});

test.describe('pagination is usable without a mouse and in both directions', () => {
  test('the next step is reachable and operable from the keyboard', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en', { page: 1 }));

    await page.getByTestId('secret-pagination-next').focus();
    await expect(page.getByTestId('secret-pagination-next')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 26–50 of ${SEEDED}`);

    // And back again, the same way.
    await page.getByTestId('secret-pagination-prev').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('secret-range')).toHaveText(`Showing 1–25 of ${SEEDED}`);
  });

  test('a step that leads nowhere is not in the tab order at all', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(listUrl('en', { page: 1 }));

    // The disabled step is a span, so it has no href to activate and cannot be
    // focused. `aria-disabled` on an anchor would still navigate on Enter.
    const disabled = page.getByTestId('secret-pagination-prev-disabled');
    await expect(disabled).toBeVisible();
    await expect(disabled).toHaveAttribute('aria-hidden', 'true');
    const focusable = await disabled.evaluate(
      (el) => el.tagName === 'A' || el.hasAttribute('tabindex'),
    );
    expect(focusable, 'a step leading nowhere must not be focusable').toBe(false);
  });

  for (const locale of ['ar', 'en'] as const) {
    test(`the paginated listing is accessible in ${locale}`, async ({ page }) => {
      await signIn(page, locale);
      await page.goto(listUrl(locale, { page: 2 }));

      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('secret-pagination')).toBeVisible();
      await expectNoBlockingA11yViolations(page, `${locale} secrets page 2`);
    });
  }

  test('the step chevrons point the right way in Arabic', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(listUrl('ar', { page: 2 }));

    // A chevron drawn pointing left is correct in English and backwards in
    // Arabic. The mirror is a stylesheet rule, so assert the COMPUTED
    // transform: a class present with no rule behind it would pass a source
    // check and still render the wrong way round.
    const flipped = await page
      .getByTestId('secret-pagination-prev')
      .locator('svg')
      .evaluate((el) => getComputedStyle(el).transform);
    expect(flipped, 'the previous chevron is not mirrored in Arabic').toBe(
      'matrix(-1, 0, 0, 1, 0, 0)',
    );

    await signIn(page, 'en');
    await page.goto(listUrl('en', { page: 2 }));
    const upright = await page
      .getByTestId('secret-pagination-prev')
      .locator('svg')
      .evaluate((el) => getComputedStyle(el).transform);
    expect(upright, 'the English chevron must not be mirrored').toBe('none');
  });

  test('the range reads in Arabic as well as English', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(listUrl('ar', { page: 2 }));

    // Translated, not an English string left in an RTL page.
    await expect(page.getByTestId('secret-range')).toHaveText(`عرض 26–50 من ${SEEDED}`);
    await expect(page.getByTestId('secret-pagination-next')).toBeVisible();
  });

  for (const locale of ['ar', 'en'] as const) {
    test(`the paginated listing fits a 390px screen in ${locale}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await signIn(page, locale);
      await page.goto(listUrl(locale, { page: 2 }));

      await expect(page.getByTestId('secret-pagination')).toBeVisible();
      await expectNoHorizontalOverflow(page, `${locale} secrets page 2 at 390px`);
    });
  }
});

test.describe('a page of secrets still reveals nothing', () => {
  test('sends no ciphertext, key material or internal metadata to the browser', async ({
    page,
  }) => {
    await signIn(page, 'en');
    const response = await page.goto(listUrl('en', { page: 2 }));
    const body = (await response!.text()).toLowerCase();

    // The listing is masked metadata. None of the envelope's parts belong in a
    // response, and a serialisation mistake would put them all there at once.
    for (const forbidden of [
      'ciphertext',
      'authtag',
      'wrappedkey',
      'noncebase',
      '"nonce"',
      'keyid',
    ]) {
      expect(body, `"${forbidden}" appears in the secrets listing response`).not.toContain(
        forbidden,
      );
    }
  });
});
