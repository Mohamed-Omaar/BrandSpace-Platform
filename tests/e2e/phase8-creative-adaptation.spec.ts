import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Request } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * THE FORMAT THE CUSTOMER CLICKED IS THE FORMAT THAT IS GENERATED (AC-28.2).
 *
 * THE DEFECT THIS EXISTS FOR. The adaptation buttons did
 * `setFormatKey(next); generate()` — and `generate` closed over the PREVIOUS
 * render's `formatKey`, because a React state update is asynchronous. Clicking
 * "Square → adapt to Story" therefore generated another SQUARE: silently, at
 * full price, and labelled as a story. Every existing assertion passed, because
 * a second image really was produced and really did land in the library.
 *
 * SO THE ASSERTION HAS TO BE ON THE WIRE. This reads the body the browser
 * actually posts to `/api/creative/generate` and requires the format in it to
 * be the one whose button was pressed. A test that only looked at the screen
 * could not tell the two apart until the server's answer came back — and the
 * server would faithfully report the square it was asked for.
 *
 * THE INVARIANT, ALL FOUR LINKS OF IT:
 *
 *     the format clicked
 *   = the format posted
 *   = the format returned
 *   = the format the result frame is drawn in
 *
 * ITS OWN FILE, and its own SERIAL project. It spends real credits from the
 * shared development grant and writes real assets into the shared workspace, so
 * it must not run beside itself; and keeping it out of the journey suite means
 * a failure here names the defect rather than being one red step in a
 * twenty-step flow.
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

async function enterStudio(page: Page): Promise<void> {
  const { customer } = credentials();
  const brands = brandFixtures(credentials());
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(/\/en\/overview$/);
  await useBrand(page, customer.workspaceId, brands.primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/en/creative`);
  await expect(page.getByTestId('creative-studio')).toBeVisible();
}

/** Every `formatKey` the page posts to the generate endpoint, in order. */
function recordPostedFormats(page: Page): string[] {
  const posted: string[] = [];
  page.on('request', (request: Request) => {
    if (!request.url().includes('/api/creative/generate')) return;
    if (request.method() !== 'POST') return;
    try {
      const body = JSON.parse(request.postData() ?? '{}') as { formatKey?: unknown };
      if (typeof body.formatKey === 'string') posted.push(body.formatKey);
    } catch {
      posted.push('<unparseable>');
    }
  });
  return posted;
}

/**
 * A BRIEF NOTHING HAS EVER BEEN GENERATED FROM.
 *
 * NOT COSMETIC. The development image adapter is DETERMINISTIC — the same
 * brief at the same size produces byte-identical output, which is what makes a
 * screenshot mean the same thing twice. The Asset Library refuses a file whose
 * checksum already exists, deliberately and correctly (a customer uploading the
 * same photo from two screens gets one asset, not two). Put together, re-running
 * this suite with a fixed brief generates the same bytes and is refused as a
 * duplicate — a collision between two behaviours that are each right.
 *
 * A REAL PROVIDER WOULD NOT COLLIDE, because it would not return the same
 * pixels twice. So the fixture varies the input the way reality does rather
 * than the product relaxing its dedupe for a mock's benefit.
 */
function freshBrief(): string {
  return `A warm shot of a flat white on a wooden counter. Run ${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Generate once, and say plainly what happened.
 *
 * NO SILENT SKIP. An earlier draft treated a refusal as "unavailable here" and
 * skipped — which meant a broken generation path read as a pass, and that is
 * exactly the shape of failure this correction pass exists to remove. If the
 * image cannot be generated the test fails and quotes the screen's own words.
 */
async function generateOnce(page: Page): Promise<void> {
  await page.getByTestId('creative-brief').fill(freshBrief());
  await page.getByTestId('creative-generate').click();

  await expect
    .poll(
      async () =>
        (await page.getByTestId('creative-result-frame').count()) > 0 ||
        (await page.getByTestId('creative-failure').count()) > 0,
      { timeout: 45_000 },
    )
    .toBe(true);

  /*
   * COUNT BEFORE TEXT, and the order is load-bearing. `locator.textContent()`
   * on an element that is not there does not return null — it WAITS for the
   * element, with no timeout of its own, so a `.catch(() => null)` never runs
   * and the test hangs until its own ceiling. Reading the count first asks a
   * question that always has an answer now.
   */
  const refused = (await page.getByTestId('creative-failure').count()) > 0;
  const failure = refused ? await page.getByTestId('creative-failure').textContent() : null;
  expect(refused, `the Creative Studio refused to generate: ${failure ?? ''}`).toBe(false);
  await expect(page.getByTestId('creative-result-frame')).toBeVisible();
}

/*
 * A LONGER CEILING THAN THE SUITE DEFAULT, and the reason is arithmetic rather
 * than flakiness. Each test generates at least one image and the adaptation
 * test generates two, one of them a 1080x1920 story frame — the development
 * encoder builds every pixel in TypeScript and deflates it at level 9 so the
 * bytes are identical on every machine. Two of those plus two sign-ins does not
 * fit in thirty seconds, and a ceiling that cannot fit the work measures the
 * ceiling.
 */
test.describe.configure({ timeout: 180_000 });

test.describe('adapting a generated image', () => {
  test('sends the format that was clicked, not the one that was selected', async ({ page }) => {
    const posted = recordPostedFormats(page);
    await enterStudio(page);

    // The dropdown starts on the first format, and the first generation is of
    // that format — which is exactly the state that made the bug invisible.
    const first = await page.getByTestId('creative-format').inputValue();
    await generateOnce(page);

    const frame = page.getByTestId('creative-result-frame');
    await expect(frame).toHaveAttribute('data-format', first);
    expect(posted).toEqual([first]);

    /*
     * NOW THE ADAPTATION. The button is offered only for a format the result
     * is NOT, so `story` here is necessarily different from `first`.
     */
    const target = 'story';
    expect(target).not.toBe(first);
    const adapt = page.getByTestId(`creative-adapt-${target}`);
    await expect(adapt).toBeVisible();
    await adapt.click();

    // THE ASSERTION THE OLD IMPLEMENTATION FAILS: the second request carried
    // `first` again, because `generate` had closed over it.
    await expect.poll(() => posted.length, { timeout: 45_000 }).toBe(2);
    expect(posted[1]).toBe(target);

    // And the whole chain agrees: what came back, and the frame it is drawn in.
    await expect(frame).toHaveAttribute('data-format', target, { timeout: 45_000 });
    await expect(frame).toHaveAttribute('data-aspect', '9:16');

    // The adaptation row now offers everything EXCEPT the story it just became,
    // which is the same fact stated from the other side.
    await expect(page.getByTestId(`creative-adapt-${target}`)).toHaveCount(0);
    await expect(page.getByTestId(`creative-adapt-${first}`)).toBeVisible();
  });

  test('the result frame follows the RESULT, not the dropdown', async ({ page }) => {
    await enterStudio(page);
    const first = await page.getByTestId('creative-format').inputValue();
    await generateOnce(page);

    const frame = page.getByTestId('creative-result-frame');
    await expect(frame).toHaveAttribute('data-format', first);

    /*
     * MOVE THE DROPDOWN WITHOUT GENERATING. The picture on screen has not
     * changed, so its frame must not either — re-cropping a finished image into
     * a shape it is not is a lie about what was produced.
     */
    await page.getByTestId('creative-format').selectOption('landscape');
    await expect(page.getByTestId('creative-format')).toHaveValue('landscape');
    await expect(frame).toHaveAttribute('data-format', first);
  });
});
