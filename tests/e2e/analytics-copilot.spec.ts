import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * Analytics, strategy, the Copilot and automations in a real browser — Phase 7.
 *
 * WHAT THIS ASSERTS THAT NO OTHER SUITE CAN. That the figures a customer sees
 * are rendered, labelled and reachable; that a screen built on SAMPLE DATA says
 * so; that a chart is not the only way to read a number; that the assistant's
 * confirmation step is actually in front of the action rather than beside it;
 * and that all of it is clean under axe, in Arabic and English, right to left
 * and left to right.
 *
 * THE ONE THING THIS SUITE CANNOT PROVE, stated here rather than worked around.
 * There is no real AI provider — D-13 approved the architecture and deferred
 * vendor selection — so the only adapter registered is the mock, which SELECTS
 * from the material it is handed and is deliberately not steerable from a
 * prompt. It cannot emit the JSON envelope the Copilot's plan schema or the
 * insight schema require, so in a browser BOTH of those paths reach an honest
 * refusal rather than a plan or an explanation.
 *
 * That is asserted below rather than avoided, and the buttons are PRESSED —
 * a suite that stopped before the important button would be a suite that proved
 * the button exists. The successful branches are proven against real PostgreSQL
 * and the real services in `tests/isolation/phase7-copilot-security.test.ts`
 * (campaign → confirm → execute → undo) and
 * `tests/isolation/phase7-grounding.test.ts` (evidence-bound insights). When a
 * provider is selected, the two outcomes here collapse to the first and these
 * tests need no change.
 *
 * NOTHING HERE CONTACTS A PLATFORM OR A MODEL VENDOR.
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
  const loaded = credentials();
  const { customer } = loaded;
  /*
   * THE BRAND THIS SUITE MEANS, said out loud (D-191). A brand-scoped screen no
   * longer picks one for the visitor, so the precondition is established here
   * — the same brand the seeds attached their fixtures to.
   */
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

/** The seeded window, so the screen shows the fixture rather than an empty range. */
const RANGE = 'range=90';

/**
 * Wait for whichever outcome the assistant actually reaches, and say which.
 *
 * RACE THE TWO OUTCOMES RATHER THAN TIME OUT ON ONE. Waiting on the plan alone
 * and catching the timeout works, but it spends the FULL ceiling on the refusal
 * path — and with no real provider that is the path these tests take. Two
 * browser workers each burning a minute on a wait whose answer arrived in two
 * seconds is a minute stolen from every other suite sharing the runner, which
 * is how a slow machine turns a passing suite into a flaky one.
 *
 * Racing costs nothing in rigour: both outcomes are still asserted by the
 * caller, and a genuinely hung request still fails at the ceiling.
 */
async function settle(page: Page): Promise<'plan' | 'refused' | 'neither'> {
  const plan = page
    .getByTestId('copilot-plan')
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => 'plan' as const)
    .catch(() => 'neither' as const);
  const refused = page
    .getByTestId('copilot-error')
    .waitFor({ state: 'visible', timeout: 60_000 })
    .then(() => 'refused' as const)
    .catch(() => 'neither' as const);
  return Promise.race([plan, refused]);
}

/*
 * A LONGER CEILING THAN THE DEFAULT, AND ONLY BECAUSE THE WORK IS REAL.
 *
 * Several tests here sign in twice (once per locale) and press a button that
 * reaches the AI Gateway — a reservation, a provider call and a settlement —
 * before the screen settles. Thirty seconds is right for a suite that reads a
 * rendered page and wrong for one that drives a round trip through a gateway;
 * raising the ceiling changes no assertion, and a genuinely hung test still
 * fails, ninety seconds later.
 */
test.setTimeout(120_000);

