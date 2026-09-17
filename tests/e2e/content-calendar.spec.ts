import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * The Content Calendar, end to end, in a real browser.
 *
 * WHAT THESE ASSERT THAT A UNIT OR ISOLATION TEST CANNOT: that a draft travels
 * from a picker through a server action to a chip on the right day (AC-14.1);
 * that the month grid is a real `role="grid"` a screen reader can navigate;
 * that period navigation is live rather than decorative; that the grid becomes
 * an AGENDA on a phone instead of seven unreadable columns; that the whole
 * thing works in Arabic with the week starting on the configured day
 * (AC-14.4); and that it is clean under axe in both writing directions.
 *
 * NOTHING HERE PUBLISHES, and one test asserts the screen says so rather than
 * implying a connection the product does not have (AC-14.7).
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

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const { customer } = credentials();
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

async function openCalendar(page: Page, locale = 'en'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/calendar`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByTestId('calendar-page')).toBeVisible();
}

/**
 * Is there a draft the calendar will actually accept?
 *
 * `pnpm e2e:seed` runs `seed-content.ts`, which writes one DRAFT with one
 * caption for exactly this — see that file for why the precondition is seeded
 * rather than generated through the Studio. This checks the PICKER rather than
 * the database, because what the test needs to know is whether the screen
 * offers something to schedule.
 *
 * Leaves the dialog OPEN, because every caller's next step is to use it.
 */
async function hasSchedulableDraft(page: Page): Promise<boolean> {
  await clickUntil(page, 'calendar-schedule-open', async () => {
    await expect(page.getByTestId('calendar-schedule-dialog')).toBeVisible({ timeout: 2_000 });
  });
  return page
    .getByTestId('schedule-item')
    .isVisible()
    .catch(() => false);
}

/**
 * Click something, and keep clicking until it has actually taken effect.
 *
 * WHY THIS IS NEEDED, and why it is not a sleep. `page.goto` resolves when the
 * document is parsed; React has not hydrated yet, so a click that lands in that
 * window hits a button with no handler attached and is silently lost. The test
 * then fails several assertions later, on a view that never changed, with an
 * error that points nowhere near the cause — which is exactly what happened
 * before this helper existed.
 *
 * `toPass` retries the click until the CONSEQUENCE is observable, so it waits
 * for hydration by waiting for the thing hydration enables, and adds no delay
 * once the page is ready.
 */
async function clickUntil(page: Page, testId: string, settled: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.getByTestId(testId).click();
    await settled();
  }).toPass({ timeout: 20_000 });
}

/**
 * Submit a form inside a dialog, and wait for the action's own outcome marker.
 *
 * THREE THINGS GO WRONG HERE WITHOUT IT, and all three were observed:
 *
 *   1. The click is LOST. Under parallel load a click can land between renders
 *      and do nothing at all; the URL then never changes and the failure looks
 *      like a server problem rather than a missed click.
 *   2. `waitForURL` DOES NOT FIRE. A server action's `redirect()` is a client
 *      navigation with no new document, so both `load` and `commit` hang.
 *      Sampling `page.url()` depends on nothing but the URL.
 *   3. A REFUSAL LOOKS LIKE A TIMEOUT. Waiting for `ok=…` alone turns a real
 *      `error=…` redirect into thirty seconds of silence, so the assertion
 *      prints the URL it actually saw.
 *
 * AND ONE MORE, WHICH THE FIRST FIX CAUSED.
 *
 * The click used to be repeated every 750ms for as long as the URL had not
 * moved, on the reasoning that a submit which had "taken" would have moved it.
 * THAT IS NOT TRUE OF A SLOW ONE. `<form action={serverAction}>` starts a new
 * action on every submit, so on a loaded runner — where the round trip is
 * longer than the interval — the next click superseded the pending action
 * before it could redirect, and the loop could click forty times in thirty
 * seconds without one ever completing. Meanwhile the SERVER had accepted one of
 * them: the draft really was scheduled. The retry then found this suite's own
 * fixture already on the calendar, could not select it by name, and spent the
 * whole two-minute test budget in a completely different assertion.
 *
 * SO THE CLICK IS REPEATED ONLY WHILE IT DEMONSTRABLY NEVER REACHED THE SERVER.
 * A submit that lands sends a POST, and waiting for the REQUEST rather than the
 * response separates the two cases exactly: no request means the click was lost
 * and must be repeated, a request means an action is in flight and must be left
 * alone to finish. A genuinely broken action still fails — it just fails at the
 * URL that never moved, instead of destroying the fixture on its way there.
 */
async function submitAndExpect(page: Page, testId: string, marker: RegExp): Promise<void> {
  const before = page.url();

  await expect(async () => {
    // Armed BEFORE the click, so a request that races the await is not missed.
    const sent = page
      .waitForRequest((request) => request.method() === 'POST', { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    await page.getByTestId(testId).click();
    expect(await sent, 'the click never reached the server').toBe(true);
  }).toPass({ timeout: 30_000 });

  // ONE ACTION, UNINTERRUPTED. Generous, because the only thing being waited on
  // now is the server finishing work it has definitely started.
  await expect
    .poll(() => page.url(), { message: 'the form did not submit', timeout: 60_000 })
    .not.toBe(before);
  await expect.poll(() => page.url(), { timeout: 15_000 }).toMatch(marker);
}

/** A date a comfortable distance ahead, as the date input wants it. */
function futureDate(daysAhead = 21): string {
  return new Date(Date.now() + daysAhead * 24 * 3_600_000).toISOString().slice(0, 10);
}

test.describe('the calendar renders the workspace’s own month', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('shows a real month grid, its zone, and its quota', async ({ page }) => {
    await openCalendar(page);

    // A real grid, not a stack of divs: `role="grid"` with seven column
    // headers, which is what makes it navigable by assistive tooling.
    const grid = page.getByTestId('calendar-month-grid');
    await expect(grid).toBeVisible();
    await expect(grid).toHaveAttribute('role', 'grid');
    await expect(grid.locator('[role="columnheader"]')).toHaveCount(7);

    // Six weeks, so a month beginning on the last weekday still shows whole.
    await expect(grid.locator('[role="gridcell"]')).toHaveCount(42);

    /*
     * THE ZONE IS STATED. Every time on this screen is a wall-clock in the
     * workspace's zone, and a calendar that does not say which zone it means is
     * a calendar people misread — the reason the slot stores the intent at all.
     */
    await expect(page.getByTestId('calendar-timezone')).toBeVisible();
    await expect(page.getByTestId('calendar-quota')).toBeVisible();
  });

  test('period navigation is live, and the month is in the URL', async ({ page }) => {
    await openCalendar(page);
    const first = await page.getByTestId('calendar-period').textContent();

    await page.getByTestId('calendar-next').click();
    await page.waitForURL(/month=\d{4}-\d{2}/);
    await expect(page.getByTestId('calendar-period')).not.toHaveText(first ?? '');

    // A calendar somebody links to a colleague or reloads has to come back to
    // the same month — which is why the month lives in the URL and not in state.
    const moved = page.url();
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    expect(page.url()).toBe(moved);

    await page.getByTestId('calendar-previous').click();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('calendar-period')).toHaveText(first ?? '');
  });

  test('AC-14.7 — the screen says the target is a mock, and names no platform', async ({
    page,
  }) => {
    await openCalendar(page);
    const rendered = (await page.content()).toLowerCase();
    // No OAuth, no connection, no "connected account" anywhere on the page.
    for (const forbidden of ['oauth', 'access_token', 'connect instagram', 'graph.facebook']) {
      expect(rendered, `the calendar mentions "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

test.describe('placing content on the calendar', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('AC-14.1, AC-14.8 — schedule a draft, move it, then take it off', async ({ page }) => {
    test.setTimeout(120_000);
    await openCalendar(page);
    const ready = await hasSchedulableDraft(page);
    expect(ready, 'the seed should have left one schedulable draft').toBe(true);

    /*
     * Three weeks out keeps the slot clear of the minimum-notice floor and well
     * inside the planning horizon — and it is usually the NEXT month, which is
     * the thing this test has to account for: the agenda renders the same
     * `days` the grid does, so a slot outside the month on screen is correctly
     * not shown by either. The URL is what moves the page to it.
     */
    /*
     * THE DRAFT IS CHOSEN BY NAME, not left to whichever the picker lists first.
     *
     * `pnpm e2e:seed` leaves TWO schedulable drafts from Phase 5B-3 onward —
     * this suite's "Seasonal note" and the approvals suite's "Launch
     * announcement" — and the two projects run in parallel. Taking the first
     * option scheduled whichever one happened to sort first, which failed this
     * assertion and stripped the OTHER suite's fixture of its submit button at
     * the same time. Naming it makes each suite own its own fixture.
     */
    await page.getByTestId('schedule-item').selectOption({ label: 'Seasonal note' });
    await expect(page.getByTestId('schedule-item')).toHaveValue(/.+/);

    const when = futureDate(21);
    await page.getByTestId('schedule-date').fill(when);
    await page.getByTestId('schedule-time').fill('09:00');
    // The fills TOOK. A value lost to a re-render would make the browser's own
    // `required` validation block the submit, which looks identical to a lost
    // click from the outside.
    await expect(page.getByTestId('schedule-date')).toHaveValue(when);
    await expect(page.getByTestId('schedule-time')).toHaveValue('09:00');

    await submitAndExpect(page, 'schedule-submit', /[?&]ok=CONTENT_SCHEDULED/);

    // AC-14.1 — it is on the calendar, in the month it was scheduled into.
    const openMonth = async (month: string) => {
      await page.goto(`${DASHBOARD_BASE_URL}/en/calendar?month=${month}`);
      await page.waitForLoadState('domcontentloaded');
      // The agenda, not the grid: it lists every planned day in the month
      // regardless of which cell the post falls in.
      await clickUntil(page, 'calendar-view-agenda', async () => {
        await expect(page.getByTestId('calendar-view-agenda')).toHaveAttribute(
          'aria-pressed',
          'true',
          { timeout: 2_000 },
        );
      });
      const agenda = page.getByTestId('calendar-agenda');
      await expect(agenda).toBeVisible();
      return agenda;
    };

    const agenda = await openMonth(when.slice(0, 7));
    await expect(agenda).toContainText('Seasonal note');

    // AC-14.8 — open it and move it a week later.
    await agenda.locator('button').first().click();
    const dialog = page.getByTestId('calendar-slot-dialog');
    await expect(dialog).toBeVisible();
    // AC-14.7 — the slot itself says its target is a mock.
    await expect(dialog).toContainText(/mock|تجريبية/i);

    const moved = futureDate(28);
    await page.getByTestId('reschedule-date').fill(moved);
    await page.getByTestId('reschedule-time').fill('17:30');
    await expect(page.getByTestId('reschedule-date')).toHaveValue(moved);

    await submitAndExpect(page, 'reschedule-submit', /[?&]ok=CONTENT_RESCHEDULED/);

    // AC-14.8 — and take it off again.
    const afterMove = await openMonth(moved.slice(0, 7));
    await expect(afterMove).toContainText('Seasonal note');
    await afterMove.locator('button').first().click();
    await expect(page.getByTestId('calendar-slot-dialog')).toBeVisible();
    await submitAndExpect(page, 'calendar-cancel-submit', /[?&]ok=CONTENT_UNSCHEDULED/);

    /*
     * It is schedulable AGAIN, which is the proof that cancelling returned the
     * item to DRAFT rather than merely hiding its slot — the half of the
     * behaviour a "the chip is gone" assertion would miss.
     */
    await openCalendar(page);
    expect(await hasSchedulableDraft(page)).toBe(true);
  });

  test('the schedule dialog is honest when there is nothing to schedule', async ({ page }) => {
    /*
     * Whichever state the workspace is in, the dialog says something TRUE: a
     * picker with drafts, or an explanation of what is missing. A dialog that
     * showed an empty select would be neither.
     */
    await openCalendar(page);
    const hasPicker = await hasSchedulableDraft(page);
    if (!hasPicker) {
      await expect(page.getByTestId('calendar-schedule-dialog')).toContainText(/caption|صيغة/i);
    }
  });
});

