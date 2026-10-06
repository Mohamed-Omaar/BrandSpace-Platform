import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * ROUND 4, GATE 2b — THE NOT PORTED PAGES, AS THE PROTOTYPE DRAWS THEM: the
 * campaign room as one page, Strategy's period switch, hero and plan, and
 * Look & voice's tiles, swatches and font chips. Each test checks the
 * prototype's composition and that the product's own control is still the
 * one that acts.
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
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  const choose = page.getByTestId(`choose-workspace-${customer.workspaceSlug}`);
  if (await choose.isVisible().catch(() => false)) await choose.click();
  await page.waitForURL(/\/en\/overview$/);
}

test.describe('Round 4 · Gate 2b — the NOT PORTED pages', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('Campaign room: a paused campaign says what pausing does, and "⋯" opens the other views', async ({
    page,
  }) => {
    const loaded = credentials();
    const campaignId = await withPlatformPrisma(async (prisma) => {
      const campaign = await prisma.campaign.create({
        data: {
          workspaceId: loaded.customer.workspaceId,
          brandId: brandFixtures(loaded).primaryBrandId,
          name: `Paused ${randomUUID().slice(0, 6)}`,
          objective: 'LAUNCH',
          status: 'PAUSED',
          channels: ['instagram'],
        },
        select: { id: true },
      });
      return campaign.id;
    });
    try {
      await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns/${campaignId}`);
      await expect(page.getByTestId('campaign-paused-banner')).toHaveText(
        'Pausing marks the campaign as paused. Posts already scheduled still go out.',
      );
      // No posts yet: the results card says so, and the head's "+ New post" adds one.
      await expect(page.getByTestId('campaign-content-empty')).toHaveText('No posts yet');
      await page.getByTestId('campaign-more').click();
      await page.getByTestId('campaign-view-performance').click();
      await page.waitForURL((url) => url.searchParams.get('tab') === 'performance');
      // On another view the strip moves between the views and back.
      await expect(
        page.getByTestId('campaign-tabs').getByRole('link', { name: 'Overview' }),
      ).toBeVisible();
    } finally {
      await withPlatformPrisma((prisma) =>
        prisma.campaign.update({
          where: { id: campaignId },
          data: { status: 'ARCHIVED', deletedAt: new Date() },
        }),
      );
    }
  });

  test('Strategy: the period switch, the plan on "This strategy", the draft form on "Next strategy"', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/strategy`);
    const views = page.getByTestId('strategy-views');
    await expect(views.getByRole('link')).toHaveCount(2);
    await expect(page.getByTestId('strategy-view-current')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('strategy-objective')).toBeVisible();
    await expect(page.getByTestId('strategy-brain')).toContainText('Built on Brand Brain');
    await expect(page.getByTestId('strategy-pillars')).toBeVisible();
    // The proposal form is not on this view.
    await expect(page.getByTestId('strategy-form')).toHaveCount(0);

    await page.getByTestId('strategy-view-next').click();
    await page.waitForURL((url) => url.searchParams.get('view') === 'next');
    await expect(
      page.getByText('Choose where to start. Nothing goes live until you approve it.'),
    ).toBeVisible();
    await expect(page.getByTestId('strategy-form')).toBeVisible();
    await expect(page.getByTestId('strategy-suggestions')).toBeVisible();
    // Nothing the owner left out is drawn.
    await expect(page.getByText('Early signals')).toHaveCount(0);
  });

  test('Look & voice: the logo card, the swatches and the font chips with their sample', async ({
    page,
  }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain?tab=look`);
    await expect(page.getByTestId('look-logo')).toBeVisible();
    const colours = page.getByTestId('look-colours');
    await expect(colours.locator('.bsp-lk-sw-add, .bsp-lk-sw-tile').first()).toBeVisible();
    const chips = page.getByTestId('look-slot-select-en-heading');
    await expect(chips).toHaveAttribute('role', 'radiogroup');
    expect(await chips.getByRole('radio').count()).toBeGreaterThan(1);
    // Exactly one face is chosen per slot, and the sample is drawn in it.
    await expect(chips.getByRole('radio', { checked: true })).toHaveCount(1);
    const unchosen = chips
      .locator('label:not(:has(input:checked)):has(input[value^="catalogue:"])')
      .first();
    const value = (await unchosen.locator('input').getAttribute('value')) ?? '';
    await unchosen.click();
    await expect(page.getByTestId('look-slot-preview-en-heading')).toHaveAttribute(
      'data-font-family',
      `bsf-${value.replace(/^catalogue:/, '')}`,
    );
    // The brand templates card is left out.
    await expect(page.getByText(/templates/i)).toHaveCount(0);
  });
});
