import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ADMIN_BASE_URL } from './apps';
import { signIn, totpCode, useMode } from './admin-session';
import { credentials } from './admin-session';
import { withPlatformPrisma } from './platform-prisma';
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

/** Open a card page with nothing left unfinished in Advanced (the earlier suites leave drafts). */
async function openArea(page: Page, path: string): Promise<void> {
  await page.goto(`${ADMIN_BASE_URL}${path}`);
  await discardLeftovers(page);
}

/** The preview's confirmation and Save. */
async function saveChange(page: Page): Promise<void> {
  await page.getByTestId('area-preview-confirm').check();
  await page.getByTestId('area-preview-submit').click();
  await expect(page).toHaveURL(/ok=SAVED/);
}

/** The newest `config.activated` audit event's old -> new for one changed value. */
async function lastActivationChange(
  path: string,
): Promise<{ before: unknown; after: unknown } | null> {
  return withPlatformPrisma(async (prisma) => {
    const events = await prisma.auditEvent.findMany({
      where: { action: 'config.activated' },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    for (const event of events) {
      type Changes = { changes?: { path: string; value: unknown }[] } | null;
      const after = (event.after as Changes)?.changes ?? [];
      const before = (event.before as Changes)?.changes ?? [];
      const index = after.findIndex((change) => change.path === path);
      if (index >= 0) return { before: before[index]?.value, after: after[index]?.value };
    }
    return null;
  });
}

const SIMPLE_NAV = [
  'nav-nav.home',
  'nav-nav.customers',
  'nav-nav.plans',
  'nav-nav.trial',
  'nav-nav.features',
  'nav-nav.channels',
  'nav-nav.publishing',
  'nav-nav.content',
  'nav-nav.uploads',
  'nav-nav.ai',
  'nav-nav.signups',
  'nav-nav.email',
  'nav-nav.legal',
  'nav-nav.integrations',
  'nav-nav.usage',
  'nav-nav.system',
  'nav-nav.team',
  'nav-nav.changes',
];

const SIMPLE_SCREENS: readonly { path: string; marker: string }[] = [
  { path: '/console', marker: 'home-readiness' },
  { path: '/console/workspaces', marker: 'customer-filters' },
  { path: '/console/plans', marker: 'area-collection-plans' },
  { path: '/console/manage', marker: 'manage-grid' },
  { path: '/console/manage/trial', marker: 'area-collection-trial' },
  { path: '/console/manage/channels', marker: 'area-collection-channels' },
  { path: '/console/manage/publishing', marker: 'area-collection-providers' },
  { path: '/console/manage/signups', marker: 'area-collection-signups' },
  { path: '/console/manage/uploads', marker: 'area-collection-kinds' },
  { path: '/console/manage/email', marker: 'area-collection-senders' },
  { path: '/console/manage/content', marker: 'area-collection-industries' },
  { path: '/console/manage/legal', marker: 'area-collection-documents' },
  { path: '/console/team', marker: 'team-cards' },
  { path: '/console/changes', marker: 'changes-intro' },
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
  test('a plan is created, edited, duplicated and archived from its cards, and its last change undone', async ({
    page,
  }) => {
    // Control Center Simple mode (owner decision): the plan cards replace the
    // draft-based plan editor, and every step is one activation through the
    // Configuration Service.
    await signIn(page, 'en', { mode: 'simple' });
    const key = `e2e-cc-${randomUUID().slice(0, 8)}`;
    await openArea(page, '/en/console/plans');
    await page.getByTestId('area-new-plans').click();
    await page.getByTestId('field-key').fill(key);
    await page.getByTestId('field-nameEn').fill('Simple E2E Plan');
    await page.getByTestId('field-nameAr').fill('خطة اختبار');
    // Not offered to anyone, so the customer suites running beside this one never see it.
    await page.getByTestId('field-availability').selectOption('draft');
    await page.locator('[data-testid^="field-priceMonthly-"]').first().fill('19.50');
    await page.getByTestId('field-monthlyCredits').fill('250');
    await expectAccessible(page, 'the plan editor');
    await page.getByTestId('area-check').click();
    await expect(page.getByTestId('area-preview')).toContainText('New: Simple E2E Plan');
    await expectAccessible(page, 'the plan preview');
    await expect(page.getByTestId('plan-customer-card')).toContainText('Simple E2E Plan');
    await expect(page.getByTestId('plan-customer-card')).toContainText('19.50');
    await saveChange(page);
    const card = page.getByTestId(`area-card-plans-${key}`);
    await expect(card).toContainText('Simple E2E Plan');

    // Edit: the editor shows the current value; the preview says old -> new.
    await page.getByTestId(`area-edit-plans-${key}`).click();
    await expect(page.getByTestId('field-monthlyCredits-now')).toContainText('250');
    await page.getByTestId('field-monthlyCredits').fill('300');
    await page.getByTestId('area-check').click();
    await expect(page.getByTestId('area-preview-changes')).toContainText(
      'Monthly credits: 250 credits → 300 credits',
    );
    await saveChange(page);
    await expect(card).toContainText('300');

    // The audit event is the Configuration Service's own, with old -> new.
    const change = await lastActivationChange(`plans[${key}].monthlyCredits`);
    expect(change).toEqual({ before: 250, after: 300 });
    await page.goto(`${ADMIN_BASE_URL}/en/console/changes`);
    // Change history reads it through the card: the plan's name and the
    // editor's own words, never the stored path.
    await expect(page.getByTestId('change-row').first()).toContainText(
      'Simple E2E Plan: Monthly credits: 250 credits → 300 credits',
    );
    await expect(page.getByTestId('change-row').first()).not.toContainText(key);

    // Undo the last change: a new version that puts the plan back.
    await page.goto(`${ADMIN_BASE_URL}/en/console/plans`);
    await page.getByTestId(`area-undo-plans-${key}`).click();
    await expect(page.getByTestId('area-undo-changes')).toContainText('300 credits → 250 credits');
    await expectAccessible(page, 'undo');
    await page.getByTestId('area-undo-confirm').check();
    await page.getByTestId('area-undo-submit').click();
    await expect(page).toHaveURL(/ok=UNDONE/);
    await expect(card).toContainText('250');

    // Duplicate, then archive the copy.
    await page.getByTestId(`area-duplicate-plans-${key}`).click();
    await expect(page.getByTestId('field-key')).toHaveValue(`${key}-copy`);
    await page.getByTestId('area-check').click();
    await saveChange(page);
    await expect(page.getByTestId(`area-card-plans-${key}-copy`)).toBeVisible();
    await page.getByTestId(`area-archive-plans-${key}-copy`).click();
    await expectAccessible(page, 'archive');
    await page.getByTestId('area-archive-confirm').check();
    await page.getByTestId('area-archive-submit').click();
    await expect(page).toHaveURL(/ok=ARCHIVED/);
    await expect(page.getByTestId(`area-card-plans-${key}-copy-status`)).toHaveText('Archived');
    await expect(page.getByTestId(`area-archive-plans-${key}-copy`)).toHaveCount(0);
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

  test('a SEEDED feature is switched on for everyone, off for everyone, and back to its plan', async ({
    page,
  }) => {
    /*
     * `approvals.workflow` — Team approvals — is registered by
     * `seed-features.ts` with a grant on the Growth fixture plan, exactly as
     * the product matrix has it. No code path gates on it yet, so switching it
     * for everyone cannot disturb a suite running alongside this one.
     */
    const key = 'approvals.workflow';
    const access = page.getByTestId(`feature-${key}-access`);
    await signIn(page, 'en', { mode: 'simple' });
    await page.goto(`${ADMIN_BASE_URL}/en/console/features`);
    await discardLeftovers(page);
    await expect(page.getByTestId(`feature-${key}`)).toContainText('Team approvals');
    await expect(access).toHaveText('On for: Fixture Growth');

    const change = async (
      choice: 'everyone' | 'nobody' | 'plans',
      plans: readonly string[],
      review: string,
    ) => {
      await page.getByTestId(`feature-${key}-change`).click();
      await page.getByTestId(`feature-access-${choice}`).check();
      if (choice === 'plans') {
        for (const box of await page.locator('[data-testid^="feature-plan-"]').all()) {
          const planKey = ((await box.getAttribute('data-testid')) ?? '').replace(
            'feature-plan-',
            '',
          );
          if (plans.includes(planKey)) await box.check();
          else await box.uncheck();
        }
      }
      // Previewing is a GET: nothing has changed yet.
      await page.getByTestId('feature-preview').click();
      await expect(page.getByTestId('feature-review-lines')).toContainText(review);
      await page.getByTestId('feature-reason').fill(`End-to-end check: ${key} to ${choice}`);
      await page.getByTestId('feature-confirm').check();
      await page.getByTestId('feature-apply').click();
      await expect(page).toHaveURL(/ok=ACCESS_CHANGED/);
    };

    await change('everyone', [], 'on for every customer');
    await expect(access).toHaveText('On for everyone');

    await change('nobody', [], 'off for every customer');
    await expect(access).toHaveText('Off for everyone');

    // Back exactly as seeded: plan by plan, Growth only.
    await change('plans', ['fixture-growth'], 'Plans that will have it: Fixture Growth');
    await expect(access).toHaveText('On for: Fixture Growth');
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

// ---------------------------------------------------------------------------
// Control Center Simple mode (owner decision) — the owner's card pages
// ---------------------------------------------------------------------------

/** The testid suffix of the first card in a collection: the item's key. */
async function firstKey(page: Page, collection: string): Promise<string> {
  const id = await page
    .locator(`[data-testid^="area-card-${collection}-"]`)
    .first()
    .getAttribute('data-testid');
  return (id ?? '').replace(`area-card-${collection}-`, '');
}

test.describe('the owner card pages write through the Configuration Service', () => {
  test('Trial and credits: a new workspace’s credits are edited, previewed, saved, audited and undone', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await openArea(page, '/en/console/manage/trial');
    const key = await firstKey(page, 'trial');
    await page.getByTestId(`area-edit-trial-${key}`).click();
    const was = Number(await page.getByTestId('field-trialCredits').inputValue());
    await page.getByTestId('field-trialCredits').fill(String(was + 7));
    await page.getByTestId('area-check').click();
    await expect(page.getByTestId('area-preview-changes')).toContainText(
      `Trial credits: ${was} credits → ${was + 7} credits`,
    );
    await expect(page.getByTestId('area-preview-impacts')).toContainText(
      'Only workspaces created from now on',
    );
    await saveChange(page);
    expect(await lastActivationChange(`plans[${key}].trialCredits`)).toEqual({
      before: was,
      after: was + 7,
    });

    // SAME SERVICE: Advanced lists the version Simple activated, with its reason.
    await useMode(page, 'advanced');
    await page.goto(`${ADMIN_BASE_URL}/en/console/configuration?domain=plans`);
    await expect(page.locator('main')).toContainText('changed in Simple mode');
    await useMode(page, 'simple');

    await page.goto(`${ADMIN_BASE_URL}/en/console/manage/trial`);
    await page.getByTestId(`area-undo-trial-${key}`).click();
    await page.getByTestId('area-undo-confirm').check();
    await page.getByTestId('area-undo-submit').click();
    await expect(page).toHaveURL(/ok=UNDONE/);
    expect(await lastActivationChange(`plans[${key}].trialCredits`)).toEqual({
      before: was + 7,
      after: was,
    });
  });

  test('a change refused on its second document says what was saved and finishes on "Try again"', async ({
    page,
  }) => {
    // D-558: a plan and its features are two activations. When the second is
    // refused, the first stays; the owner is told exactly which part is
    // missing and can try that part again.
    await signIn(page, 'en', { mode: 'simple' });
    await openArea(page, '/en/console/plans');
    const key = `e2e-pt-${randomUUID().slice(0, 8)}`;
    await page.getByTestId('area-new-plans').click();
    await page.getByTestId('field-key').fill(key);
    await page.getByTestId('field-nameEn').fill('Partial E2E Plan');
    await page.getByTestId('field-nameAr').fill('خطة الحفظ الجزئي');
    await page.getByTestId('field-availability').selectOption('draft');
    await page.locator('[data-testid^="field-priceMonthly-"]').first().fill('9.00');
    await page.getByTestId('field-monthlyCredits').fill('250');
    await page.getByTestId('area-check').click();
    await saveChange(page);
    const card = page.getByTestId(`area-card-plans-${key}`);
    await expect(card).toContainText('Partial E2E Plan');

    // One edit that writes both documents: more credits, and a feature.
    await page.getByTestId(`area-edit-plans-${key}`).click();
    await page.getByTestId('field-monthlyCredits').fill('275');
    const feature = page.locator('[data-testid^="field-features-"]').first();
    const featureName = (await feature.locator('xpath=..').innerText()).trim();
    await feature.check();
    await page.getByTestId('area-check').click();

    // Meanwhile, someone opens an unfinished change to the features in Advanced.
    const other = await page.context().newPage();
    await other.goto(`${ADMIN_BASE_URL}/en/console/configuration`);
    await useMode(other, 'advanced');
    await other.getByTestId('domain-entitlements').click();
    await other.getByTestId('draft-reason').fill('A change to feature access left open');
    await other.getByTestId('create-draft').click();
    await expect(other.getByTestId('config-ok')).toContainText('Draft created');
    await useMode(other, 'simple');
    await other.close();

    // Saved: the plan. Not saved: its features. One message, one button.
    await page.getByTestId('area-preview-confirm').check();
    await page.getByTestId('area-preview-submit').click();
    await expect(page).toHaveURL(/partial=1/);
    const notice = page.getByTestId('area-partial');
    await expect(notice).toContainText('Only part of this change was saved');
    await expect(page.getByTestId('area-partial-saved')).toHaveText(
      'Saved: the plan itself — its name, prices, trial, credits and limits.',
    );
    await expect(page.getByTestId('area-partial-not-saved')).toHaveText(
      'Not saved: which features the plan includes.',
    );
    await expect(page.getByTestId('area-partial-why')).toContainText(
      'an unfinished change to it is open in Advanced',
    );
    await expectAccessible(page, 'the partial-save message');
    await expect(card).toContainText('275');
    await expect(card).not.toContainText(featureName);

    // Trying again while the other change is still open is refused the same way.
    await page.getByTestId('area-partial-retry').click();
    await expect(page).toHaveURL(/partial=1&error=DRAFT_OPEN/);
    await expect(notice).toBeVisible();

    // With it gone, "Try the second part again" saves the missing part only.
    await discardLeftovers(page);
    await expect(notice).toBeVisible();
    await page.getByTestId('area-partial-retry').click();
    await expect(page).toHaveURL(/ok=PART_DONE/);
    await expect(page.getByTestId('area-partial')).toHaveCount(0);
    await expect(card).toContainText(featureName);
    await expect(card).toContainText('275');
  });

  test('Content: an industry and a country’s posting times are added, edited and removed', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await openArea(page, '/en/console/manage/content');
    const key = `e2e-ind-${randomUUID().slice(0, 6)}`;
    await page.getByTestId('area-new-industries').click();
    await page.getByTestId('field-key').fill(key);
    await page.getByTestId('field-nameEn').fill('Test industry');
    await page.getByTestId('field-nameAr').fill('مجال تجريبي');
    await page.getByTestId('area-check').click();
    await expect(page.getByTestId('area-preview-impacts')).toContainText(
      'Customers can now choose this industry.',
    );
    await saveChange(page);
    await expect(page.getByTestId(`area-card-industries-${key}`)).toContainText('Test industry');

    await page.getByTestId(`area-edit-industries-${key}`).click();
    // The short name cannot change and is the platform's own key: an edit leaves it out.
    await expect(page.getByTestId('field-key')).toHaveCount(0);
    await page.getByTestId('field-nameEn').fill('Renamed industry');
    await page.getByTestId('area-check').click();
    await saveChange(page);
    await expect(page.getByTestId(`area-card-industries-${key}`)).toContainText('Renamed industry');

    await page.getByTestId(`area-archive-industries-${key}`).click();
    await expect(page.getByTestId('area-archive-impacts')).toContainText(
      'Brands that chose it keep it',
    );
    await page.getByTestId('area-archive-confirm').check();
    await page.getByTestId('area-archive-submit').click();
    await expect(page).toHaveURL(/ok=ARCHIVED/);
    await expect(page.getByTestId(`area-card-industries-${key}`)).toHaveCount(0);

    await page.getByTestId('area-new-times').click();
    await page.getByTestId('field-country').fill('xq');
    await page.getByTestId('field-times').fill('18:00, 09:30');
    await page.getByTestId('area-check').click();
    await saveChange(page);
    await expect(page.getByTestId('area-card-times-XQ')).toContainText('09:30, 18:00');
    await page.getByTestId('area-archive-times-XQ').click();
    await page.getByTestId('area-archive-confirm').check();
    await page.getByTestId('area-archive-submit').click();
    await expect(page.getByTestId('area-card-times-XQ')).toHaveCount(0);
  });

  test('Legal pages: the reviewed mark is set and undone', async ({ page }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await openArea(page, '/en/console/manage/legal');
    const key = await firstKey(page, 'documents');
    const status = page.getByTestId(`area-card-documents-${key}-status`);
    const before = (await status.textContent()) ?? '';
    await page.getByTestId(`area-edit-documents-${key}`).click();
    await page.getByTestId('field-reviewed').click();
    await page.getByTestId('area-check').click();
    await saveChange(page);
    await expect(status).not.toHaveText(before);
    await page.getByTestId(`area-undo-documents-${key}`).click();
    await page.getByTestId('area-undo-confirm').check();
    await page.getByTestId('area-undo-submit').click();
    await expect(page).toHaveURL(/ok=UNDONE/);
    await expect(status).toHaveText(before);
  });

  test('the editor and its preview read right to left in Arabic, with Arabic help, and pass axe', async ({
    page,
  }) => {
    await signIn(page, 'ar', { mode: 'simple' });
    await openArea(page, '/ar/console/manage/trial');
    await page.locator('[data-testid^="area-edit-trial-"]').first().click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('area-editor')).toContainText('رصيد التجربة');
    await expect(page.getByTestId('field-trialCredits-impact')).toContainText(
      'مساحات العمل الجديدة',
    );
    await expectAccessible(page, 'ar editor');
    await page.getByTestId('area-check').click();
    await expect(page.getByTestId('area-preview')).toContainText('راجِع قبل الحفظ');
    await expectAccessible(page, 'ar preview');
  });

  test('a value that does not fit is refused in plain words, and nothing is saved', async ({
    page,
  }) => {
    await signIn(page, 'en', { mode: 'simple' });
    const versions = () =>
      withPlatformPrisma((prisma) =>
        prisma.configurationVersion.count({ where: { status: 'ACTIVE' } }),
      );
    const before = await versions();

    await openArea(page, '/en/console/plans');
    await page.getByTestId('area-new-plans').click();
    await page.getByTestId('field-key').fill('Not A Key');
    await page.getByTestId('area-check').click();
    await expect(page.getByTestId('area-field-errors')).toContainText('use small English letters');
    await expect(page.getByTestId('area-preview-submit')).toHaveCount(0);

    await page.goto(`${ADMIN_BASE_URL}/en/console/manage/signups`);
    await page.getByTestId('area-edit-signups-signups').click();
    await page.getByTestId('field-minPasswordLength').fill('7');
    await page.getByTestId('area-check').click();
    await expect(page.getByTestId('area-field-errors')).toContainText(
      'Shortest password: it must be at least 8.',
    );

    await page.goto(`${ADMIN_BASE_URL}/en/console/manage/trial`);
    await page.locator('[data-testid^="area-edit-trial-"]').first().click();
    await page.getByTestId('field-trialCredits').fill('-5');
    await page.getByTestId('area-check').click();
    await expect(page.getByTestId('area-field-errors')).toContainText(
      'please enter a whole number',
    );

    // An area rule the fields cannot see: scanning cannot be required while off.
    await page.goto(`${ADMIN_BASE_URL}/en/console/manage/uploads`);
    await page.getByTestId('area-edit-scanning-scanning').click();
    await page.getByTestId('field-provider').selectOption('none');
    await page.getByTestId('field-required').check();
    await page.getByTestId('area-check').click();
    await expect(page.getByTestId('area-preview-problems')).toContainText(
      'cannot be required to pass a scan',
    );
    await expect(page.getByTestId('area-preview-submit')).toHaveCount(0);

    // And a channel with posts cannot be hidden — the card says why, before anyone tries.
    await page.goto(`${ADMIN_BASE_URL}/en/console/manage/channels`);
    await expect(
      page.locator('[data-testid^="area-archive-blocked-channels-"]').first(),
    ).toContainText('cannot be hidden');

    expect(await versions()).toBe(before);
  });
});

/**
 * NO STORED KEY ON AN OWNER PAGE (owner review of the card pages).
 *
 * A plan reads by the name customers see, a limit by its plain name, a
 * configuration document by what it is about — on Home, on every card page
 * and its "Changed by your developer" list, in an editor of each area and in
 * Change history. The words that would leak: every configuration document's
 * id, every plan key the platform stores, and the stored names of plan limits.
 * In Arabic none of them may appear at all; in English the ids that are also
 * ordinary words ("plans", "content", "brands") are left to the reader.
 */
const DOMAIN_IDS = [
  'ai.providers',
  'ai.models',
  'ai.routing',
  'ai.credit-rules',
  'ai.capability-routing',
  'ai.budgets',
  'plans',
  'entitlements',
  'feature-flags',
  'credits',
  'beta-cohorts',
  'usage-limits',
  'brand-brain',
  'assets',
  'content',
  'integrations.email',
  'integrations.storage',
  'integrations.payment',
  'integrations.observability',
  'integrations.social-apps',
  'publishing',
  'analytics',
  'copilot',
  'automations',
  'templates',
  'website',
  'operations',
  'commerce',
  'onboarding',
];
const QUOTA_KEYS = [
  'seats',
  'brands',
  'workspaces',
  'socialAccounts',
  'scheduledPostsPerMonth',
  'storageGb',
  'analyticsRetentionDays',
  'automationAiActionsPerMonth',
  'trialAutomationAiActionsPerMonth',
];
/** A stored id that is also an ordinary English word can't be told apart in English. */
const PLAIN_WORD = /^[a-z]+$/;

async function storedPlanKeys(): Promise<readonly string[]> {
  return withPlatformPrisma(async (prisma) => {
    const versions = await prisma.configurationVersion.findMany({
      where: { domain: 'plans' },
      select: { payload: true },
    });
    const keys = versions.flatMap((version) => {
      const list = (version.payload as { plans?: { key?: unknown }[] } | null)?.plans ?? [];
      return list.map((plan) => plan.key).filter((key): key is string => typeof key === 'string');
    });
    return [...new Set(keys)];
  });
}

function leaks(text: string, words: readonly string[]): string[] {
  return words.filter((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w.-])${escaped}(?![\\w-])`).test(text);
  });
}

test.describe('Simple pages never show a stored key', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`no plan key, document id or limit key on any Simple page (${locale})`, async ({
      page,
    }) => {
      const planKeys = await storedPlanKeys();
      expect(planKeys.length).toBeGreaterThan(0);
      const words = [
        ...planKeys,
        ...DOMAIN_IDS.filter((id) => locale === 'ar' || !PLAIN_WORD.test(id)),
        ...QUOTA_KEYS.filter((key) => locale === 'ar' || !PLAIN_WORD.test(key)),
      ];
      await signIn(page, locale, { mode: 'simple' });
      const check = async (label: string) => {
        // A change's reason is what the person who made it wrote, in their own
        // words; it is quoted, not rendered from a key, so it is not read here.
        const text = await page.locator('main').evaluate((main) => {
          const copy = main.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('[data-testid="change-reason"]').forEach((node) => node.remove());
          document.body.append(copy);
          const shown = copy.innerText;
          copy.remove();
          return shown;
        });
        expect(leaks(text, words), `${locale} ${label}`).toEqual([]);
      };
      for (const screen of SIMPLE_SCREENS) {
        await page.goto(`${ADMIN_BASE_URL}/${locale}${screen.path}`);
        await expect(page.getByTestId(screen.marker), screen.path).toBeVisible();
        await check(screen.path);
        // One editor of every card page, read the same way.
        const edit = page.locator('[data-testid^="area-edit-"]').first();
        if (screen.path.startsWith('/console/manage/') || screen.path === '/console/plans') {
          if ((await edit.count()) > 0) {
            await edit.click();
            await expect(page.getByTestId('area-editor')).toBeVisible();
            await check(`${screen.path} editor`);
          }
        }
      }
    });
  }

  test('the Home rows and "Changed by your developer" read in plain words', async ({ page }) => {
    await signIn(page, 'en', { mode: 'simple' });
    await page.goto(`${ADMIN_BASE_URL}/en/console/plans`);
    const developer = page.getByTestId('area-developer');
    await expect(developer).toContainText('Fixture Starter:');
    await expect(developer).toContainText('Tax is added on top');
    await expect(developer).not.toContainText('exclusive');
    await page.goto(`${ADMIN_BASE_URL}/ar/console/plans`);
    await expect(page.getByTestId('area-developer')).toContainText('تُضاف الضريبة إلى السعر');
  });
});

test.describe('the Home grid heading is never under the top bar', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`"Manage your platform" scrolled to sits fully below the bar at 1536x864 (${locale})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1536, height: 864 });
      await signIn(page, locale, { mode: 'simple' });
      await page.goto(`${ADMIN_BASE_URL}/${locale}/console`);
      const grid = page.getByTestId('manage-grid');
      const heading = grid.getByRole('heading', { level: 2 }).first();
      // Both ways a page is brought to a section: the browser's own scroll to
      // an element, and Playwright's (what a reviewer's capture does).
      for (const bring of ['scrollIntoView', 'playwright'] as const) {
        await page.evaluate(() => document.querySelector('.bs-panel')?.scrollTo(0, 0));
        if (bring === 'scrollIntoView') {
          await grid.evaluate((section) => section.scrollIntoView({ block: 'start' }));
        } else {
          await grid.scrollIntoViewIfNeeded();
        }
        const bar = await page.locator('.bs-topbar').boundingBox();
        const box = await heading.boundingBox();
        expect(bar && box, bring).toBeTruthy();
        // The bar fades out over 0.75rem (12px) below its box; the heading clears that too.
        const fade = await page
          .locator('.bs-topbar')
          .evaluate((bar) => parseFloat(getComputedStyle(bar, '::after').height) || 0);
        expect(box!.y, `${locale} ${bring}: heading top below the bar`).toBeGreaterThanOrEqual(
          bar!.y + bar!.height + fade - 0.5,
        );
        // Nothing paints over it: the point at its middle belongs to the heading.
        const own = await heading.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 2);
          return hit !== null && node.contains(hit);
        });
        expect(own, `${locale} ${bring}: heading not covered`).toBe(true);
      }
    });
  }
});

