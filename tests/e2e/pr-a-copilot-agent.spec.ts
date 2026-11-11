import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { deterministicPng } from '@brandspace/ai-gateway';
import { DASHBOARD_BASE_URL } from './apps';
import { CreditLedgerService } from '@brandspace/entitlements';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR A (smart Copilot, D-603/D-604) — THE COPILOT WORKS, ON THE PAGE.
 *
 * The development double plays the model's tool loop deterministically, so
 * this is the real stream, the real tools and the real database:
 *
 *   - asked for a post, it shows "Created a post draft", links to the draft
 *     and answers word by word — in English and in Arabic;
 *   - Stop while it writes: "Stopped. Nothing was charged."; that message is
 *     stopped, its model call CANCELLED, nothing charged;
 *   - an image sent in the chat is read (the message says it carried one);
 *   - asked for a post with a picture, it starts the image for the draft and
 *     the picture is attached to the draft when ready.
 */

/**
 * A WORKSPACE OF ITS OWN, with credits through the real ledger: this suite's
 * turns never land in the conversation the other Copilot suites share.
 */
async function fresh(page: Page, label: string, locale: 'en' | 'ar' = 'en'): Promise<string> {
  const world = await ownWorkspace(`pra-${label}`);
  await withPlatformPrisma(async (prisma) => {
    await prisma.creditWallet.upsert({
      where: { workspaceId: world.workspaceId },
      create: { workspaceId: world.workspaceId },
      update: {},
    });
    await new CreditLedgerService({ prisma }).grant({
      workspaceId: world.workspaceId,
      source: 'PROMOTIONAL_GRANT',
      credits: 1_000,
      reason: 'PR A end-to-end allowance',
      idempotencyKey: `e2e-pra-grant:${world.workspaceId}`,
    });
  });
  await enter(page, world.slug, locale);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/copilot`);
  return world.workspaceId;
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

for (const locale of ['en', 'ar'] as const) {
  test(`asked for a post, it makes a draft, says what it did and links to it (${locale})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const workspaceId = await fresh(page, `draft-${locale}`, locale);
    const tag = randomUUID().slice(0, 6);
    await send(
      page,
      locale === 'ar' ? `اكتب منشورًا عن عرضنا ${tag}` : `Write a post about our offer ${tag}`,
    );
    await expect(page.getByTestId('copilot-tools')).toContainText(
      locale === 'ar' ? 'أنشأ مسودة منشور' : 'Created a post draft',
      { timeout: 60_000 },
    );
    const open = page.getByTestId('copilot-open-draft').first();
    await expect(open).toBeVisible({ timeout: 60_000 });
    await expect(open).toHaveAttribute('href', new RegExp(`/${locale}/content/compose\\?item=`));
    await expect(page.getByTestId('copilot-message-assistant').last()).toContainText(
      locale === 'ar' ? 'أنشأت مسودة منشور لك' : 'I made a draft post for you',
      { timeout: 60_000 },
    );
    // It is a draft, written by the Copilot, of this workspace.
    const itemId = new URL(
      String(await open.getAttribute('href')),
      DASHBOARD_BASE_URL,
    ).searchParams.get('item');
    const item = await withPlatformPrisma((prisma) =>
      prisma.contentItem.findUniqueOrThrow({ where: { id: String(itemId) } }),
    );
    expect(item).toMatchObject({
      workspaceId,
      status: 'DRAFT',
      origin: 'AI_GENERATED',
    });
  });
}

test('Stop while it writes: "Stopped. Nothing was charged." — the message is stopped and charged nothing', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const workspaceId = await fresh(page, 'stop');
  const sent = `Say hello slowly ${randomUUID().slice(0, 6)}`;
  await send(page, sent);
  // Words arrive before the end…
  await expect(page.getByTestId('copilot-message-assistant').last()).toContainText('Hello', {
    timeout: 30_000,
  });
  await page.getByTestId('copilot-stop').click();
  await expect(page.getByTestId('copilot-message-assistant').last()).toContainText(
    'Stopped. Nothing was charged.',
    { timeout: 30_000 },
  );
  await expect(page.getByTestId('copilot-propose')).toBeVisible();
  // THIS message, not the shared wallet (other tests spend from it in
  // parallel): marked stopped, its model call CANCELLED, nothing charged.
  await expect
    .poll(
      () =>
        withPlatformPrisma(async (prisma) => {
          const asked = await prisma.copilotMessage.findFirst({
            where: { workspaceId, role: 'USER', body: sent },
            select: { status: true, idempotencyKey: true },
          });
          const calls = asked?.idempotencyKey
            ? await prisma.aiRequest.findMany({
                where: { idempotencyKey: { startsWith: `copilot:${asked.idempotencyKey}:` } },
                select: { status: true, creditsChargedMilli: true },
              })
            : [];
          return {
            message: asked?.status ?? null,
            cancelled: calls.some((call) => call.status === 'CANCELLED'),
            charged: calls.reduce((sum, call) => sum + call.creditsChargedMilli, 0n).toString(),
          };
        }),
      { timeout: 30_000 },
    )
    .toEqual({ message: 'stopped', cancelled: true, charged: '0' });
});

test('an image sent in the chat is read with the message', async ({ page }) => {
  test.setTimeout(120_000);
  await fresh(page, 'image');
  await page.getByTestId('copilot-attach-input').setInputFiles({
    name: `photo-${randomUUID().slice(0, 6)}.png`,
    mimeType: 'image/png',
    buffer: Buffer.from(deterministicPng(randomUUID(), '64x64').bytes),
  });
  await expect(page.getByTestId('copilot-chat-images')).toContainText('Image ready to send', {
    timeout: 60_000,
  });
  await send(page, `What do you see in this picture? ${randomUUID().slice(0, 6)}`);
  await expect(page.getByTestId('copilot-message-user').last()).toContainText('Images attached: 1');
  await expect(page.getByTestId('copilot-message-assistant').last()).toContainText(
    'I can see the image you sent.',
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('copilot-error')).toHaveCount(0);
});

test('asked for a post with a picture, the image is made for the draft and attached', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await fresh(page, 'picture');
  await send(page, `Write a post with a picture ${randomUUID().slice(0, 6)}`);
  await expect(page.getByTestId('copilot-tools')).toContainText('Started an image', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('copilot-image-coming')).toBeVisible();
  const href = await page.getByTestId('copilot-open-draft').first().getAttribute('href');
  const itemId = new URL(String(href), DASHBOARD_BASE_URL).searchParams.get('item');
  await expect
    .poll(
      () =>
        withPlatformPrisma(async (prisma) => {
          const variant = await prisma.contentVariant.findFirst({
            where: { contentItemId: String(itemId) },
            select: { assetIds: true },
          });
          return variant?.assetIds.length ?? 0;
        }),
      { timeout: 120_000 },
    )
    .toBe(1);
});
