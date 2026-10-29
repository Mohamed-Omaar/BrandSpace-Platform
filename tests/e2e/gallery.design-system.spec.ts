import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL } from './apps';

/**
 * The S1 styling ratchet: a committed screenshot of every component family and
 * every token group, in English and Arabic, in both looks.
 *
 * The routes are `/[locale]/design-system/components` and
 * `/[locale]/design-system/tokens` — fixtures only, no database, refused in
 * production (see `design-system/page.tsx`). Hover and focus are not faked in
 * the page; this spec performs them before the shot.
 *
 * Baselines live in `gallery.design-system.spec.ts-snapshots/`.
 *
 * CI RENDERS THE BASELINES (owner rule, 2026-10-28). A baseline is never
 * generated on a developer machine or in a remote container: even with the
 * same Chromium build, a different system's font rasteriser changes glyph edges
 * by more than the tolerance on text-dense sections (it did, on PR #93). When a
 * baseline must change — only for an intended, reviewed visual change — take
 * the `*-actual.png` from that run's `playwright-report-shard-2` artifact
 * (`test-results/<test>/`) and commit it under the baseline's name. Pixel checks
 * for later steps of the programme are read from CI, not from a local run.
 */

const FAMILIES = [
  'button',
  'input',
  'select',
  'checkbox',
  'card',
  'badge',
  'dialog',
  'backdrop',
  'tooltip',
  'table',
  'empty',
  'nav',
] as const;

const TOKEN_GROUPS = [
  'colors',
  'shadows',
  'radius',
  'spacing',
  'motion',
  'zindex',
  'fonts',
] as const;

const LOCALES = ['en', 'ar'] as const;
const COMPONENTS = (locale: string) => `${DASHBOARD_BASE_URL}/${locale}/design-system/components`;
const TOKENS = (locale: string) => `${DASHBOARD_BASE_URL}/${locale}/design-system/tokens`;

const SHOT = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 } as const;

test.use({ viewport: { width: 1536, height: 864 } });

/** Fail on serious and critical axe violations only (F-04a). */
async function expectNoBlockingA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.map((violation) => `${violation.id}: ${violation.help}`),
    `axe violations on ${label}`,
  ).toEqual([]);
}

async function open(page: Page, url: string): Promise<void> {
  const response = await page.goto(url);
  expect(response?.status(), `${url} must be served (BRANDSPACE_DESIGN_SHOWCASE=1)`).toBe(200);
  await page.evaluate(() => document.fonts.ready);
  // Hydration: the client islands attach their handlers after the first paint.
  await page.waitForLoadState('networkidle');
}

for (const locale of LOCALES) {
  test.describe(`component gallery (${locale})`, () => {
    test(`every family exists in both looks`, async ({ page }) => {
      await open(page, COMPONENTS(locale));
      for (const family of FAMILIES) {
        const section = page.getByTestId(`gallery-${family}`);
        await expect(section, family).toHaveCount(1);
        await expect(section.locator('[data-look="customer"].bsp-frame'), family).toHaveCount(1);
        await expect(
          section.locator('[data-look="console"].bs-gallery-console'),
          family,
        ).toHaveCount(1);
      }
      await expect(page.getByTestId('gallery-index').locator('a')).toHaveCount(FAMILIES.length);
    });

    for (const family of FAMILIES) {
      test(`family: ${family}`, async ({ page }) => {
        await open(page, COMPONENTS(locale));
        const section = page.getByTestId(`gallery-${family}`);
        await section.scrollIntoViewIfNeeded();

        if (family === 'button') {
          await section.locator('button').first().hover();
        }
        if (family === 'input') {
          // Keyboard focus: a click on the heading sets the Tab starting point.
          await section.locator('h2').click();
          await page.keyboard.press('Tab');
          await expect(section.locator('input').first()).toBeFocused();
        }
        if (family === 'tooltip') {
          await section
            .locator('[data-look="customer"] [data-testid^="gallery-tooltip-"] button')
            .hover();
          await section
            .locator('[data-look="console"] [data-testid^="gallery-tooltip-"] button')
            .focus();
        }

        await expect(section).toHaveScreenshot(`gallery-${family}-${locale}.png`, SHOT);
      });
    }

    test('the open dialog, confirm dialog and side sheet, in both looks', async ({ page }) => {
      await open(page, COMPONENTS(locale));
      for (const look of ['customer', 'console'] as const) {
        for (const [trigger, stage, name] of [
          ['dialog', 'dialog', 'dialog'],
          ['confirm', 'dialog', 'confirm'],
          ['sheet', 'dialog', 'sheet'],
        ] as const) {
          const box = page.getByTestId(`gallery-stage-${stage}-${look}`);
          await box.scrollIntoViewIfNeeded();
          await page.getByTestId(`gallery-open-${trigger}-${look}`).click();
          await expect(box.locator('[role="dialog"]')).toBeVisible();
          // The entrance animation is a transition, not a still; wait it out.
          await page.waitForTimeout(500);
          await expect(box).toHaveScreenshot(`gallery-open-${name}-${look}-${locale}.png`, SHOT);
          await page.keyboard.press('Escape');
          await expect(box.locator('[role="dialog"]')).toHaveCount(0);
        }
      }
    });

    test('the backdrops, with the real scrims open', async ({ page }) => {
      await open(page, COMPONENTS(locale));
      for (const look of ['customer', 'console'] as const) {
        for (const kind of ['sheet', 'dialog'] as const) {
          const box = page.getByTestId(`gallery-backdrop-${kind}-${look}`);
          await box.scrollIntoViewIfNeeded();
          await page.getByTestId(`gallery-open-bd-${kind}-${look}`).click();
          await expect(box.locator('[role="dialog"]')).toBeVisible();
          await page.waitForTimeout(500);
          await expect(box).toHaveScreenshot(
            `gallery-backdrop-open-${kind}-${look}-${locale}.png`,
            SHOT,
          );
          await page.keyboard.press('Escape');
          await expect(box.locator('[role="dialog"]')).toHaveCount(0);
        }
      }
    });

    test('has no blocking accessibility violations', async ({ page }) => {
      await open(page, COMPONENTS(locale));
      await expectNoBlockingA11yViolations(page, `components (${locale})`);
    });
  });

  test.describe(`token gallery (${locale})`, () => {
    test('every group exists', async ({ page }) => {
      await open(page, TOKENS(locale));
      for (const group of TOKEN_GROUPS) {
        await expect(page.getByTestId(`gallery-tokens-${group}`), group).toHaveCount(1);
      }
    });

    for (const group of TOKEN_GROUPS) {
      test(`group: ${group}`, async ({ page }) => {
        await open(page, TOKENS(locale));
        const section = page.getByTestId(`gallery-tokens-${group}`);
        await section.scrollIntoViewIfNeeded();
        await expect(section).toHaveScreenshot(`gallery-tokens-${group}-${locale}.png`, SHOT);
      });
    }

    test('has no blocking accessibility violations', async ({ page }) => {
      await open(page, TOKENS(locale));
      await expectNoBlockingA11yViolations(page, `tokens (${locale})`);
    });
  });
}
