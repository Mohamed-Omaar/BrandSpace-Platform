import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ADMIN_BASE_URL } from './apps';
import { signIn, useMode } from './admin-session';
import { expectNoHorizontalOverflow } from './overflow';

/**
 * THE OWNER'S CONTROL CENTER — SIMPLE AND ADVANCED MODE (D-307 … D-314).
 *
 * What this suite proves, against the real application and database:
 *
 *   1. A fresh session starts in SIMPLE mode, with the owner's eight
 *      destinations and none of the technical route list or placeholder
 *      top-bar controls.
 *   2. The switch changes presentation only: it keeps the reader on the same
 *      screen, and an Advanced screen opened by URL in Simple mode renders
 *      (with a note) rather than redirecting or 404ing — the mode is not an
 *      access control.
 *   3. Every Simple screen renders in both languages and directions, passes
 *      axe, and does not overflow a phone.
 *   4. The Simple write paths reach the SAME services: a plan draft is saved,
 *      checked and discarded; a feature's access is changed and restored; the
 *      AI profile is changed and restored; a customer's credits are adjusted
 *      and the customer is suspended and reactivated; a provider's settings are
 *      saved and tested. Shared state is left as it was found where the suite
 *      changes it.
 *
 * It runs in its own serial project AFTER `admin-console`, because it
 * activates configuration the Phase 3 suites also edit.
 */

const BLOCKING = new Set(['serious', 'critical']);

