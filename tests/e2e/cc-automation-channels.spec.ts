import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';

/**
 * CONTROL CENTER SIMPLE MODE, ITEM 3 — THE AUTOMATIONS CHANNEL LIST IS THE
 * STUDIO'S. The "Post to" chips and the "Channel" condition both read
 * `content.platforms`, so an automation can only be written for a channel a
 * post can go to. Compared by the names a customer reads, in both languages.
 */

async function studioChannels(page: Page, locale: string): Promise<string[]> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose`);
  const chips = page.getByTestId('content-channel');
  await expect(chips.first()).toBeVisible();
  return (await chips.allInnerTexts()).map((text) => text.trim()).sort();
}

async function automationChannels(page: Page, locale: string): Promise<string[]> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations?new=1`);
  await page.getByTestId('automation-trigger-CONTENT_APPROVED').check();
  await page.getByTestId('automation-condition-field-content.channels').check();
  const options = page.getByTestId('automation-condition-value').locator('option:not([value=""])');
  await expect(options.first()).toBeAttached();
  return (await options.allInnerTexts()).map((text) => text.trim()).sort();
}

for (const locale of ['en', 'ar'] as const) {
  test(`the Automations channel condition offers exactly the Studio's channels (${locale})`, async ({
    page,
  }) => {
    const ws = await ownWorkspace(`cc-channels-${locale}`);
    await enter(page, ws.slug, locale);
    const studio = await studioChannels(page, locale);
    expect(studio.length).toBeGreaterThan(0);
    expect(await automationChannels(page, locale)).toEqual(studio);
  });
}
