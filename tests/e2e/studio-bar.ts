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