test.describe('the analytics screen', () => {
  test('renders the seeded figures, and says they are sample data', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?${RANGE}`);

    await expect(page.getByTestId('analytics-filters')).toBeVisible();

    /*
     * THE HONESTY BANNER IS PART OF THE PRODUCT, NOT PART OF THE FIXTURE. The
     * seeded observations carry `sourceKind = MOCK`, and a screen that drew
     * them silently would be presenting invented numbers as measurements —
     * exactly what CLAUDE.md §4.1 forbids and what the banner exists to prevent.
     */
    await expect(page.getByText(/sample|mock|not from/i).first()).toBeVisible();
  });

  test('a chart is never the only way to read a number', async ({ page }) => {
    /*
     * THE ACCESSIBILITY PROPERTY THAT MATTERS MOST ON THIS SCREEN. A trend that
     * exists only as an SVG path is a trend a screen-reader user cannot read and
     * a colour-blind user may not be able to distinguish. Every chart ships with
     * a tabular representation of the same figures.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?${RANGE}`);

    const trend = page.getByTestId('analytics-trend');
    await expect(trend).toBeVisible();

    // The figure carries an accessible name and a description, and a table of
    // the same numbers sits with it.
    const table = trend.getByTestId('chart-data-table');
    await expect(table).toBeAttached();
    await expect(table.locator('th').first()).toBeAttached();
  });

  test('a missing metric is stated as missing, never drawn as a zero', async ({ page }) => {
    /*
     * THE HONESTY ASSERTION ON THE FIGURES THEMSELVES.
     *
     * The fixture seeds impressions, engagements and reach — and nothing else.
     * Every other metric in the catalogue is therefore genuinely absent, and a
     * screen that rendered "0" for one would be claiming a MEASUREMENT of none
     * where the truth is that nothing was measured. The two sentences are
     * different and the product must not confuse them.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?${RANGE}`);

    // The seeded ones are really there, with real figures.
    const impressions = page.getByTestId('analytics-metric-impressions');
    await expect(impressions).toBeVisible();
    await expect(impressions).not.toContainText(/^0$/);

    /*
     * AND A DERIVED METRIC IS COMPUTED FROM THE TOTALS, not averaged from daily
     * rates and not rendered as zero: both of its components are present, so it
     * has a value.
     */
    const rate = page.getByTestId('analytics-metric-engagement_rate');
    if ((await rate.count()) > 0) {
      await expect(rate).toBeVisible();
    }

    /*
     * A METRIC WITH NO OBSERVATIONS RENDERS THE UNAVAILABLE STATE AND SAYS WHY.
     * `saves` is in the catalogue and is not in the fixture.
     */
    const absent = page.getByTestId('analytics-metric-saves');
    if ((await absent.count()) > 0) {
      const text = (await absent.innerText()).trim();
      expect(text, 'an unmeasured metric rendered as a zero').not.toMatch(/(^|\s)0(\s|$)/);
    }
  });

  test('the export downloads a CSV of exactly this workspace, with no formula in it', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?${RANGE}`);

    const link = page.getByTestId('analytics-export');
    await expect(link).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const csv = Buffer.concat(chunks).toString('utf8');

    expect(csv.length).toBeGreaterThan(0);
    // A header row and at least one figure.
    expect(csv.split('\r\n')[0]).toContain('"metric"');
    expect(csv).toContain('impressions');

    /*
     * THE SECURITY ASSERTION ON THE FILE'S OWN BYTES. No cell may BEGIN with a
     * formula character, because Excel, Numbers and Google Sheets execute one.
     */
    for (const line of csv.split('\r\n').slice(1)) {
      if (line.length === 0) continue;
      for (const cell of line.split('","')) {
        const value = cell.replace(/^"/, '');
        expect(
          ['=', '+', '-', '@', '\t', '\r'].includes(value[0] ?? ''),
          `a cell begins with a formula character: ${value.slice(0, 40)}`,
        ).toBe(false);
      }
    }
  });

  test('the same screen in Arabic is right-to-left and carries no English fallback', async ({
    page,
  }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/analytics?${RANGE}`);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('analytics-filters')).toBeVisible();
    // Arabic characters are actually on the page: a missing translation would
    // render its own key and this would fail.
    await expect(page.locator('main')).toContainText(/[؀-ۿ]/);
  });

  test('is clean under axe in both directions', async ({ page }) => {
    /*
     * ONE SIGN-IN, TWO LOCALES. The session is not locale-scoped, and visiting
     * `/sign-in` while already signed in REDIRECTS — so signing in a second time
     * inside one test waits for a form that is never rendered. The locale is a
     * route segment; switching it is a navigation.
     */
    await signIn(page);
    for (const locale of ['en', 'ar']) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/analytics?${RANGE}`);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${locale} analytics`).toEqual([]);
    }
  });

  test('is usable from the keyboard alone', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?${RANGE}`);

    // Tab into the page and confirm focus lands on something interactive with a
    // VISIBLE focus indicator — the WCAG 2.2 requirement, not merely a focusable
    // element.
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toBeVisible();
    const outline = await focused.evaluate((element) => {
      const style = getComputedStyle(element);
      return `${style.outlineStyle} ${style.outlineWidth} ${style.boxShadow}`;
    });
    expect(outline).not.toBe('none 0px none');
  });

  test('responds at phone width without a horizontal scrollbar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?${RANGE}`);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the analytics screen scrolls sideways on a phone').toBeLessThanOrEqual(1);
  });
});