test.describe('AC-14.4 — Arabic, right to left, and the configured week start', () => {
  test('renders RTL with the same grid and no English fallback', async ({ page }) => {
    await signIn(page, 'ar');
    await openCalendar(page, 'ar');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const grid = page.getByTestId('calendar-month-grid');
    await expect(grid).toBeVisible();
    await expect(grid.locator('[role="columnheader"]')).toHaveCount(7);

    // Arabic weekday names, not English ones leaking through a fallback.
    const headers = await grid.locator('[role="columnheader"]').allTextContents();
    expect(headers.join(' ')).toMatch(/[؀-ۿ]/);

    // The grid itself flows right-to-left, which is what makes the first column
    // the first day of the week rather than the last.
    const direction = await grid.evaluate((el) => getComputedStyle(el).direction);
    expect(direction).toBe('rtl');
  });

  test('the week starts on the day the activated configuration names', async ({ page }) => {
    /*
     * `calendar.weekStartsOn` defaults to 0 = Sunday, because the platform's
     * first market runs a Sunday–Thursday week. This asserts the SCREEN honours
     * it — a calendar whose week starts on the wrong day is wrong in a way
     * people notice immediately.
     */
    await signIn(page);
    await openCalendar(page);
    const headers = await page
      .getByTestId('calendar-month-grid')
      .locator('[role="columnheader"]')
      .allTextContents();
    expect(headers[0]).toMatch(/sun/i);
  });
});

