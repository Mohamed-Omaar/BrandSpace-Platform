import { expect, test } from '@playwright/test';
import { ConfigurationService } from '@brandspace/config';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * D-531 + STEP B ITEMS 1–3 — A HELD POST ON THE CALENDAR WHILE NO CHANNEL CAN
 * BE CONNECTED (staging's state), in English and Arabic:
 *
 *   1. its drawer offers no Date, Time or Move — only "Open in the Studio" and
 *      "Take off the calendar";
 *   2. the "drag any post to another day" line is not shown (nor the phone's
 *      move note);
 *   3. its channel is named as configured ("Instagram"), never a raw key.
 *
 * RUN ON ITS OWN, like `r6-format-fit-defaults.spec.ts`: the publishing
 * configuration is environment-wide, so it runs only with
 * `BRANDSPACE_E2E_GLOBAL_CONFIG=1` and puts the configuration back afterwards.
 * The rule itself is unit-tested in every run
 * (`tests/unit/connectors-b-calendar-held.test.ts`).
 */

test.describe.configure({ mode: 'serial' });

const ENVIRONMENT = 'DEVELOPMENT' as const;
let saved: unknown = null;
let world: OwnWorkspace;
let held: { slotId: string; month: string };

async function activate(payload: unknown, reason: string): Promise<void> {
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.platformUser.findFirstOrThrow({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, roleId: true },
    });
    const grants = await prisma.rolePermission.findMany({
      where: { roleId: owner.roleId },
      include: { permission: true },
    });
    const actor = {
      platformUserId: owner.id,
      roleKey: 'platform_owner',
      mfaVerified: true,
      permissionKeys: grants.map((grant) => grant.permission.key),
    };
    const configuration = new ConfigurationService({ prisma, cacheTtlMs: 0 });
    const draft = await configuration.createDraft(
      actor,
      'publishing',
      ENVIRONMENT,
      reason,
      payload as never,
    );
    const report = await configuration.validateDraft(actor, draft.id);
    expect(report.valid, JSON.stringify(report.issues)).toBe(true);
    await configuration.activate(actor, draft.id, { acknowledgeHighImpact: true });
  });
}

test.beforeAll(async () => {
  test.skip(
    process.env['BRANDSPACE_E2E_GLOBAL_CONFIG'] !== '1',
    'switches the environment-wide publishing configuration; run on its own',
  );
  await withPlatformPrisma(async (prisma) => {
    saved = await new ConfigurationService({ prisma, cacheTtlMs: 0 }).get(
      'publishing',
      ENVIRONMENT,
    );
  });
  // Every platform switched off: the schema default, as on staging.
  await activate(
    { ...(saved as Record<string, unknown>), providers: {} },
    'E2E: every platform off (held post on the calendar).',
  );

  // The held state the publishing sweep produces (D-531): PLANNED on its day,
  // APPROVED, its time kept as its proposal. Its channel is a configured one.
  world = await ownWorkspace('held');
  const day = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  const local = `${day}T10:00`;
  held = await withPlatformPrisma(async (prisma) => {
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: world.workspaceId,
        brandId: world.brandId,
        title: 'Held launch post',
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'APPROVED',
        origin: 'HUMAN',
        createdByUserId: world.ownerId,
        idempotencyKey: `held-e2e-${world.slug}`,
        proposedLocalTime: local,
        publishChoice: 'PICK',
      },
    });
    await prisma.contentVariant.create({
      data: {
        workspaceId: world.workspaceId,
        brandId: world.brandId,
        contentItemId: item.id,
        platformKey: 'instagram',
        locale: 'EN',
        body: 'Our launch is coming.',
        hashtags: [],
        characterCount: 21,
        validationState: 'VALID',
        origin: 'HUMAN',
      },
    });
    const slot = await prisma.calendarSlot.create({
      data: {
        workspaceId: world.workspaceId,
        brandId: world.brandId,
        contentItemId: item.id,
        scheduledAtUtc: new Date(`${local}:00Z`),
        scheduledLocalTime: local,
        timezone: 'UTC',
        status: 'PLANNED',
        platformKeys: ['instagram'],
        createdByUserId: world.ownerId,
      },
    });
    return { slotId: slot.id, month: local.slice(0, 7) };
  });
});

test.afterAll(async () => {
  if (process.env['BRANDSPACE_E2E_GLOBAL_CONFIG'] !== '1' || saved === null) return;
  await activate(saved, 'E2E: restore the publishing configuration (held post).');
});

for (const locale of ['en', 'ar'] as const) {
  test(`a held post: no Move, no drag line, a configured channel name (${locale})`, async ({
    page,
  }) => {
    await enter(page, world.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/calendar?month=${held.month}`);
    const chip = page.getByTestId(`calendar-post-${held.slotId}`).first();
    await expect(chip).toBeVisible();

    // 2. No drag line while no channel can be connected.
    const hint =
      locale === 'en'
        ? 'Drag a post to another day to move it.'
        : 'اسحب أي منشور إلى يوم آخر لتغيير موعده.';
    await expect(page.getByText(hint)).toHaveCount(0);
    await expect(page.getByTestId('calendar-move-note')).toHaveCount(0);

    // 1. The drawer: the held line, no Date/Time/Move, Studio and Unschedule kept.
    await chip.click();
    await page.getByTestId('calendar-pop-details').click();
    await expect(page.getByTestId('calendar-slot-held')).toBeVisible();
    await expect(page.getByTestId('reschedule-date')).toHaveCount(0);
    await expect(page.getByTestId('reschedule-time')).toHaveCount(0);
    await expect(page.getByTestId('reschedule-submit')).toHaveCount(0);
    await expect(page.getByTestId('calendar-open-studio')).toBeVisible();
    await expect(page.getByTestId('calendar-cancel-submit')).toBeVisible();

    // 3. The channel by its configured name.
    await expect(page.getByTestId('calendar-slot-channels')).toContainText('Instagram');
    await expect(page.getByTestId('calendar-slot-channels')).not.toContainText('instagram');
  });
}