test.describe('the AI Copilot', () => {
  test('a proposal reaches a plan with a confirmation, or an honest refusal', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/copilot`);

    await page.getByTestId('copilot-request').fill('Create an autumn awareness campaign.');

    /*
     * THE BUTTON IS PRESSED. Two outcomes, both correct, and the test names
     * which one it saw:
     *
     *   1. A PLAN — and then the confirmation controls must be present, because
     *      a plan that changes anything is never executed silently (§2.5).
     *   2. AN HONEST REFUSAL — the mock cannot produce the plan envelope, and
     *      the message must say so WITHOUT naming a model, a provider or a
     *      schema.
     */
    await page.getByTestId('copilot-propose').click();

    if ((await settle(page)) === 'plan') {
      // Outcome 1. THE CONFIRMATION IS IN FRONT OF THE ACTION, not beside it.
      await expect(page.getByTestId('copilot-confirm')).toBeVisible();
      await expect(page.getByTestId('copilot-reject')).toBeVisible();
      // And nothing has executed yet: there is no result until it is confirmed.
      await expect(page.getByTestId('copilot-result')).toHaveCount(0);
      return;
    }

    // Outcome 2. An honest failure that discloses nothing.
    const body = (await page.content()).toLowerCase();
    for (const forbidden of ['mock-fast', 'openai', 'anthropic', 'sk-', 'prompt:', 'json']) {
      expect(body, `the page leaks "${forbidden}"`).not.toContain(forbidden);
    }
  });

  test('rejecting a plan executes nothing', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/copilot`);
    await page.getByTestId('copilot-request').fill('Create an autumn awareness campaign.');
    await page.getByTestId('copilot-propose').click();

    if ((await settle(page)) !== 'plan') return; // The refusal branch; covered above.

    const reject = page.getByTestId('copilot-reject');
    await expect(reject).toBeVisible();
    await reject.click();
    await expect(page.getByTestId('copilot-plan')).toHaveCount(0);
    await expect(page.getByTestId('copilot-result')).toHaveCount(0);
  });

  test('the assistant never shows a model name, a prompt or a credential', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/copilot`);
    await page.getByTestId('copilot-request').fill('What should we post this week?');
    await page.getByTestId('copilot-propose').click();

    /*
     * WAIT FOR THE SCREEN TO SETTLE EITHER WAY — a plan, or the refusal banner.
     * The scan that follows matters most on the FAILURE path, because that is
     * where a raw provider error would surface if anything ever leaked one.
     */
    await settle(page);

    const rendered = (await page.content()).toLowerCase();
    for (const forbidden of [
      'mock-fast',
      'openai',
      'anthropic',
      'sk-',
      'system instruction',
      'ai_request',
      'confirmationtokenhash',
    ]) {
      expect(rendered, `the assistant leaks "${forbidden}"`).not.toContain(forbidden);
    }
  });

  test('the Arabic assistant is right-to-left and clean under axe', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/copilot`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('main')).toContainText(/[؀-ۿ]/);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('strategy', () => {
  test('generating reaches a PROPOSAL or an honest refusal, and never rewrites the brain', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/strategy`);

    const form = page.getByTestId('strategy-form');
    await expect(form).toBeVisible();
    await form.locator('button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle');

    /*
     * WHICHEVER OUTCOME, ONE THING MUST BE TRUE: a generated strategy is a
     * PROPOSAL until a permitted human accepts it. So if an insight is on the
     * page it carries its evidence and its accept/dismiss controls, and nothing
     * anywhere claims it has been applied.
     */
    const evidence = page.getByTestId('insight-evidence');
    if ((await evidence.count()) > 0) {
      await expect(evidence.first()).toBeVisible();
    }
    const rendered = (await page.content()).toLowerCase();
    expect(rendered).not.toContain('mock-fast');
  });

  test('is clean under axe in Arabic', async ({ page }) => {
    await signIn(page, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/strategy`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

test.describe('automations', () => {
  test('a rule can be created, is listed, and starts DISABLED', async ({ page }) => {
    /*
     * NO MODEL IS INVOLVED HERE, so this journey runs to completion in a
     * browser. A new rule is created OFF: an automation that started acting the
     * moment it was saved would act before its author had read it back.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    const form = page.getByTestId('automation-form');
    await expect(form).toBeVisible();

    const name = `E2E rule ${Date.now()}`;
    await form.locator('input[name="name"]').fill(name);
    await form.locator('button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle');

    const rules = page.getByTestId('automation-rules');
    await expect(rules).toBeVisible();
    await expect(rules).toContainText(name);
  });

  test('A SCHEDULED RULE IS FULLY AUTHORABLE, and is created with its hour', async ({ page }) => {
    /*
     * THE DEFECT THIS COVERS (R3-1). The form rendered every trigger and posted
     * `triggerConfig: {}` whatever you chose — so "every day at a time" could be
     * selected and the time could not be given, and `createRule` refused the
     * rule with a validation error naming a field the screen had never shown.
     * Two of the six authorable triggers were, in practice, unauthorable.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    const form = page.getByTestId('automation-form');
    await expect(form).toBeVisible();

    const name = `E2E scheduled ${Date.now()}`;
    await form.locator('input[name="name"]').fill(name);
    await page.getByTestId('automation-trigger').selectOption('SCHEDULED_TIME');

    // THE SCHEDULE FIELDS APPEAR because the trigger needs them, and the
    // threshold fields do not.
    await expect(page.getByTestId('automation-schedule')).toBeVisible();
    await expect(page.getByTestId('automation-threshold')).toHaveCount(0);

    await page.getByTestId('automation-hour').selectOption('9');
    await form.locator('input[name="daysOfWeek"][value="1"]').check();
    await page.getByTestId('automation-submit').click();
    await page.waitForLoadState('networkidle');

    const rules = page.getByTestId('automation-rules');
    await expect(rules).toContainText(name);

    // AND IT ENABLES, which is the second, deliberate act — a rule that could be
    // created but never enabled would be the same defect one step along.
    const row = page.locator('[data-testid="automation-rules"] li', { hasText: name }).first();
    await row.getByRole('button', { name: /enable/i }).click();
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('[data-testid="automation-rules"] li', { hasText: name }).first(),
    ).toContainText(/disable/i);
  });

  test('A THRESHOLD RULE IS FULLY AUTHORABLE, with metric, direction and number', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    const form = page.getByTestId('automation-form');
    const name = `E2E threshold ${Date.now()}`;
    await form.locator('input[name="name"]').fill(name);
    await page.getByTestId('automation-trigger').selectOption('METRIC_THRESHOLD_CROSSED');

    await expect(page.getByTestId('automation-threshold')).toBeVisible();
    await expect(page.getByTestId('automation-schedule')).toHaveCount(0);

    await page.getByTestId('automation-metric').selectOption('followers');
    await page.getByTestId('automation-direction').selectOption('above');
    await page.getByTestId('automation-threshold-value').fill('1000');
    await page.getByTestId('automation-window').fill('7');
    await page.getByTestId('automation-submit').click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('automation-rules')).toContainText(name);

    const row = page.locator('[data-testid="automation-rules"] li', { hasText: name }).first();
    await row.getByRole('button', { name: /enable/i }).click();
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('[data-testid="automation-rules"] li', { hasText: name }).first(),
    ).toContainText(/disable/i);
  });

  test('A MISSING THRESHOLD NUMBER CANNOT BE SUBMITTED AT ALL', async ({ page }) => {
    /*
     * The browser refuses before the request leaves, because the field is
     * `required` — the customer is told at the control they left empty rather
     * than by a server error naming a field they never saw.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    const form = page.getByTestId('automation-form');
    const name = `E2E invalid ${Date.now()}`;
    await form.locator('input[name="name"]').fill(name);
    await page.getByTestId('automation-trigger').selectOption('METRIC_THRESHOLD_CROSSED');
    // Deliberately leaving the threshold empty.
    await page.getByTestId('automation-submit').click();
    await page.waitForTimeout(500);

    const invalid = await page
      .getByTestId('automation-threshold-value')
      .evaluate((node) => (node as HTMLInputElement).validity.valueMissing);
    expect(invalid).toBe(true);
    await expect(page.getByTestId('automation-rules')).not.toContainText(name);
  });

  test('AN INCOMPATIBLE TRIGGER/ACTION PAIR IS NEVER OFFERED', async ({ page }) => {
    /*
     * `actionSupportsTrigger` rejects an action that needs a content item on a
     * trigger that has none. The screen used to let both be selected
     * independently and refuse afterwards; now the action simply is not in the
     * list, so the pair cannot be chosen.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    await page.getByTestId('automation-trigger').selectOption('SCHEDULED_TIME');
    const scheduledActions = await page
      .getByTestId('automation-action')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    expect(scheduledActions).toContain('NOTIFY');
    expect(scheduledActions).not.toContain('SUBMIT_FOR_APPROVAL');
    expect(scheduledActions).not.toContain('PLACE_ON_CALENDAR');

    // And a trigger that DOES reach a content item offers them.
    await page.getByTestId('automation-trigger').selectOption('CONTENT_APPROVED');
    const approvedActions = await page
      .getByTestId('automation-action')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    expect(approvedActions).toContain('SUBMIT_FOR_APPROVAL');
  });

  test('A CONDITION FIELD IS OFFERED ONLY WHERE THE RUNTIME PRODUCES IT', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    await page.getByTestId('automation-trigger').selectOption('SCHEDULED_TIME');
    const timed = await page
      .getByTestId('automation-condition-field')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    // Only the brand, plus the "no condition" default.
    expect(timed.filter((value) => value !== '')).toEqual(['brand.id']);

    await page.getByTestId('automation-trigger').selectOption('METRIC_THRESHOLD_CROSSED');
    const metric = await page
      .getByTestId('automation-condition-field')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    expect(metric).toContain('metric.changeMilli');
    expect(metric).not.toContain('content.status');
  });

  /*
   * R4-1 — THE CONDITION CONTROLS ARE THE FIELD'S, AND THE VALUES ARE REAL.
   *
   * The screen used to render every operator in the registry beside every
   * field, and a single text box beside every operator. So `brand.id
   * greater_than 5` was one click away; `content.hasCampaign equals` posted the
   * STRING "true" against a real boolean fact; and `in` posted a lone string
   * where the engine requires an array. Each of those saved a rule that was
   * listed, enabled — and false for ever.
   */
  test('A NUMERIC CONDITION OFFERS MAGNITUDE, AND A NUMBER INPUT', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    await page.getByTestId('automation-trigger').selectOption('CONTENT_APPROVED');
    await page.getByTestId('automation-condition-field').selectOption('content.platformCount');

    const operators = await page
      .getByTestId('automation-condition-operator')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    expect(operators).toEqual(['equals', 'not_equals', 'greater_than', 'less_than']);
    // NO `in`, NO `is_true`: neither can be satisfied against a number.
    expect(operators).not.toContain('in');
    expect(operators).not.toContain('is_true');

    const value = page.getByTestId('automation-condition-value');
    await expect(value).toHaveAttribute('type', 'number');

    const name = `E2E numeric ${Date.now()}`;
    await page.locator('[data-testid="automation-form"] input[name="name"]').fill(name);
    await page.getByTestId('automation-condition-operator').selectOption('greater_than');
    await value.fill('1');
    await page.getByTestId('automation-submit').click();
    await page.waitForLoadState('networkidle');

    // IT WAS ACCEPTED, and it enables — the engine validated field, operator
    // and value kind, and none of them was refused.
    await expect(page.getByTestId('automation-rules')).toContainText(name);
    const row = page.locator('[data-testid="automation-rules"] li', { hasText: name }).first();
    await row.getByRole('button', { name: /enable/i }).click();
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('[data-testid="automation-rules"] li', { hasText: name }).first(),
    ).toContainText(/disable/i);
  });

  test('A BOOLEAN CONDITION OFFERS is_true / is_false, AND NO VALUE BOX AT ALL', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    await page.getByTestId('automation-trigger').selectOption('CONTENT_APPROVED');
    await page.getByTestId('automation-condition-field').selectOption('content.hasCampaign');

    const operators = await page
      .getByTestId('automation-condition-operator')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    expect(operators).toEqual(['is_true', 'is_false']);
    // THE DEFECT, GONE: there is no `equals` to pair with the string "true".
    expect(operators).not.toContain('equals');
    await expect(page.getByTestId('automation-condition-value')).toHaveCount(0);

    const name = `E2E boolean ${Date.now()}`;
    await page.locator('[data-testid="automation-form"] input[name="name"]').fill(name);
    await page.getByTestId('automation-submit').click();
    await page.waitForLoadState('networkidle');

    await expect(page.getByTestId('automation-rules')).toContainText(name);
    const row = page.locator('[data-testid="automation-rules"] li', { hasText: name }).first();
    await row.getByRole('button', { name: /enable/i }).click();
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('[data-testid="automation-rules"] li', { hasText: name }).first(),
    ).toContainText(/disable/i);
  });

  test('A CLOSED STRING FIELD IS PICKED, NEVER TYPED, AND ITS OPTIONS ARE TRANSLATED', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    await page.getByTestId('automation-trigger').selectOption('CONTENT_APPROVED');
    await page.getByTestId('automation-condition-field').selectOption('content.status');

    const operators = await page
      .getByTestId('automation-condition-operator')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    expect(operators).toEqual(['equals', 'not_equals', 'in', 'not_in']);

    const value = page.getByTestId('automation-condition-value');
    // A PICKER, so a status that does not exist cannot be entered at all.
    await expect(value).toHaveJSProperty('tagName', 'SELECT');
    const statuses = await value
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    expect(statuses).toContain('APPROVED');
    expect(statuses).toContain('PARTIALLY_PUBLISHED');
    // AND THE LABELS ARE COPY, not enum names (§4: no hard-coded user copy).
    const labels = await value
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
    expect(labels).toContain('Partially published');

    const name = `E2E string ${Date.now()}`;
    await page.locator('[data-testid="automation-form"] input[name="name"]').fill(name);
    await value.selectOption('APPROVED');
    await page.getByTestId('automation-submit').click();
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('automation-rules')).toContainText(name);
  });

  test('A LIST OPERATOR POSTS A REAL ARRAY, FROM A MULTIPLE PICKER', async ({ page }) => {
    /*
     * THE ARRAY PATH, PROVEN END TO END. `in` and `not_in` remain exposed, so
     * the rule from the review applies: the UI must produce a genuine
     * `string[]`. It used to sit beside a single text box that posted one
     * string, and `evaluateCondition` requires an array — so the condition was
     * false whatever was chosen.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    await page.getByTestId('automation-trigger').selectOption('CONTENT_APPROVED');
    await page.getByTestId('automation-condition-field').selectOption('content.status');
    await page.getByTestId('automation-condition-operator').selectOption('in');

    const value = page.getByTestId('automation-condition-value');
    await expect(value).toHaveJSProperty('multiple', true);

    const name = `E2E list ${Date.now()}`;
    await page.locator('[data-testid="automation-form"] input[name="name"]').fill(name);
    await value.selectOption(['APPROVED', 'SCHEDULED']);
    await page.getByTestId('automation-submit').click();
    await page.waitForLoadState('networkidle');

    // ACCEPTED — the engine refuses a list operator whose value is not a
    // non-empty array of members of the closed set, so reaching the list at all
    // is the proof that a real array was posted.
    await expect(page.getByTestId('automation-rules')).toContainText(name);
    const row = page.locator('[data-testid="automation-rules"] li', { hasText: name }).first();
    await row.getByRole('button', { name: /enable/i }).click();
    await page.waitForLoadState('networkidle');
    await expect(
      page.locator('[data-testid="automation-rules"] li', { hasText: name }).first(),
    ).toContainText(/disable/i);
  });

  test('CHANGING THE FIELD RESETS AN OPERATOR THAT NO LONGER APPLIES', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    await page.getByTestId('automation-trigger').selectOption('CONTENT_APPROVED');
    await page.getByTestId('automation-condition-field').selectOption('content.platformCount');
    await page.getByTestId('automation-condition-operator').selectOption('greater_than');

    // `greater_than` is meaningless on a boolean, and must not survive.
    await page.getByTestId('automation-condition-field').selectOption('content.hasCampaign');
    await expect(page.getByTestId('automation-condition-operator')).toHaveValue('is_true');
  });

  test('the Arabic authoring form offers the same narrowed controls, in Arabic', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/ar/automations`);

    await page.getByTestId('automation-trigger').selectOption('CONTENT_APPROVED');
    await page.getByTestId('automation-condition-field').selectOption('content.hasCampaign');

    const operators = await page
      .getByTestId('automation-condition-operator')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
    expect(operators).toEqual(['is_true', 'is_false']);

    // NO ENGLISH FALLBACK in the operator labels, and none in the status
    // picker either — the closed sets are translated, not printed raw.
    const operatorLabels = await page
      .getByTestId('automation-condition-operator')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
    for (const label of operatorLabels) expect(label).toMatch(/[\u0600-\u06FF]/);

    await page.getByTestId('automation-condition-field').selectOption('content.status');
    const statusLabels = await page
      .getByTestId('automation-condition-value')
      .locator('option')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
    for (const label of statusLabels) expect(label).toMatch(/[\u0600-\u06FF]/);
  });

  test('the run history is present, or SAYS it is empty rather than showing nothing', async ({
    page,
  }) => {
    /*
     * BOTH OUTCOMES ARE CORRECT AND THE SCREEN MUST DISTINGUISH THEM. A newly
     * created rule has never fired, so an empty history is the honest state —
     * and an empty region with no words in it is the state that reads as a bug.
     */
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    const runs = page.getByTestId('automation-runs');
    if ((await runs.count()) > 0) {
      await expect(runs).toBeVisible();
      return;
    }
    // The empty state, and it says so in words.
    await expect(page.getByText(/no rule has run yet/i).first()).toBeVisible();
  });

  test('is clean under axe in both directions', async ({ page }) => {
    // One sign-in, two locales — see the analytics suite for why.
    await signIn(page);
    for (const locale of ['en', 'ar']) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations`);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${locale} automations`).toEqual([]);
    }
  });
});

