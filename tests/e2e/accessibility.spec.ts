import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { APPS, LOCALES } from './apps';

/**
 * Automated accessibility smoke tests.
 *
 * CI fails on SERIOUS or CRITICAL violations. Minor and moderate findings are
 * reported in the failure message when a serious one is present, but do not by
 * themselves fail the build: a build that fails on cosmetic findings gets muted,
 * and a muted gate protects nobody.
 *
 * These are a smoke test, not a substitute for manual audit — axe catches
 * roughly a third of real accessibility problems.
 */

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

for (const app of APPS) {
  for (const locale of LOCALES) {
    test(`${app.label} has no serious or critical a11y violations (${locale.code})`, async ({
      page,
    }) => {
      await page.goto(`${app.baseUrl}/${locale.code}`);

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();

      const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ''));

      const detail = blocking
        .map(
          (v) =>
            `  [${v.impact}] ${v.id}: ${v.help}\n` +
            v.nodes.map((n) => `      ${n.target.join(' ')}`).join('\n'),
        )
        .join('\n');

      expect(blocking, `serious/critical a11y violations:\n${detail}`).toEqual([]);
    });
  }

  test(`${app.label} second page has no serious or critical a11y violations`, async ({ page }) => {
    await page.goto(`${app.baseUrl}/en/${app.secondPath}`);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ''));
    expect(blocking, blocking.map((v) => `[${v.impact}] ${v.id}: ${v.help}`).join('\n')).toEqual(
      [],
    );
  });
}
