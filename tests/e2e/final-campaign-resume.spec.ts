import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * FINAL REVIEW (owner, item 5) — ONE PRESS ON RESUME RESUMES A PAUSED CAMPAIGN.
 *
 * The prototype's card toggle (Main.dc.html L1198): a paused card shows the
 * play glyph and "Resume". One press makes it running again, audited as a
 * person's resume. The permission is Pause's own, `campaigns.manage`: a member
 * without it sees neither control (and the action itself requires it).
 */

async function pausedCampaign(own: OwnWorkspace): Promise<string> {
  const id = randomUUID();
  await withPlatformPrisma((prisma) =>
    prisma.campaign.create({
      data: {
        id,
        workspaceId: own.workspaceId,
        brandId: own.brandId,
        name: 'Autumn launch',
        objective: 'LAUNCH',
        status: 'PAUSED',
        createdByUserId: own.ownerId,
      },
    }),
  );
  return id;
}

for (const locale of ['en', 'ar'] as const) {
  test(`Resume on a paused card runs the campaign again in one press (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`resume-${locale}`);
    const campaignId = await pausedCampaign(own);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/campaigns?status=PAUSED`);

    const resume = page.getByTestId(`campaign-resume-${campaignId}`);
    await expect(resume).toHaveText(locale === 'ar' ? 'استئناف' : 'Resume');
    await resume.click();
    await page.waitForURL(/\/campaigns\?status=ACTIVE&ok=CAMPAIGN_RESUMED$/);
    // Running again: the card offers Pause, not Resume.
    await expect(page.getByTestId(`campaign-resume-${campaignId}`)).toHaveCount(0);
    await expect(page.getByTestId(`campaign-pause-${campaignId}`)).toBeVisible();

    const stored = await withPlatformPrisma(async (prisma) => ({
      campaign: await prisma.campaign.findUniqueOrThrow({
        where: { id: campaignId },
        select: { status: true },
      }),
      audit: await prisma.auditEvent.findFirst({
        where: { workspaceId: own.workspaceId, resourceId: campaignId },
        orderBy: { occurredAt: 'desc' },
        select: { reason: true, actorId: true },
      }),
    }));
    expect(stored.campaign.status).toBe('ACTIVE');
    expect(stored.audit).toMatchObject({ reason: 'manual_resume', actorId: own.ownerId });
  });
}

test('a member without campaigns.manage sees no Resume (or Pause)', async ({ page, isMobile }) => {
  test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
  const own = await ownWorkspace('resume-no-manage');
  const campaignId = await pausedCampaign(own);
  // The owner's own grants, less `campaigns.manage`, as a custom role.
  await withPlatformPrisma(async (prisma) => {
    const membership = await prisma.membership.findFirstOrThrow({
      where: { workspaceId: own.workspaceId, userId: own.ownerId },
      select: { id: true, roleId: true },
    });
    const grants = await prisma.rolePermission.findMany({
      where: { roleId: membership.roleId, permission: { key: { not: 'campaigns.manage' } } },
      select: { permissionId: true },
    });
    const role = await prisma.role.create({
      data: {
        workspaceId: own.workspaceId,
        key: `no-campaign-manage-${randomUUID().slice(0, 8)}`,
        nameEn: 'Campaign reader',
        nameAr: 'قارئ الحملات',
        permissions: { create: grants.map((grant) => ({ permissionId: grant.permissionId })) },
      },
      select: { id: true },
    });
    await prisma.membership.update({ where: { id: membership.id }, data: { roleId: role.id } });
  });
  await enter(page, own.slug, 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns?status=PAUSED`);
  await expect(page.getByTestId(`campaign-open-${campaignId}`)).toBeVisible();
  await expect(page.getByTestId(`campaign-resume-${campaignId}`)).toHaveCount(0);
  await expect(page.getByTestId(`campaign-pause-${campaignId}`)).toHaveCount(0);
});
