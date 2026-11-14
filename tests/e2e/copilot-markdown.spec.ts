import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { CreditLedgerService } from '@brandspace/entitlements';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * COPILOT REPLIES AS SAFE MARKDOWN (owner, 2026-11-14).
 *
 * Staging showed "**bold**", "- " and "1)" as literal symbols, all run
 * together. A stored answer carrying every element is shown on the page and
 * in the side panel, in English and Arabic:
 *
 *   - heading, bold, italic, bullets, numbers and a link are ELEMENTS;
 *   - `<script>` and raw HTML in the answer are shown as text and never run;
 *   - "Worked on: …" is its own line above the answer, not inside it;
 *   - in Arabic the bullets and numbers sit on the right.
 */

const ANSWER = {
  en: [
    '## Your week',
    '',
    'Here is **the plan** for *this week*. See [the guide](https://example.com/guide).',
    '',
    '- Post a reel on Monday',
    '- Reply to comments',
    '',
    '1) Draft the caption',
    '2) Pick the image',
    '',
    'Raw: <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned = 2">',
  ].join('\n'),
  ar: [
    '## خطة الأسبوع',
    '',
    'هذه **الخطة** لهذا *الأسبوع*. راجع [الدليل](https://example.com/guide).',
    '',
    '- انشر مقطعًا يوم الاثنين',
    '- رد على التعليقات',
    '',
    '1) اكتب النص',
    '2) اختر الصورة',
    '',
    'نص: <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned = 2">',
  ].join('\n'),
} as const;

async function withAnswer(page: Page, locale: 'en' | 'ar') {
  const world = await ownWorkspace(`md-${locale}`);
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
      reason: 'Copilot Markdown end-to-end allowance',
      idempotencyKey: `e2e-md-grant:${world.workspaceId}`,
    });
  });
  await enter(page, world.slug, locale);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/copilot`);
  // A first message opens this person's one conversation.
  const marker = `Start ${randomUUID()}`;
  await expect
    .poll(async () => {
      await page.getByTestId('copilot-request').fill(marker);
      return page.getByTestId('copilot-propose').isEnabled();
    })
    .toBe(true);
  await page.getByTestId('copilot-request').press('Enter');
  await expect(page.getByTestId('copilot-working')).toHaveCount(0, { timeout: 60_000 });
  await withPlatformPrisma(async (prisma) => {
    const row = await prisma.copilotMessage.findFirstOrThrow({
      where: { workspaceId: world.workspaceId, body: marker },
      select: { sessionId: true },
    });
    await prisma.copilotMessage.create({
      data: {
        workspaceId: world.workspaceId,
        sessionId: row.sessionId,
        role: 'ASSISTANT',
        body: ANSWER[locale],
        correlationId: randomUUID(),
        kind: 'message',
        status: 'complete',
        activity: { worked: [{ key: 'campaign.create', state: 'done' }] },
        createdAt: new Date(Date.now() + 60_000),
      },
    });
  });
}

async function proveAnswer(page: Page, scope: Locator, locale: 'en' | 'ar') {
  const answer = scope.getByTestId('copilot-message-assistant').last();
  const md = answer.getByTestId('copilot-markdown');
  await expect(md).toBeVisible({ timeout: 30_000 });
  await expect(md.locator('h4')).toHaveText(locale === 'ar' ? 'خطة الأسبوع' : 'Your week');
  await expect(md.locator('strong')).toHaveText(locale === 'ar' ? 'الخطة' : 'the plan');
  await expect(md.locator('em')).toHaveText(locale === 'ar' ? 'الأسبوع' : 'this week');
  await expect(md.locator('ul > li')).toHaveCount(2);
  await expect(md.locator('ol > li')).toHaveCount(2);
  const link = md.locator('a');
  await expect(link).toHaveAttribute('href', 'https://example.com/guide');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  // No Markdown symbol is left on screen.
  const shown = await md.innerText();
  expect(shown).not.toContain('**');
  expect(shown).not.toMatch(/^\s*- /m);
  expect(shown).not.toMatch(/^\s*1\)/m);
  // Raw HTML is shown as text and never runs.
  await expect(md).toContainText('<script>window.__pwned = 1</script>');
  await expect(md.locator('script, img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  // "Worked on" is its own line above the answer, never inside it.
  const note = answer.getByTestId('copilot-worked-on');
  await expect(note).toHaveText(locale === 'ar' ? /^عمل على: / : /^Worked on: /);
  expect(shown).not.toContain(locale === 'ar' ? 'عمل على' : 'Worked on');
  const [noteBox, mdBox] = [await note.boundingBox(), await md.boundingBox()];
  expect(noteBox!.y + noteBox!.height).toBeLessThanOrEqual(mdBox!.y + 1);

  // The list's marker side follows the language: right in Arabic, left in English.
  const sides = await md.locator('ul').evaluate((list) => {
    const item = list.querySelector('li')!.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    return {
      direction: getComputedStyle(list).direction,
      startGap: Math.round(item.left - box.left),
      endGap: Math.round(box.right - item.right),
    };
  });
  if (locale === 'ar') {
    expect(sides.direction).toBe('rtl');
    // The bullets' room is on the RIGHT.
    expect(sides.endGap).toBeGreaterThan(sides.startGap);
  } else {
    expect(sides.direction).toBe('ltr');
    expect(sides.startGap).toBeGreaterThan(sides.endGap);
  }
}

for (const locale of ['en', 'ar'] as const) {
  test(`a Copilot answer shows as Markdown on the page, safely (${locale})`, async ({ page }) => {
    test.setTimeout(150_000);
    await withAnswer(page, locale);
    await page.reload();
    await proveAnswer(page, page.getByTestId('copilot-conversation'), locale);
  });

  test(`…and in the side panel (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'the side panel is the desktop’s');
    test.setTimeout(150_000);
    await withAnswer(page, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
    await page.getByTestId('topbar-copilot').click();
    const drawer = page.getByTestId('copilot-drawer');
    await expect(drawer).toBeVisible();
    await proveAnswer(page, drawer.getByTestId('copilot-conversation'), locale);
  });
}
