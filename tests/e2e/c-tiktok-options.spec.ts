import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { SocialTokenVault } from '@brandspace/social-connectors';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * CONNECTORS C (D-505 O4) — THE TIKTOK POST OPTIONS IN THE STUDIO.
 *
 * A TikTok video draft on a brand with a connected TikTok account (the
 * deterministic development connector answers `creator_info` through the
 * API's own route, with a sealed fake token):
 *
 *   - the creator's nickname is shown; nothing is chosen for "Who can see
 *     this post" and Comment, Duet and Stitch are off;
 *   - a setting the creator turned off in TikTok is locked off;
 *   - the post cannot be scheduled until an audience is chosen;
 *   - the choices are saved with the post, and disclosure asks for its kind;
 *   - both languages, both directions.
 */

async function tiktokDraft(own: OwnWorkspace, token: string): Promise<string> {
  // Sealed with the suite's own social token key (`SOCIAL_TOKEN_VAULT_KEK`),
  // the one the API opens it with. The token is fake and reaches no platform.
  const vault = new SocialTokenVault();
  return withPlatformPrisma(async (prisma) => {
    const connection = await prisma.socialConnection.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        provider: 'TIKTOK',
        externalAccountId: `e2e-tiktok-${randomUUID()}`,
        displayName: '@reemacafe',
        targetKind: 'profile',
        status: 'ACTIVE',
        grantedScopes: ['user.info.basic', 'video.publish'],
        connectedByUserId: own.ownerId,
        connectedAt: new Date(),
        tokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    const sealed = await vault.seal({
      workspaceId: own.workspaceId,
      socialConnectionId: connection.id,
      version: 1,
      material: { accessToken: token, refreshToken: 'e2e-fake-refresh-not-real' },
    });
    await prisma.socialCredential.create({
      data: {
        workspaceId: own.workspaceId,
        socialConnectionId: connection.id,
        version: 1,
        ...sealed,
        accessTokenExpiresAt: new Date(Date.now() + 30 * 86_400_000),
        hasRefreshToken: true,
      },
    });
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        title: 'Morning pour-over',
        status: 'DRAFT',
        primaryLocale: 'EN',
        contentType: 'VIDEO',
        createdByUserId: own.ownerId,
      },
      select: { id: true },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        contentItemId: item.id,
        platformKey: 'tiktok',
        locale: 'EN',
        body: 'Slow mornings, fresh beans.',
      },
    });
    return item.id;
  });
}

const storedOptions = (itemId: string) =>
  withPlatformPrisma(async (prisma) => {
    const variant = await prisma.contentVariant.findFirstOrThrow({
      where: { contentItemId: itemId, platformKey: 'tiktok' },
      select: { platformOptions: true },
    });
    return variant.platformOptions as Record<string, unknown> | null;
  });