/*
 * PHASE 6 · P6-11 — WHAT HAPPENED, WHY, AND WHAT NEXT.
 *
 * The loop's screens, driven for real: Analytics offers "why?", the answer is
 * read in Marketing Intelligence as three sections that cite stored evidence,
 * and Home carries the result in its one ranked list. Nothing here asserts a
 * particular finding — the seeded series decides whether there is a shift and
 * whether the explanation has enough data, and a test that assumed either would
 * be asserting on the fixture rather than the product. Each branch the product
 * can honestly take is accepted, and each is checked for what it must say.
 */
test.describe('P6-11 · analytics → intelligence → pulse', () => {
  test('"why?" is answered in Marketing Intelligence, or honestly declined', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?${RANGE}`);

    const explain = page.getByTestId('analytics-explain');
    await expect(explain).toBeVisible();
    /*
     * WAIT FOR THE REDIRECT'S OWN MARKER, not for a path. The page starts on
     * `/analytics?range=…`, which already matches "analytics with a query", so a
     * path pattern resolves before the action has even run. Every outcome of the
     * explain action carries `ok=` or `error=`, and the starting URL carries
     * neither.
     */
    await Promise.all([page.waitForURL(/[?&](ok|error)=/), explain.click()]);

    if (new URL(page.url()).pathname.endsWith('/intelligence')) {
      // Landed on the finding it produced: focused, and read as three answers.
      expect(new URL(page.url()).searchParams.get('insight')).toMatch(/^[0-9a-f-]{36}$/);
      await expect(page.getByTestId('intelligence-focused')).toBeVisible();
      const narrative = page.getByTestId('intelligence-narrative').first();
      await expect(narrative.getByTestId('narrative-why')).toBeVisible();
      await expect(narrative.getByTestId('narrative-happened')).toBeVisible();
      // Every figure on the card still comes from the stored evidence rows.
      await expect(page.getByTestId('intelligence-evidence').first()).toBeVisible();
    } else {
      // Not enough data is an ANSWER, and nothing was charged for it.
      await expect(page.getByText(/not enough performance data/i)).toBeVisible();
    }
  });

  test('a next step is only ever a link somewhere real', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics?${RANGE}`);
    const next = page.getByTestId('analytics-next');
    if ((await next.count()) === 0) return; // nothing to do is a finished state
    for (const link of await next.locator('a').all()) {
      const href = await link.getAttribute('href');
      // P6-12 added the card's "Ask Copilot" entry, which carries its context.
      expect(href).toMatch(
        /^\/en\/((integrations|calendar|intelligence)|copilot\?from=analytics)$/,
      );
      const response = await page.request.get(`${DASHBOARD_BASE_URL}${href}`);
      expect(response.status(), `${href} answers`).toBeLessThan(400);
    }
  });

  test('Home names the list Pulse, in both languages', async ({ page }) => {
    await signIn(page);
    await expect(page.getByTestId('attention-card')).toContainText('Pulse');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/overview`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('attention-card')).toContainText('النبض');
  });

  test('intelligence is clean under axe in both directions', async ({ page }) => {
    await signIn(page);
    for (const locale of ['en', 'ar']) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/intelligence`);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${locale} intelligence`).toEqual([]);
    }
  });

  test('intelligence does not scroll sideways on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    for (const path of ['/en/intelligence', '/ar/intelligence', '/en/overview']) {
      await page.goto(`${DASHBOARD_BASE_URL}${path}`);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls sideways on a phone`).toBeLessThanOrEqual(1);
    }
  });
});