test.describe('Simple shows only what the reader may do', () => {
  async function signInOperator(page: Page, locale: 'en' | 'ar'): Promise<void> {
    const operator = credentials().operator;
    if (!operator)
      throw new Error('No read-only operator in the end-to-end credentials: run `pnpm e2e:seed`.');
    await page.goto(`${ADMIN_BASE_URL}/${locale}/login`);
    await page.getByTestId('email').fill(operator.email);
    await page.getByTestId('password').fill(operator.password);
    await page.getByTestId('submit').click();
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/${locale}/mfa`);
    await page.getByTestId('mfa-code').fill(totpCode(operator.totpSecret));
    await page.getByTestId('submit').click();
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/${locale}/console`);
  }

  test('a read-only operator sees the cards, never a change control, and no editor by URL', async ({
    page,
  }) => {
    await signInOperator(page, 'en');
    for (const path of ['/manage/trial', '/plans', '/manage/content']) {
      await page.goto(`${ADMIN_BASE_URL}/en/console${path}`);
      await expect(page.getByTestId('area-read-only')).toBeVisible();
      await expect(page.locator('[data-testid^="area-edit-"]')).toHaveCount(0);
      await expect(page.locator('[data-testid^="area-new-"]')).toHaveCount(0);
      await expect(page.locator('[data-testid^="area-undo-"]')).toHaveCount(0);
    }
    await page.goto(`${ADMIN_BASE_URL}/en/console/manage/trial?view=edit&c=trial`);
    await expect(page.getByTestId('area-editor')).toHaveCount(0);
    await page.goto(`${ADMIN_BASE_URL}/en/console/plans?view=edit&c=plans&mode=new`);
    await expect(page.getByTestId('area-editor')).toHaveCount(0);
    // No `platform.user.read`: the Team page is neither listed nor opened.
    await expect(page.getByTestId('nav-nav.team')).toHaveCount(0);
    await expect(page.getByTestId('nav-nav.changes')).toHaveCount(1);
    const team = await page.goto(`${ADMIN_BASE_URL}/en/console/team`);
    expect(team?.status()).toBe(404);
  });
});

