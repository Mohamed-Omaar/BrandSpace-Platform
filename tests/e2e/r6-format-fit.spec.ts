import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { createFreshWorkspace, finishFreshOnboarding, freshSignUp } from './fresh-signup';

/**
 * ROUND 6 (owner decision D-481) — A NEW CUSTOMER CAN USE EVERY FORMAT A
 * CHANNEL CARRIES, AND NO PRESS GOES UNANSWERED.
 *
 * The owner, on a workspace straight after sign-up with no connected
 * accounts, pressed Carousel, Story and Reel and nothing happened: formats
 * followed whether a channel could be CONNECTED (`enabled`), and the refused
 * ones were `disabled` with no visible dimming. Formats now follow the
 * channel's configured post kinds alone; a format the chosen channels cannot
 * all carry is dimmed before the press with the reason beside the switch, and
 * its press offers the fix in one press. An account is needed only to
 * publish, and the Studio says which channels still need one.
 *
 * This suite runs on the suite's configured channels (`seed-social.ts`): a
 * fresh sign-up with no accounts. The DEFAULT configuration (every channel
 * text-only) is environment-wide, so switching to it would disturb every
 * other spec running beside this one; that case is
 * `r6-format-fit-defaults.spec.ts`, run on its own.
 */

const format = (page: Page, type: string) =>
  page.locator(`[data-testid="content-format"] button[data-value="${type}"]`);
const channel = (page: Page, key: string) =>
  page.locator(`[data-testid="content-channel"][data-platform="${key}"]`);

test('a fresh sign-up with no accounts: every format for Instagram, the rest say why and fix it', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one fresh workspace per run; the desktop run covers it');
  test.setTimeout(180_000);
  await freshSignUp(page);
  await createFreshWorkspace(page);
  await finishFreshOnboarding(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=write`);
  await expect(page.getByTestId('content-composer')).toBeVisible();

  // Instagram alone: every one of the four is live and switches on the first press.
  for (const key of ['linkedin', 'x', 'tiktok']) {
    if ((await channel(page, key).getAttribute('aria-pressed')) === 'true') {
      await channel(page, key).click();
    }
  }
  if ((await channel(page, 'instagram').getAttribute('aria-pressed')) !== 'true') {
    await channel(page, 'instagram').click();
  }
  for (const type of ['CAROUSEL', 'REEL', 'STORY', 'POST']) {
    await expect(format(page, type)).not.toHaveAttribute('data-unavailable', 'true');
    await format(page, type).click();
    await expect(format(page, type)).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(page.getByTestId('content-format-unavailable')).toHaveCount(0);

  // No account yet: one calm line, with the existing connect page.
  await expect(page.getByTestId('studio-connect-line')).toContainText(
    'Connect Instagram to publish this post.',
  );
  await expect(page.getByTestId('studio-connect-link')).toHaveAttribute('href', '/en/integrations');

  // LinkedIn and X added: the formats they cannot carry are dimmed BEFORE any
  // press, each with its reason, and the line beside the switch says it.
  await channel(page, 'linkedin').click();
  await channel(page, 'x').click();
  await expect(format(page, 'STORY')).toHaveAttribute('data-unavailable', 'true');
  await expect(format(page, 'STORY')).toHaveAttribute('title', 'Story is for Instagram.');
  await expect(format(page, 'REEL')).toHaveAttribute('data-unavailable', 'true');
  await expect(format(page, 'CAROUSEL')).toHaveAttribute('data-unavailable', 'true');
  await expect(format(page, 'POST')).not.toHaveAttribute('data-unavailable', 'true');
  await expect(page.getByTestId('content-format-unavailable')).toContainText(
    'Story can’t go to LinkedIn and X.',
  );
  await expect(page.getByTestId('content-format-unavailable')).toContainText(
    'Carousel can’t go to X.',
  );

  // The press on a dimmed format answers, and its fix takes one press.
  await format(page, 'STORY').click({ force: true });
  await expect(format(page, 'STORY')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('content-format-fix')).toContainText('Story is for Instagram.');
  await page.getByTestId('content-format-fix-apply').click();
  await expect(format(page, 'STORY')).toHaveAttribute('aria-pressed', 'true');
  await expect(channel(page, 'instagram')).toHaveAttribute('aria-pressed', 'true');
  await expect(channel(page, 'linkedin')).toHaveAttribute('aria-pressed', 'false');
  await expect(channel(page, 'x')).toHaveAttribute('aria-pressed', 'false');

  // A channel the format cannot carry answers its press too.
  await expect(channel(page, 'linkedin')).toHaveAttribute('aria-disabled', 'true');
  await channel(page, 'linkedin').click({ force: true });
  await expect(page.getByTestId('content-format-fix')).toContainText(
    'LinkedIn can’t post a Story.',
  );
  await expect(page.getByTestId('content-format-fix-apply')).toHaveText(
    'Switch to Post and add LinkedIn',
  );
  await page.getByTestId('content-format-fix-apply').click();
  await expect(format(page, 'POST')).toHaveAttribute('aria-pressed', 'true');
  await expect(channel(page, 'linkedin')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('studio-connect-line')).toContainText(
    'Connect Instagram and LinkedIn to publish this post.',
  );
});
