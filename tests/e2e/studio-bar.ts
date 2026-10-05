import type { Page } from '@playwright/test';

/**
 * REVIEW OF #67, ROUND 2 — the Studio's own controls the prototype does not
 * draw ("Save edit", the first comment, the tone, "Save as template", Archive)
 * are under the sticky bar's "⋯". Opens it, and leaves it open if it already is.
 */
export async function openStudioMore(page: Page): Promise<void> {
  const face = page.getByTestId('editor-bar-more');
  const open = await face.evaluate((summary) => (summary.parentElement as HTMLDetailsElement).open);
  if (!open) await face.click();
}

/**
 * Review of #67, round 3 (C1) — the post's notes are a compact card under the
 * preview; its conversation opens in place.
 */
export async function openStudioNotes(page: Page): Promise<void> {
  const card = page.getByTestId('studio-notes');
  const open = await card.evaluate((details) => (details as HTMLDetailsElement).open);
  if (!open) await page.getByTestId('studio-notes-open').click();
}