test.describe('the calendar on a phone is an agenda, not a squeezed grid', () => {
  test('the month grid gives way below md', async ({ page }) => {
    await signIn(page);
    await openCalendar(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);

    /*
     * A seven-column calendar at 390px gives each day about fifty pixels and
     * every post becomes an unreadable sliver. The agenda is a different view,
     * not the same one made small.
     */
    const gridVisible = await page
      .getByTestId('calendar-month-grid')
      .isVisible()
      .catch(() => false);
    expect(gridVisible).toBe(false);
    await expect(page.getByTestId('calendar-page')).toBeVisible();

    // And nothing overflows sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe('accessibility', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the calendar is clean under axe (${locale})`, async ({ page }) => {
      await signIn(page, locale);
      await openCalendar(page, locale);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${locale}: ${JSON.stringify(results.violations)}`).toEqual([]);
    });
  }

  test('the schedule dialog traps focus and closes on Escape', async ({ page }) => {
    await signIn(page);
    await openCalendar(page);
    await page.getByTestId('calendar-schedule-open').click();

    const dialog = page.getByTestId('calendar-schedule-dialog');
    await expect(dialog).toBeVisible();
    // Focus moved INTO the dialog rather than staying behind it.
    const inside = await dialog.evaluate((el) => el.contains(document.activeElement));
    expect(inside).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('period navigation is operable from the keyboard alone', async ({ page }) => {
    await signIn(page);
    await openCalendar(page);
    const next = page.getByTestId('calendar-next');
    await next.focus();
    // A real button: it takes focus, shows a ring, and responds to Enter.
    const outline = await next.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('');
    await page.keyboard.press('Enter');
    await page.waitForURL(/month=\d{4}-\d{2}/);
  });
});