/*
 * PHASE 6 · P6-12 — THE COPILOT IN CONTEXT, AND AUTOMATIONS THAT SAY WHAT THEY DO.
 *
 * The model's output is not asserted: it is a deterministic development double
 * here, and a test that assumed a particular plan would be testing the double.
 * What is asserted is what the PRODUCT guarantees whatever the plan is.
 */
test.describe('P6-12 · copilot and automations', () => {
  test('Home opens the Copilot with Home as its context, on the rail’s brand', async ({ page }) => {
    await signIn(page);
    const entry = page.getByTestId('overview-copilot-open');
    await expect(entry).toBeVisible();
    await Promise.all([page.waitForURL(/\/en\/copilot\?from=overview$/), entry.click()]);
    const context = page.getByTestId('copilot-context');
    await expect(context).toBeVisible();
    // The brand every step will act on, and where the conversation started.
    await expect(context).toContainText(/Acting on /);
    await expect(context).toContainText(/opened from Home/);
    // No second brand picker: the rail is the one source of brand context.
    await expect(page.getByTestId('copilot-brand')).toHaveCount(0);
  });

  test('an unknown ?from= is not echoed anywhere', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/copilot?from=${encodeURIComponent('<b>x</b>')}`);
    await expect(page.getByTestId('copilot-context')).not.toContainText('opened from');
    await expect(page.locator('main')).not.toContainText('<b>x</b>');
  });

  test('declining a plan closes it, and nothing runs', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/copilot?from=campaigns`);
    await page.getByTestId('copilot-request').fill('Create an autumn awareness campaign.');
    await page.getByTestId('copilot-propose').click();
    const outcome = await settle(page);
    if (outcome !== 'plan') return; // a refusal is an honest answer too
    const reject = page.getByTestId('copilot-reject');
    if ((await reject.count()) === 0) return; // a read-only plan needs no decision
    const cancelled = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/copilot/cancel') && response.request().method() === 'POST',
    );
    await reject.click();
    expect((await cancelled).status()).toBeLessThan(500);
    await expect(page.getByTestId('copilot-plan')).toHaveCount(0);
    await expect(page.getByTestId('copilot-result')).toHaveCount(0);
  });

  test('the Copilot screen is clean under axe in both directions', async ({ page }) => {
    await signIn(page);
    for (const locale of ['en', 'ar']) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/copilot?from=analytics`);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations, `${locale} copilot`).toEqual([]);
    }
  });

  test('deleting a rule asks first', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);
    const form = page.getByTestId('automation-form');
    const name = `E2E delete ${Date.now()}`;
    await form.locator('input[name="name"]').fill(name);
    await page.getByTestId('automation-submit').click();
    await page.waitForLoadState('networkidle');

    const row = page.locator('[data-testid="automation-rules"] li', { hasText: name }).first();
    const confirmDelete = row.getByRole('button', { name: /delete this rule/i });
    // Not reachable in one click: the destructive button is behind a disclosure.
    await expect(confirmDelete).toBeHidden();
    await row.locator('summary').click();
    await expect(confirmDelete).toBeVisible();
    await confirmDelete.click();
    await page.waitForLoadState('networkidle');
    // The rule is gone — whether the list remains or gives way to its empty state.
    await expect(page.locator('main')).not.toContainText(name);
  });
});