async function open(page: Page, locale: string, itemId: string) {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content/compose?item=${itemId}`);
  await expect(page.getByTestId('tiktok-options-tiktok')).toBeVisible();
}

for (const locale of ['en', 'ar'] as const) {
  test(`TikTok options: nickname, no default audience, interactions off, saved with the post (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1536, height: 864 });
    const own = await ownWorkspace(`c-tiktok-${locale}`);
    const itemId = await tiktokDraft(own, 'e2e-tiktok-no-duet-token');
    await enter(page, own.slug, locale);
    await open(page, locale, itemId);

    // The creator's nickname, from TikTok (the development connector's).
    await expect(page.getByTestId('tiktok-options-tiktok-posting-as')).toContainText(
      'Creator account (development)',
    );
    // No audience chosen; only those the account offers are listed.
    const privacy = page.getByTestId('tiktok-options-tiktok-privacy');
    await expect(privacy).toHaveValue('');
    await expect(privacy.locator('option:not([disabled])')).toHaveCount(3);
    // Off until turned on; Duet locked off because the creator turned it off.
    await expect(page.getByTestId('tiktok-options-tiktok-comment')).not.toBeChecked();
    await expect(page.getByTestId('tiktok-options-tiktok-stitch')).not.toBeChecked();
    await expect(page.getByTestId('tiktok-options-tiktok-duet')).toBeDisabled();
    await expect(page.getByTestId('tiktok-options-tiktok-disclose')).not.toBeChecked();
    await expect(page.getByTestId('tiktok-options-tiktok-problem')).toContainText(
      locale === 'ar' ? 'اختر من يمكنه رؤية' : 'Choose who can see this post',
    );
    await expect(page.getByTestId('tiktok-options-tiktok-consent')).toContainText(
      locale === 'ar' ? 'تأكيد استخدام الموسيقى' : 'Music Usage Confirmation',
    );

    // Choose, turn Comment on, disclose as one's own brand: the autosave keeps it.
    await privacy.selectOption('MUTUAL_FOLLOW_FRIENDS');
    await page.getByTestId('tiktok-options-tiktok-comment').check();
    await page.getByTestId('tiktok-options-tiktok-disclose').check();
    await expect(page.getByTestId('tiktok-options-tiktok-problem')).toContainText(
      locale === 'ar' ? 'حدّد إن كان' : 'Say whether',
    );
    await page.getByTestId('tiktok-options-tiktok-your-brand').check();
    await expect(page.getByTestId('tiktok-options-tiktok-problem')).toHaveCount(0);
    await expect
      .poll(async () => storedOptions(itemId), { timeout: 20_000 })
      .toMatchObject({
        privacyLevel: 'MUTUAL_FOLLOW_FRIENDS',
        allowComment: true,
        allowDuet: false,
        allowStitch: false,
        disclosure: { enabled: true, yourBrand: true, brandedContent: false },
      });

    // Read back from the server after a reload.
    await open(page, locale, itemId);
    await expect(privacy).toHaveValue('MUTUAL_FOLLOW_FRIENDS');
    await expect(page.getByTestId('tiktok-options-tiktok-comment')).toBeChecked();
    await expect(page.getByTestId('tiktok-options-tiktok-your-brand')).toBeChecked();

    // "Only me" clears branded content, which can never be private.
    await page.getByTestId('tiktok-options-tiktok-branded').check();
    await privacy.selectOption('SELF_ONLY');
    await expect(page.getByTestId('tiktok-options-tiktok-branded')).not.toBeChecked();
    await expect(page.getByTestId('tiktok-options-tiktok-branded')).toBeDisabled();
  });
}

test('a TikTok post is not scheduled from the Studio until an audience is chosen', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 1536, height: 864 });
  const own = await ownWorkspace('c-tiktok-schedule');
  await withPlatformPrisma((prisma) =>
    prisma.approvalPolicy.create({
      data: {
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        requireApprovalBeforeScheduling: false,
      },
    }),
  );
  const itemId = await tiktokDraft(own, 'e2e-tiktok-token');
  await enter(page, own.slug, 'en');
  await open(page, 'en', itemId);

  const slots = () =>
    withPlatformPrisma((prisma) => prisma.calendarSlot.count({ where: { contentItemId: itemId } }));
  const schedule = async () => {
    await page.getByTestId('editor-when').click();
    const panel = page.getByTestId('editor-when-panel');
    await expect(panel).toBeVisible();
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await panel.getByTestId('editor-schedule-date').fill(day);
    await panel.getByTestId('editor-schedule-time').fill('10:30');
    await panel.getByTestId('editor-schedule-submit').click();
  };

  // No audience chosen: refused, said in words, nothing on the calendar.
  await schedule();
  await page.waitForURL(/error=TIKTOK_OPTIONS_INCOMPLETE/);
  await expect(page.getByText('Finish the TikTok post settings first')).toBeVisible();
  expect(await slots()).toBe(0);

  // Chosen and saved: the same press schedules it.
  await page.getByTestId('tiktok-options-tiktok-privacy').selectOption('SELF_ONLY');
  await expect
    .poll(async () => (await storedOptions(itemId))?.['privacyLevel'], { timeout: 20_000 })
    .toBe('SELF_ONLY');
  await open(page, 'en', itemId);
  await schedule();
  await page.waitForURL(/ok=CONTENT_SCHEDULED/);
  expect(await slots()).toBe(1);
});
