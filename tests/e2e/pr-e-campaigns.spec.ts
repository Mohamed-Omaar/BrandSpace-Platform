import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR E (D-496) — THE CAMPAIGN FORM IS THE PROTOTYPE'S 560px DIALOG.
 *
 *   - Shell 7: "+ New campaign" opens it over Campaigns (`?new=1`).
 *   - Campaigns 15, 16: the objective is one chip, the channels several.
 *   - Campaigns 1: "Planned posts" − n + (eight to start, never below one) is
 *     stored, and the card reads "Published n / planned".
 *   - Campaigns 21: Edit opens the same dialog over the campaign; "Archive" asks
 *     once ("Sure? Archive") before it archives.
 */

for (const locale of ['en', 'ar'] as const) {
  test(`a campaign is made and edited in the dialog, and archived in two steps (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1536, height: 864 });
    const own = await ownWorkspace(`pr-e-camp-${locale}`);
    await enter(page, own.slug, locale);
    const name = `Winter menu ${locale} ${Date.now().toString(36)}`;

    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/campaigns`);
    await page.getByTestId('campaign-new').click();
    await page.waitForURL(/\/campaigns\?new=1$/);
    const dialog = page.getByTestId('campaign-new-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');
    // The prototype's card: inside the window, narrower than the rule builder.
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeLessThan(560);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(864);

    await page.getByTestId('campaign-name').fill(name);
    await page.getByTestId('campaign-objective-LAUNCH').check();
    await expect(page.getByTestId('campaign-objective-AWARENESS')).not.toBeChecked();
    const channels = page.getByTestId('campaign-channels').locator('input[type="checkbox"]');
    expect(await channels.count()).toBeGreaterThan(0);
    await channels.first().check();
    // A chosen chip is dark (the prototype's `aria-pressed` fill).
    const chosen = page.getByTestId('campaign-channels').locator('label').first();
    await expect(chosen).toHaveCSS('background-color', 'rgb(17, 17, 20)');

    const total = page.getByTestId('campaign-planned-total');
    await expect(total).toHaveText('8');
    await page.getByTestId('campaign-planned-plus').click();
    await expect(total).toHaveText('9');
    await page.getByTestId('campaign-submit').click();
    await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}\?ok=CAMPAIGN_CREATED/);

    const created = await withPlatformPrisma((prisma) =>
      prisma.campaign.findFirstOrThrow({
        where: { workspaceId: own.workspaceId, name },
        select: { id: true, objective: true, plannedPostCount: true },
      }),
    );
    expect(created.objective).toBe('LAUNCH');
    expect(created.plannedPostCount).toBe(9);

    // The card: "Published 0 / 9", the planned number, not the posts filed.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/campaigns?status=DRAFT`);
    await expect(page.getByTestId(`campaign-ratio-${created.id}`)).toHaveText('0 / 9');

    // Edit: the same dialog over the campaign, with its values.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/campaigns/${created.id}`);
    await page.getByTestId('campaign-edit').click();
    await page.waitForURL(/edit=1/);
    const edit = page.getByTestId('campaign-edit-dialog');
    await expect(edit).toBeVisible();
    await expect(page.getByTestId('campaign-name')).toHaveValue(name);
    await expect(page.getByTestId('campaign-objective-LAUNCH')).toBeChecked();
    await expect(page.getByTestId('campaign-planned-total')).toHaveText('9');
    await page.getByTestId('campaign-planned-minus').click();
    await page.getByTestId('campaign-submit').click();
    await page.waitForURL(/ok=CAMPAIGN_SAVED/);
    await expect(page.getByTestId('campaign-edit-dialog')).toHaveCount(0);
    const saved = await withPlatformPrisma((prisma) =>
      prisma.campaign.findUniqueOrThrow({
        where: { id: created.id },
        select: { plannedPostCount: true },
      }),
    );
    expect(saved.plannedPostCount).toBe(8);

    // Archive asks once, then archives.
    await page.getByTestId('campaign-edit').click();
    await page.waitForURL(/edit=1/);
    await page.getByTestId('campaign-archive').click();
    const sure = page.getByTestId('campaign-archive-sure');
    await expect(sure).toHaveText(locale === 'ar' ? 'متأكد؟ أرشفة' : 'Sure? Archive');
    await expect(
      await withPlatformPrisma((prisma) =>
        prisma.campaign.findUniqueOrThrow({
          where: { id: created.id },
          select: { deletedAt: true },
        }),
      ),
    ).toEqual({ deletedAt: null });
    await sure.click();
    await page.waitForURL(/\/campaigns\?ok=CAMPAIGN_ARCHIVED/);
    const archived = await withPlatformPrisma((prisma) =>
      prisma.campaign.findUniqueOrThrow({
        where: { id: created.id },
        select: { status: true, deletedAt: true },
      }),
    );
    expect(archived.status).toBe('ARCHIVED');
    expect(archived.deletedAt).not.toBeNull();
  });

  test(`Escape and Cancel close the dialog without saving (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-e-camp-close-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/campaigns?new=1`);
    await expect(page.getByTestId('campaign-new-dialog')).toBeVisible();
    await page.getByTestId('campaign-name').fill('Not saved');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('campaign-new-dialog')).toHaveCount(0);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/campaigns?new=1`);
    await page.getByTestId('campaign-cancel').click();
    await expect(page.getByTestId('campaign-new-dialog')).toHaveCount(0);
    expect(
      await withPlatformPrisma((prisma) =>
        prisma.campaign.count({ where: { workspaceId: own.workspaceId, name: 'Not saved' } }),
      ),
    ).toBe(0);
  });
}
