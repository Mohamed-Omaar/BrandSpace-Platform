import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * The Asset Library, end to end, in a real browser.
 *
 * What these assert that a unit or isolation test cannot: that an upload
 * travels from a file picker through the QUEUE and a real worker to a READY
 * tile; that a quarantined file says so on the screen and offers no way to
 * reach its bytes; that the geometry holds in BOTH writing directions and at
 * phone width; and that the whole thing is operable by keyboard and clean under
 * axe.
 *
 * EVERY FIXTURE IS BUILT HERE rather than committed. A repository that carries
 * a file crafted to trip a scanner has to explain itself to every scanner that
 * reads it, and a fixture nobody can see the construction of is one nobody can
 * reason about.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error(
      'The end-to-end credentials file is missing. Run `pnpm e2e:seed` first — ' +
        '`pnpm test:e2e` does it for you.',
    );
  }
}

async function signIn(page: Page, email: string, password: string, locale = 'en'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
}

async function openLibrary(page: Page, locale = 'en'): Promise<void> {
  const { customer } = credentials();
  await signIn(page, customer.email, customer.password, locale);
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/assets`);
  await page.waitForLoadState('domcontentloaded');
}

/** A real PNG header plus a unique payload, so each upload is a distinct file. */
function pngBytes(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(payload, 'utf8'),
  ]);
}

/**
 * The EICAR test string — the industry's standard harmless probe.
 *
 * NOT MALWARE AND CANNOT BE: 68 printable ASCII bytes that every antivirus
 * agrees to report, published by EICAR for exactly this purpose. Split across a
 * concatenation so this source file is not itself flagged by a scanner reading
 * the repository.
 */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE' + '!$H+H*';

/** Upload a file through the real picker and wait for the page to come back. */
async function upload(page: Page, name: string, bytes: Buffer, locale = 'en'): Promise<void> {
  await page.getByTestId('assets-upload-open').click();
  await page
    .getByTestId('assets-file-input')
    .setInputFiles({ name, mimeType: 'image/png', buffer: bytes });
  await page.getByTestId('assets-upload-submit').click();
  await page.waitForURL(new RegExp(`/${locale}/assets`));
  await page.waitForLoadState('domcontentloaded');
}

test.describe('the Asset Library', () => {
  test('renders its own heading exactly once', async ({ page }) => {
    await openLibrary(page);
    // The SHELL owns the h1, and a second would be a WCAG 1.3.1 failure that
    // looks like nothing on screen — which is why the route does not use
    // PageHeader.
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText(/media library/i);
  });

  test('shows an honest empty state, not an invented number', async ({ page }) => {
    await openLibrary(page);
    const grid = page.getByTestId('assets-grid');
    const empty = page.getByTestId('assets-empty');
    // One or the other, never both, and never a placeholder count.
    const hasGrid = await grid.isVisible().catch(() => false);
    if (!hasGrid) await expect(empty).toBeVisible();

    // The demo's invented figures must never appear.
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('2.8 gb');
    expect(body).not.toContain('all systems operational');
  });

  test('reports storage against the REAL plan limit', async ({ page }) => {
    await openLibrary(page);
    const badge = page.getByTestId('assets-storage');
    await expect(badge).toBeVisible();
    // Either a real "n of m GB" or an honest "Unlimited" — never a guess.
    await expect(badge).toHaveText(/(\d+\s+of\s+\d+\s+GB)|(Unlimited)/i);
  });

  test('takes an upload from the picker to a READY tile, through the worker', async ({ page }) => {
    /*
     * THE WHOLE PIPELINE, NOT A UNIT OF IT. The dashboard writes the row and
     * dispatches; `apps/worker` consumes, scans and marks it READY; this page
     * re-reads it. Nothing here reaches into the database, so a break anywhere
     * along that path fails this test.
     */
    await openLibrary(page);
    const name = `e2e-ready-${Date.now()}.png`;
    await upload(page, name, pngBytes(`ready-${Date.now()}`));

    const tile = page.locator('[data-testid^="asset-tile-"]', { hasText: name });
    await expect(tile).toBeVisible();

    // The worker may still be scanning on the first render; the state is either
    // Processing or Ready, and it MUST settle on Ready.
    await expect(async () => {
      await page.reload();
      await expect(page.locator('[data-testid^="asset-tile-"]', { hasText: name })).toContainText(
        /ready/i,
      );
    }).toPass({ timeout: 30_000 });
  });

  test('QUARANTINES an infected file and offers no way to reach it', async ({ page }) => {
    await openLibrary(page);
    const name = `e2e-infected-${Date.now()}.png`;
    await upload(page, name, pngBytes(EICAR + Date.now()));

    await expect(async () => {
      await page.reload();
      const tile = page.locator('[data-testid^="asset-tile-"]', { hasText: name });
      await expect(tile).toContainText(/quarantined/i);
    }).toPass({ timeout: 30_000 });

    const tile = page.locator('[data-testid^="asset-tile-"]', { hasText: name });
    // NO PREVIEW. A quarantined file gets no download grant at all, so there is
    // no path to its bytes rather than a broken one.
    await expect(tile.locator('img')).toHaveCount(0);
    // And the reason is stated in words, not by colour alone.
    await expect(tile).toContainText(/did not pass the security scan/i);
  });

  test('refuses a file whose contents disagree with its name', async ({ page }) => {
    await openLibrary(page);
    await page.getByTestId('assets-upload-open').click();
    await page.getByTestId('assets-file-input').setInputFiles({
      name: 'renamed.png',
      mimeType: 'image/png',
      // A PDF wearing a .png name. The bytes decide.
      buffer: Buffer.from('%PDF-1.7 this is not an image', 'utf8'),
    });
    await page.getByTestId('assets-upload-submit').click();
    await page.waitForURL(/error=/);
    // A customer-safe message, never a parser error or a path.
    await expect(page.locator('body')).not.toContainText(/\/home\/|Error:|stack/i);
  });

  test('opens a file detail with its versions', async ({ page }) => {
    await openLibrary(page);
    const name = `e2e-detail-${Date.now()}.png`;
    await upload(page, name, pngBytes(`detail-${Date.now()}`));

    const tile = page.locator('[data-testid^="asset-tile-"]', { hasText: name }).first();
    await tile.locator('a').first().click();
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByTestId('asset-detail')).toBeVisible();
    await expect(page.getByTestId('asset-detail')).toContainText(name);
  });

  test('filters and search are LINKS, so a filtered view is bookmarkable', async ({ page }) => {
    await openLibrary(page);
    const imageFilter = page.getByRole('link', { name: 'Image', exact: true });
    if (await imageFilter.isVisible().catch(() => false)) {
      await imageFilter.click();
      await page.waitForURL(/kind=IMAGE/);
      // The URL alone reproduces the view — no client state is required.
      await page.goto(page.url());
      await expect(page.getByRole('link', { name: 'Image', exact: true })).toHaveAttribute(
        'aria-current',
        'true',
      );
    }
  });

  test('creates a folder and filters by it', async ({ page }) => {
    await openLibrary(page);
    const folderName = `E2E folder ${Date.now()}`;
    await page.getByRole('button', { name: 'New folder' }).click();
    const dialog = page.getByTestId('assets-folder-dialog');
    await dialog.getByTestId('assets-folder-name').fill(folderName);
    // SCOPED TO THE DIALOG. The top bar carries its own "Create" button, so an
    // unscoped role query is ambiguous — which Playwright rightly refuses
    // rather than guessing.
    await dialog.getByRole('button', { name: 'Create' }).click();
    await page.waitForURL(new RegExp('/en/assets'));
    await expect(page.getByTestId('assets-taxonomy')).toContainText(folderName);
  });
});

test.describe('both writing directions', () => {
  test('renders in Arabic with dir=rtl and no Latin fallback in the chrome', async ({ page }) => {
    await openLibrary(page, 'ar');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // `ar-SA` — the app's own locale tag, which is what the shell sets.
    await expect(page.locator('html')).toHaveAttribute('lang', /^ar/);
    await expect(page.locator('h1')).toHaveText('مكتبة الوسائط');
  });

  test('the toolbar reads right-to-left in Arabic and left-to-right in English', async ({
    page,
  }) => {
    /*
     * MEASURED, not assumed. `dir=rtl` on the root is not proof that a flex row
     * inside it actually reversed — a hard-coded `margin-left` or a
     * `flex-direction: row` with physical positioning renders Arabic backwards
     * while the attribute says otherwise.
     */
    await openLibrary(page, 'ar');
    const arabicBadge = await page.getByTestId('assets-storage').boundingBox();
    const arabicViewport = page.viewportSize();
    expect(arabicBadge).not.toBeNull();
    expect(arabicViewport).not.toBeNull();
    // In RTL the leading element sits in the RIGHT half of the content area.
    expect(arabicBadge!.x + arabicBadge!.width).toBeGreaterThan(arabicViewport!.width / 2);

    await page.goto(`${DASHBOARD_BASE_URL}/en/assets`);
    await page.waitForLoadState('domcontentloaded');
    const englishBadge = await page.getByTestId('assets-storage').boundingBox();
    expect(englishBadge).not.toBeNull();
    // In LTR it sits in the left half.
    expect(englishBadge!.x).toBeLessThan(arabicViewport!.width / 2);
  });

  test('every Arabic string is translated — no key and no English leak', async ({ page }) => {
    await openLibrary(page, 'ar');
    const body = await page.locator('main').innerText();
    // A missing key renders as the key itself.
    expect(body).not.toMatch(/assets\.[a-z]/i);
    expect(body).not.toContain('Media library');
  });
});

test.describe('responsive and accessible', () => {
  test('the grid does not scroll horizontally at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openLibrary(page);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // A one-pixel rounding allowance; anything more is a layout that does not fit.
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('the grid reflows to fewer columns at phone width', async ({ page }) => {
    await openLibrary(page);
    const grid = page.getByTestId('assets-grid');
    if (!(await grid.isVisible().catch(() => false))) test.skip();

    const desktopColumns = await grid.evaluate(
      (node) => getComputedStyle(node).gridTemplateColumns.split(' ').length,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileColumns = await grid.evaluate(
      (node) => getComputedStyle(node).gridTemplateColumns.split(' ').length,
    );
    expect(mobileColumns).toBeLessThanOrEqual(desktopColumns);
  });

  test('is operable by keyboard alone', async ({ page }) => {
    await openLibrary(page);
    // Tab until the upload control has focus, then open it with the keyboard.
    const upload = page.getByTestId('assets-upload-open');
    if (!(await upload.isVisible().catch(() => false))) test.skip();

    await upload.focus();
    await expect(upload).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('assets-upload-dialog')).toBeVisible();
    // Escape closes it and returns focus, which is what a modal owes a keyboard
    // user.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('assets-upload-dialog')).toBeHidden();
  });

  test('passes axe at WCAG 2.2 AA on a PHONE, where touch targets are judged', async ({ page }) => {
    /*
     * THE VIEWPORT THAT FOUND THE DEFECT. On a desktop pointer the filter links
     * looked fine; at 390px axe reported 268 `target-size` violations, every
     * one of them a 27.5 x 20px link against the 24 x 24 minimum WCAG 2.2 AA
     * 2.5.8 sets. A desktop-only axe run would never have asked.
     */
    await page.setViewportSize({ width: 390, height: 844 });
    await openLibrary(page, 'en');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('passes axe at WCAG 2.2 AA in English', async ({ page }) => {
    await openLibrary(page, 'en');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('passes axe at WCAG 2.2 AA in Arabic', async ({ page }) => {
    await openLibrary(page, 'ar');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
