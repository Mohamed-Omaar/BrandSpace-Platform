import type { Page } from '@playwright/test';

/**
 * Review of #67, round 3 (B6) — the rule's name and brand sit under the
 * dialog's "⋯", as the prototype's builder draws neither. Opened only when it
 * is closed (an edited rule opens with it open).
 */
export async function openRuleMore(page: Page): Promise<void> {
  const more = page.getByTestId('automation-more').first();
  const open = await more.evaluate((details) => (details as HTMLDetailsElement).open);
  if (!open) await more.locator('summary').click();
}
