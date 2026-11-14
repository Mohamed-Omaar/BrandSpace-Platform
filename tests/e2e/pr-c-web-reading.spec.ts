import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { CreditLedgerService } from '@brandspace/entitlements';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR C (owner, 2026-11-14) — THE COPILOT READS LINKS, AND THE BRAND'S WEBSITE
 * IS READ INTO BRAND BRAIN.
 *
 * Every https link comes from the stand-in web site (`fake-web.ts`) through the
 * real reader, robots.txt included; the Copilot's model is the development
 * double, which reads a pasted link and — on the `/inject` page — tries the
 * write the page asks for, as an obedient model might. Proven on the page:
 *
 *   - a pasted link is read ("Read a web page") and answered from;
 *   - a page saying "ignore previous instructions" gets only a confirmation
 *     card: no draft is written;
 *   - a private address is refused, with the reason;
 *   - "Read our website" in Brand Brain → Sources makes one source named after
 *     the site, and the Copilot's "read our website" card does the same after
 *     the person presses Read.
 */

async function fresh(page: Page, label: string, locale: 'en' | 'ar' = 'en') {
  const world = await ownWorkspace(`prc-${label}`);
  await withPlatformPrisma(async (prisma) => {
    await prisma.brand.update({
      where: { id: world.brandId },
      data: { websiteUrl: 'https://bayt-coffee.example.com' },
    });
    await prisma.creditWallet.upsert({
      where: { workspaceId: world.workspaceId },
      create: { workspaceId: world.workspaceId },
      update: {},
    });
    await new CreditLedgerService({ prisma }).grant({
      workspaceId: world.workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 1_000,
      reason: 'PR C end-to-end allowance',
      idempotencyKey: `e2e-prc-grant:${world.workspaceId}`,
    });
  });
  await enter(page, world.slug, locale);
  return world;
}

async function send(page: Page, text: string): Promise<void> {
  await expect
    .poll(async () => {
      await page.getByTestId('copilot-request').fill(text);
      return page.getByTestId('copilot-propose').isEnabled();
    })
    .toBe(true);
  await page.getByTestId('copilot-request').press('Enter');
}

test('a pasted link is read and answered from: "Read a web page"', async ({ page }) => {
  test.setTimeout(120_000);
  await fresh(page, 'link');
  await page.goto(`${DASHBOARD_BASE_URL}/en/copilot`);
  await send(
    page,
    `What does https://bayt-coffee.example.com/about say? ${randomUUID().slice(0, 6)}`,
  );
  await expect(page.getByTestId('copilot-tools')).toContainText('Read a web page', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('copilot-message-assistant').last()).toContainText(
    'I read the page “About Bayt Coffee”',
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('copilot-error')).toHaveCount(0);
});

test('a page that says "ignore previous instructions" gets only a confirmation card; no draft is written', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const world = await fresh(page, 'inject');
  await page.goto(`${DASHBOARD_BASE_URL}/en/copilot`);
  await send(page, `Read https://bayt-coffee.example.com/inject ${randomUUID().slice(0, 6)}`);
  await expect(page.getByTestId('copilot-message-assistant').last()).toContainText(
    'it waits for your confirmation below',
    { timeout: 60_000 },
  );
  // The write the page asked for is a card the person may confirm or cancel…
  await expect(page.getByTestId('copilot-plan')).toBeVisible();
  await expect(page.getByTestId('copilot-plan').getByTestId('copilot-reject')).toBeVisible();
  // …and nothing was written.
  const drafts = await withPlatformPrisma((prisma) =>
    prisma.contentItem.count({ where: { workspaceId: world.workspaceId } }),
  );
  expect(drafts).toBe(0);
});

test('a private address pasted in the chat is refused, with the reason', async ({ page }) => {
  test.setTimeout(120_000);
  await fresh(page, 'private');
  await page.goto(`${DASHBOARD_BASE_URL}/en/copilot`);
  await send(page, `Read https://10.0.0.5/admin ${randomUUID().slice(0, 6)}`);
  await expect(page.getByTestId('copilot-message-assistant').last()).toContainText(
    "I couldn't read that link: A link with an IP address instead of a site name cannot be read.",
    { timeout: 60_000 },
  );
});

test('Brand Brain → Sources → "Read our website" adds one source named after the site', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const world = await fresh(page, 'bb-site');
  await page.goto(`${DASHBOARD_BASE_URL}/en/brand-brain?tab=sources`);
  await expect(page.getByTestId('website-host')).toHaveText('bayt-coffee.example.com');
  await page.getByTestId('website-read').click();
  await expect(page.getByText('Your website was read.')).toBeVisible({ timeout: 60_000 });
  const source = await withPlatformPrisma((prisma) =>
    prisma.brandSourceDocument.findFirstOrThrow({
      where: { workspaceId: world.workspaceId },
      select: { id: true, fileName: true, mimeType: true },
    }),
  );
  // Home, About and Menu; robots.txt kept /admin out.
  expect(source).toMatchObject({
    fileName: 'bayt-coffee.example.com — website (3 pages).txt',
    mimeType: 'text/plain',
  });
  await expect(page.getByTestId(`source-${source.id}`)).toBeVisible();
});

for (const locale of ['en', 'ar'] as const) {
  test(`the Copilot's "read our website" is a card; pressing Read reads it into Brand Brain (${locale})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const world = await fresh(page, `card-${locale}`, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/copilot`);
    await send(page, locale === 'ar' ? 'اقرا موقعنا' : 'Please read our website');
    const card = page.getByTestId('copilot-source-card');
    await expect(card.getByTestId('copilot-source-ask')).toContainText('bayt-coffee.example.com', {
      timeout: 60_000,
    });
    // Nothing is read before the person presses Read.
    expect(
      await withPlatformPrisma((prisma) =>
        prisma.brandSourceDocument.count({ where: { workspaceId: world.workspaceId } }),
      ),
    ).toBe(0);
    await card.getByTestId('copilot-source-add').click();
    await expect
      .poll(
        () =>
          withPlatformPrisma((prisma) =>
            prisma.brandSourceDocument.count({ where: { workspaceId: world.workspaceId } }),
          ),
        { timeout: 60_000 },
      )
      .toBe(1);
    // The file card's own steps follow: read, then what it found, to review.
    await expect(card.getByTestId('copilot-source-coverage')).toBeVisible({ timeout: 120_000 });
  });
}