async function expectAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) => BLOCKING.has(v.impact ?? ''));
  expect(
    blocking,
    `${label}: ${blocking.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`).join('; ')}`,
  ).toEqual([]);
}

/**
 * The Phase 3 suites in `admin-console` deliberately leave drafts open (a
 * saved flag, a plan, a feature). A Simple change refuses to run over them —
 * which is the product working — so a test that needs to change a setting
 * first clears them through the SAME notice an owner would use.
 */
async function discardLeftovers(page: Page): Promise<void> {
  if ((await page.getByTestId('open-draft-notice').count()) === 0) return;
  await page.getByTestId('open-draft-reason').fill('Clear drafts left by an earlier suite');
  await page.getByTestId('open-draft-confirm').check();
  await page.getByTestId('open-draft-discard').click();
  await expect(page).toHaveURL(/ok=DRAFT_DISCARDED/);
}

const SIMPLE_NAV = [
  'nav-nav.home',
  'nav-nav.customers',
  'nav-nav.plans',
  'nav-nav.features',
  'nav-nav.ai',
  'nav-nav.integrations',
  'nav-nav.usage',
  'nav-nav.system',
];

const SIMPLE_SCREENS: readonly { path: string; marker: string }[] = [
  { path: '/console', marker: 'home-readiness' },
  { path: '/console/workspaces', marker: 'customer-filters' },
  { path: '/console/plans', marker: 'plan-cards' },
  { path: '/console/features', marker: 'features-technical' },
  { path: '/console/ai', marker: 'ai-current' },
  { path: '/console/ai/connect', marker: 'connect-steps' },
  { path: '/console/ai/profile', marker: 'profile-preview' },
  { path: '/console/integrations', marker: 'integration-cards' },
  { path: '/console/integrations/payment/development-mock', marker: 'setup-steps' },
  { path: '/console/usage', marker: 'usage-not-measured' },
  { path: '/console/health', marker: 'system-overall' },
];

test.describe('Simple mode is the default and hides implementation detail, not functionality', () => {
  test('a fresh session starts in Simple with the owner navigation and no placeholders', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await expect(page.getByTestId('mode-simple')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mode-advanced')).toHaveAttribute('aria-pressed', 'false');

    const rail = page.getByRole('navigation').first();
    const order = await rail
      .locator('[data-testid^="nav-nav."]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
    expect(order).toEqual(SIMPLE_NAV);
    for (const technical of [
      'nav-nav.configuration',
      'nav-nav.secrets',
      'nav-nav.routing',
      'nav-nav.audit',
      'nav-nav.support',
    ]) {
      await expect(page.getByTestId(technical)).toHaveCount(0);
    }
    // D-309: the Control Center has no search, notification or create domain.
    for (const placeholder of ['topbar-search', 'topbar-notifications', 'topbar-create']) {
      await expect(page.getByTestId(placeholder)).toHaveCount(0);
    }
  });

  test('the Control Center opens in English unless Arabic is asked for', async ({ page }) => {
    await page.goto(`${ADMIN_BASE_URL}/`);
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);
  });

  test('switching keeps the screen, and Advanced keeps the technical navigation', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations`);
    await expect(page.getByTestId('integration-cards')).toBeVisible();

    await useMode(page, 'advanced');
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/console/integrations`);
    await expect(page.getByTestId('nav-nav.configuration')).toBeVisible();
    await expect(page.getByTestId('nav-nav.secrets')).toBeVisible();
    await expect(page.getByTestId('integration-cards')).toHaveCount(0);

    await useMode(page, 'simple');
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/console/integrations`);
    await expect(page.getByTestId('integration-cards')).toBeVisible();
  });

  test('an Advanced screen opened in Simple mode renders, with a note — never a 404', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    const response = await page.goto(`${ADMIN_BASE_URL}/en/console/configuration`);
    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('advanced-screen-note')).toBeVisible();
    await expect(page.getByTestId('heading')).toHaveText('Configuration management');
    await page.getByTestId('advanced-note-switch').click();
    await expect(page.getByTestId('mode-advanced')).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/console/configuration`);
    await expect(page.getByTestId('advanced-screen-note')).toHaveCount(0);
  });

  test('"View technical details" lands on the Advanced view of the same screen', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await page.goto(`${ADMIN_BASE_URL}/en/console/health`);
    await expect(page.getByTestId('system-jobs-state')).toHaveText('Not measured here');
    await page.getByTestId('system-technical').click();
    await expect(page.getByTestId('mode-advanced')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('health-readiness')).toBeVisible();
  });
});

test.describe('every Simple screen, in both languages', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`renders, is accessible and has the right direction (${locale})`, async ({ page }) => {
      await signIn(page, locale, { mode: 'simple' });
      for (const screen of SIMPLE_SCREENS) {
        const response = await page.goto(`${ADMIN_BASE_URL}/${locale}${screen.path}`);
        expect(response?.status(), screen.path).toBe(200);
        await expect(page.getByTestId(screen.marker), screen.path).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
        await expectAccessible(page, `${locale}${screen.path}`);
      }
    });

    test(`fits a phone without sideways scrolling (${locale})`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await signIn(page, locale, { mode: 'simple' });
      for (const screen of SIMPLE_SCREENS) {
        await page.goto(`${ADMIN_BASE_URL}/${locale}${screen.path}`);
        await expect(page.getByTestId(screen.marker)).toBeVisible();
        await expectNoHorizontalOverflow(page, `${locale}${screen.path} @390`);
      }
    });
  }
});

test.describe('the owner questions have truthful answers', () => {
  test('Home: what needs attention, is BrandSpace ready, and at a glance', async ({ page }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await expect(page.getByTestId('home-attention')).toBeVisible();
    // Six readiness areas, each with a state word — computed, not stored.
    for (const area of ['email', 'storage', 'ai', 'social', 'payment', 'plans']) {
      await expect(page.getByTestId(`readiness-${area}-state`)).toBeVisible();
    }
    // The development stand-in is never reported as "Connected".
    await expect(page.getByTestId('readiness-ai-state')).not.toHaveText('Connected');
    await expect(page.getByTestId('readiness-verdict')).not.toHaveAttribute('data-status', 'ready');
    // Every attention item deep-links into this console.
    const hrefs = await page
      .locator('[data-testid$="-action"][href]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('href') ?? ''));
    for (const href of hrefs) expect(href.startsWith('/en/console')).toBe(true);
    await expect(page.getByTestId('glance-customers-total')).toBeVisible();
  });

  test('Usage & Billing says what it does not measure', async ({ page }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await page.goto(`${ADMIN_BASE_URL}/en/console/usage`);
    await expect(page.getByTestId('usage-not-measured')).toContainText('not shown');
    await expect(page.locator('body')).not.toContainText('MRR:');
  });
});

test.describe('Simple writes go through the existing services', () => {
  test('a plan draft is saved in major units, described in plain words, checked and discarded', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    const key = `e2e-simple-${randomUUID().slice(0, 8)}`;
    await page.goto(`${ADMIN_BASE_URL}/en/console/plans?edit=new`);
    await page.getByTestId('pe-key').fill(key);
    await page.getByTestId('pe-name-en').fill('Simple E2E Plan');
    await page.getByTestId('pe-name-ar').fill('خطة اختبار');
    await page.getByTestId('pe-price-USD-monthly').fill('19.50');
    await page.getByTestId('pe-price-USD-annual').fill('195');
    await page.getByTestId('pe-monthly-credits').fill('250');
    await page.getByTestId('pe-reason').fill('End-to-end check of the Simple plan editor');
    await page.getByTestId('pe-save').click();
    await expect(page).toHaveURL(/ok=DRAFT_SAVED/);
    await expect(page.getByTestId('plans-pending-changes')).toContainText(
      'New plan: Simple E2E Plan',
    );

    await page.getByTestId('plans-check').click();
    await expect(page).toHaveURL(/ok=VALIDATION_/);
    // Either verdict is a real answer from the service; the draft is not activated here.
    await page.getByTestId('plans-discard').click();
    await expect(page).toHaveURL(/ok=DRAFT_DISCARDED/);
    await expect(page.getByTestId('plans-pending')).toHaveCount(0);
  });

  test('the AI profile changes only with a reason and a confirmation, and is restored', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await page.goto(`${ADMIN_BASE_URL}/en/console/ai`);
    const original = (await page.getByTestId('ai-profile').textContent()) ?? '';
    const target = original.includes('Balanced') ? 'premium' : 'balanced';

    await page.goto(`${ADMIN_BASE_URL}/en/console/ai/profile?preview=${target}`);
    await discardLeftovers(page);
    await expect(page.getByTestId('profile-preview')).toBeVisible();
    await page.getByTestId('profile-reason').fill('End-to-end check of the Simple profile switch');
    await page.getByTestId('profile-confirm').check();
    await page.getByTestId('profile-submit').click();
    await expect(page).toHaveURL(/\/en\/console\/ai\?ok=PROFILE_ACTIVATED/);
    await expect(page.getByTestId('ai-profile')).toContainText(
      target === 'balanced' ? 'Balanced' : 'Premium',
    );

    // Restore whatever was active, through the same flow.
    const restore =
      ['Economy', 'Balanced', 'Premium', 'Custom'].find((name) => original.includes(name)) ??
      'Custom';
    await page.goto(`${ADMIN_BASE_URL}/en/console/ai/profile?preview=${restore.toLowerCase()}`);
    await page.getByTestId('profile-reason').fill('Restore the profile after the end-to-end check');
    await page.getByTestId('profile-confirm').check();
    await page.getByTestId('profile-submit').click();
    await expect(page.getByTestId('ai-profile')).toContainText(restore);
  });

  test('a provider is set up through the guided steps, write-only, and tested', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await page.goto(`${ADMIN_BASE_URL}/en/console/integrations/payment/development-mock`);
    await page.getByTestId('setting-hostedBaseUrl').fill('https://checkout.dev.example');
    await page.getByTestId('credential-input-webhookSecret').fill(`whsec_${randomUUID()}`);
    await page.getByTestId('save-reason').fill('End-to-end check of the guided setup');
    await page.getByTestId('save-configuration').click();
    await expect(page).toHaveURL(/ok=CONFIGURATION_SAVED/);
    await expect(page.getByTestId('step-details-status')).toHaveText('Done');
    // A saved credential is never shown again — the box stays empty.
    await expect(page.getByTestId('credential-input-webhookSecret')).toHaveValue('');

    await page.getByTestId('test-connection').click();
    await expect(page).toHaveURL(/ok=CONNECTION_TESTED/);
    await expect(page.getByTestId('setup-test-result')).not.toHaveText('Not tested yet.');
  });

  test('an unfinished change is shown up front, and can be discarded deliberately', async ({
    page,
  }) => {
    // Somebody saves a feature in Advanced and never activates it.
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/features`);
    const form = page.getByTestId('feature-form');
    await form.getByTestId('feature-key').fill(`e2e.draft.${randomUUID().slice(0, 8)}`);
    await form.locator('[name="name.en"]').fill('Unfinished feature');
    await form.locator('[name="name.ar"]').fill('ميزة غير مكتملة');
    await form.getByTestId('feature-type').selectOption('boolean');
    await form.getByTestId('save-feature').click();
    await expect(page).toHaveURL(/ok=/);

    // Simple mode says so before the owner starts, and offers no change control.
    await useMode(page, 'simple');
    await page.goto(`${ADMIN_BASE_URL}/en/console/features`);
    await expect(page.getByTestId('open-draft-notice')).toBeVisible();
    await expect(page.locator('[data-testid$="-change"]')).toHaveCount(0);

    await page.getByTestId('open-draft-reason').fill('Stale draft from an abandoned edit');
    await page.getByTestId('open-draft-confirm').check();
    await page.getByTestId('open-draft-discard').click();
    await expect(page).toHaveURL(/ok=DRAFT_DISCARDED/);
    await expect(page.getByTestId('open-draft-notice')).toHaveCount(0);
  });

  test('a feature is switched on for everyone and back, with a preview first', async ({ page }) => {
    // The registry is Advanced: create a boolean feature there, activated.
    const key = `e2e.simple.${randomUUID().slice(0, 8)}`;
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/features`);
    const form = page.getByTestId('feature-form');
    await form.getByTestId('feature-key').fill(key);
    await form.locator('[name="name.en"]').fill('Simple E2E feature');
    await form.locator('[name="name.ar"]').fill('ميزة اختبار');
    await form.getByTestId('feature-type').selectOption('boolean');
    await form.getByTestId('save-feature').click();
    await page.getByTestId('validate-features').click();
    const activate = page.locator('form', { has: page.getByTestId('activate-features') });
    await activate.locator('[name="acknowledge"]').check();
    await activate.getByTestId('activate-features').click();
    await expect(page).toHaveURL(/ok=/);

    await useMode(page, 'simple');
    await page.goto(`${ADMIN_BASE_URL}/en/console/features`);
    await discardLeftovers(page);
    await expect(page.getByTestId(`feature-${key}-access`)).toHaveText('Off for every plan');

    await page.getByTestId(`feature-${key}-change`).click();
    await page.getByTestId('feature-access-everyone').check();
    await page.getByTestId('feature-preview').click();
    await expect(page.getByTestId('feature-review-lines')).toContainText('on for every customer');
    await page.getByTestId('feature-reason').fill('End-to-end check of the Simple feature switch');
    await page.getByTestId('feature-confirm').check();
    await page.getByTestId('feature-apply').click();
    await expect(page).toHaveURL(/ok=ACCESS_CHANGED/);
    await expect(page.getByTestId(`feature-${key}-access`)).toHaveText('On for everyone');

    await page.getByTestId(`feature-${key}-change`).click();
    await page.getByTestId('feature-access-plans').check();
    // Coming from "everyone", every plan starts ticked — which is the truth of
    // what everyone means. Untick them all to put the feature back as it was.
    for (const box of await page.locator('[data-testid^="feature-plan-"]').all())
      await box.uncheck();
    await page.getByTestId('feature-preview').click();
    await expect(page.getByTestId('feature-review-lines')).toContainText(
      'Plans that will have it: None',
    );
    await page.getByTestId('feature-reason').fill('Restore plan-by-plan access after the check');
    await page.getByTestId('feature-confirm').check();
    await page.getByTestId('feature-apply').click();
    await expect(page.getByTestId(`feature-${key}-access`)).toHaveText('Off for every plan');
  });

  test('a customer is created, credited, suspended and reactivated from Simple mode', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    const slug = `simple-${randomUUID().slice(0, 8)}`;
    await page.goto(`${ADMIN_BASE_URL}/en/console/workspaces`);
    await page.getByTestId('customer-add').click();
    await page.locator('#name').fill('Simple Mode Customer');
    await page.locator('#slug').fill(slug);
    await page.locator('#ownerEmail').fill(`${slug}@example.test`);
    await page.locator('#country').fill('AE');
    await page.locator('#timezone').fill('Asia/Dubai');
    await page.locator('#currency').fill('AED');
    await page.getByTestId('create-workspace-submit').click();
    await expect(page).toHaveURL(/\/en\/console\/workspaces\/[0-9a-f-]+\?ok=WORKSPACE_CREATED/);
    await expect(page.getByTestId('customer-name')).toHaveText('Simple Mode Customer');

    await page.getByTestId('simple-credits').fill('25');
    await page.getByTestId('credits-reason').fill('Goodwill credits for the end-to-end check');
    await page.getByTestId('simple-credits-submit').click();
    await expect(page).toHaveURL(/ok=CREDITS_ADJUSTED/);

    await page.getByTestId('status-reason').fill('End-to-end suspension check');
    await page.getByTestId('suspend-confirm').check();
    await page.getByTestId('simple-status-submit').click();
    await expect(page).toHaveURL(/ok=STATUS_CHANGED/);
    await expect(page.getByTestId('customer-status')).toHaveText('Suspended');

    await page.getByTestId('status-reason').fill('End-to-end reactivation check');
    await page.getByTestId('simple-status-submit').click();
    await expect(page.getByTestId('customer-status')).toHaveText('Active');

    await page.goto(`${ADMIN_BASE_URL}/en/console/workspaces?status=ACTIVE`);
    await expect(page.getByTestId(`customer-${slug}`)).toBeVisible();
  });
});
