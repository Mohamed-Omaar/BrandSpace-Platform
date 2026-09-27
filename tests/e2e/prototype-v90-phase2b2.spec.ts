import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v90, Phase 2B-2 — templates, publishing defaults, the Studio and
 * rescheduling a failed post, as a person meets them in a real browser.
 *
 * EVERY TEST THAT CHANGES SETTINGS CREATES ITS OWN WORKSPACE with one brand,
 * so nothing another suite reads moves, and runs once (the desktop project).
 * The rules themselves are proven against PostgreSQL in tests/isolation.
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

/** A workspace of its own, owned by the e2e customer, with one ACTIVE brand. */
async function ownWorkspace(label: string): Promise<{ slug: string; brandId: string }> {
  const { customer } = credentials();
  const slug = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  const brandId = randomUUID();
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    const role = await prisma.role.findFirstOrThrow({
      where: { key: 'workspace_owner', workspaceId: null },
      select: { id: true },
    });
    const id = randomUUID();
    await prisma.workspace.create({
      data: {
        id,
        workspaceId: id,
        slug,
        name: `E2E ${label} ${slug.slice(-8)}`,
        ownerUserId: owner.id,
        status: 'ACTIVE',
        country: 'US',
        defaultLocale: 'EN',
        timezone: 'UTC',
        currency: 'USD',
      },
    });
    await prisma.membership.create({
      data: {
        workspaceId: id,
        userId: owner.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
    await prisma.brand.create({
      data: {
        id: brandId,
        workspaceId: id,
        slug: `${slug}-brand`,
        name: `${label} Brand`,
        status: 'ACTIVE',
      },
    });
  });
  return { slug, brandId };
}

async function enter(page: Page, slug: string): Promise<void> {
  await signIn(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
  await page.click(`[data-testid="choose-workspace-${slug}"]`);
  await page.waitForURL(/\/en\/overview$/);
}

async function noSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test.describe('A8 · Settings → Publishing defaults, under the save bar', () => {
  test('channels, time and first-comment hashtags save, in both languages', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId } = await ownWorkspace('publishing');
    await enter(page, slug);

    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/publishing`);
    const bar = page.getByTestId(`publishing-defaults-bar-${brandId}`);
    await expect(bar).toHaveAttribute('data-state', 'clean');
    // No link tracking here (Q15).
    await expect(page.getByText(/link tracking/i)).toHaveCount(0);

    const channels = page.locator(`[data-testid^="publishing-default-channel-${brandId}-"]`);
    await expect(channels.first()).toBeVisible();
    await channels.first().check();
    await page.getByTestId(`publishing-default-time-${brandId}`).fill('10:30');
    await page.getByTestId(`publishing-default-hashtags-${brandId}`).check();
    await expect(bar).toHaveAttribute('data-state', 'dirty');
    await page.getByTestId(`publishing-defaults-save-${brandId}`).click();
    await page.waitForURL(/ok=SETTINGS_SAVED/);

    await expect(page.getByTestId(`publishing-defaults-bar-${brandId}`)).toHaveAttribute(
      'data-state',
      'clean',
    );
    await expect(page.getByTestId(`publishing-default-time-${brandId}`)).toHaveValue('10:30');
    await expect(page.getByTestId(`publishing-default-hashtags-${brandId}`)).toBeChecked();
    await expect(channels.first()).toBeChecked();
    await noSeriousViolations(page);

    await page.goto(`${DASHBOARD_BASE_URL}/ar/settings/publishing`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId(`publishing-defaults-${brandId}`)).toBeVisible();
    await noSeriousViolations(page);
  });
});

test.describe('E4 / B2 · a post template: saved, made default, and used by a new post', () => {
  test('the composer starts from the default template and the draft keeps its hashtags', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId } = await ownWorkspace('templates');
    await enter(page, slug);

    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/publishing`);
    await expect(page.getByTestId(`templates-empty-${brandId}`)).toBeVisible();
    await page.getByTestId(`template-name-${brandId}`).fill('Weekly offer');
    await page.getByTestId(`template-format-${brandId}`).selectOption('POST');
    const channel = page.locator(`[data-testid^="template-channel-${brandId}-"]`).first();
    const platformKey = ((await channel.getAttribute('data-testid')) ?? '').split('-').pop() ?? '';
    await channel.check();
    await page.getByTestId(`template-body-${brandId}`).fill('This week only: our offer.');
    await page.getByTestId(`template-hashtags-${brandId}`).fill('#offer #weekly');
    await expect(page.getByTestId(`template-default-new-${brandId}`)).toBeChecked();
    await page.getByTestId(`template-save-${brandId}`).click();
    await page.waitForURL(/ok=TEMPLATE_SAVED/);

    await expect(page.getByTestId(`templates-${brandId}`)).toContainText('Weekly offer');
    await expect(
      page.locator(
        '[data-testid^="template-default-"]:not([data-testid^="template-default-new-"])',
      ),
    ).toHaveCount(1);

    // A new post, written by hand, starts from the default template.
    await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=write`);
    const picker = page.getByTestId('content-template');
    await expect(picker).toBeVisible();
    await expect(picker.locator('option:checked')).toContainText('Weekly offer');
    await expect(page.getByTestId('content-brief')).toHaveValue('This week only: our offer.');
    await expect(
      page.locator(`[data-testid="content-channel"][data-platform="${platformKey}"]`),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('content-write-manual').click();
    await page.waitForURL(/\/en\/content\/compose\?item=/);

    // The template's hashtags reached the saved draft, as its editor shows them.
    await expect(page.getByTestId(`content-hashtags-${platformKey}`)).toHaveValue(
      /#?offer[ ,]+#?weekly/,
    );

    // Deleting asks twice.
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/publishing`);
    const deletion = page.locator('[data-testid^="template-delete-"]').first();
    await deletion.locator('summary').click();
    await deletion.locator('[data-testid^="template-delete-confirm-"]').click();
    await page.waitForURL(/ok=TEMPLATE_DELETED/);
    await expect(page.getByTestId(`templates-empty-${brandId}`)).toBeVisible();
  });
});

test.describe('D7 · AI suggestions off hides the Home recommendations card only', () => {
  test('Settings → AI switches the card off for the brand', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId } = await ownWorkspace('suggestions');
    await enter(page, slug);
    await expect(page.getByTestId('home-recommended')).toBeVisible();

    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);
    await page.getByTestId(`ai-suggestions-${brandId}`).uncheck();
    await page.getByTestId(`ai-save-${brandId}`).click();
    await page.waitForURL(/ok=SETTINGS_SAVED/);
    await expect(page.getByTestId(`ai-suggestions-${brandId}`)).not.toBeChecked();

    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page.getByTestId('home-recommended')).toHaveCount(0);
  });
});