test.describe('the Control Center sign-in is the customer entry card', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`sign-in and second step, uniform failures, the Control Center label (${locale})`, async ({
      page,
    }) => {
      const label = locale === 'ar' ? 'مركز التحكم' : 'Control Center';
      const invalid = locale === 'ar' ? 'بيانات الدخول غير صحيحة.' : 'Invalid credentials.';
      await page.goto(`${ADMIN_BASE_URL}/${locale}/login`);
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('platform-auth-card')).toHaveClass(/bsp-auth-card/);
      await expect(page.getByTestId('auth-realm')).toHaveText(label);
      await expect(page.getByTestId('auth-brand-mark')).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await expectAccessible(page, `${locale}/login`);

      // The language button keeps the screen.
      const other = locale === 'ar' ? 'en' : 'ar';
      await expect(page.getByTestId('locale-switch')).toHaveAttribute('href', `/${other}/login`);

      // An unknown address and a wrong password read exactly the same.
      const { email } = credentials();
      for (const who of [`nobody-${randomUUID().slice(0, 6)}@example.test`, email]) {
        await page.goto(`${ADMIN_BASE_URL}/${locale}/login`);
        await page.getByTestId('email').fill(who);
        await page.getByTestId('password').fill('not-the-password');
        await page.getByTestId('submit').click();
        await expect(page.getByTestId('login-error')).toHaveText(invalid);
      }

      // The second step is mandatory, in the same card.
      const { password } = credentials();
      await page.goto(`${ADMIN_BASE_URL}/${locale}/login`);
      await page.getByTestId('email').fill(email);
      await page.getByTestId('password').fill(password);
      await page.getByTestId('submit').click();
      await expect(page).toHaveURL(`${ADMIN_BASE_URL}/${locale}/mfa`);
      await expect(page.getByTestId('platform-auth-card')).toHaveClass(/bsp-auth-card/);
      await expect(page.getByTestId('auth-realm')).toHaveText(label);
      await expectAccessible(page, `${locale}/mfa`);
      await page.getByTestId('mfa-code').fill('000000');
      await page.getByTestId('submit').click();
      await expect(page.getByTestId('mfa-error')).toHaveText(
        locale === 'ar' ? 'رمز التحقق غير صحيح.' : 'Invalid verification code.',
      );
    });
  }
});
