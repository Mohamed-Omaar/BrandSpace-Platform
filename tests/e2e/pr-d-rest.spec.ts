import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { hashPassword } from '@brandspace/auth';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PR D — POSTS P1, MEDIA 1, TEAM 1, SETTINGS 8.
 *
 *   P1        "Review" on a post in review opens that post's own review.
 *   Media 1   Several files in one upload.
 *   Team 1    The role chips, read-only, for a reader who may not change them.
 *   Settings 8 "Copy" the set-up key, with a toast.
 */

/** A 1×1 PNG, distinct per call (its last byte), so the checksum key differs. */
function png(seed: number): Buffer {
  const base = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  return Buffer.concat([base, Buffer.from([seed])]);
}

/** A fresh person in the test's own workspace, with the given role. */
async function member(
  own: OwnWorkspace,
  roleKey: string,
): Promise<{ email: string; password: string }> {
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-pr-d-${suffix}@brandspace.test`;
  const password = `e2e-${randomUUID()}`;
  await withPlatformPrisma(async (prisma) => {
    const user = await prisma.user.create({
      data: {
        email,
        name: `PR D ${suffix}`,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        passwordHash: await hashPassword(password),
        locale: 'EN',
        timezone: 'UTC',
      },
      select: { id: true },
    });
    const role = await prisma.role.findFirstOrThrow({
      where: { key: roleKey, workspaceId: null },
      select: { id: true },
    });
    await prisma.membership.create({
      data: {
        workspaceId: own.workspaceId,
        userId: user.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
  });
  return { email, password };
}

async function signInAs(page: Page, email: string, password: string, slug: string, locale: string) {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  if (!page.url().includes('/overview')) {
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/workspaces`);
    await page.click(`[data-testid="choose-workspace-${slug}"]`);
    await page.waitForURL(new RegExp(`/${locale}/overview$`));
  }
}

for (const locale of ['en', 'ar'] as const) {
  test(`Review opens that post's own review (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    const own = await ownWorkspace(`pr-d-review-${locale}`);
    const { itemId, approvalId } = await withPlatformPrisma(async (prisma) => {
      const item = await prisma.contentItem.create({
        data: {
          workspaceId: own.workspaceId,
          brandId: own.brandId,
          title: `In review ${locale}`,
          contentType: 'POST',
          primaryLocale: 'EN',
          status: 'IN_REVIEW',
          createdByUserId: own.ownerId,
        },
        select: { id: true },
      });
      const approval = await prisma.approval.create({
        data: {
          workspaceId: own.workspaceId,
          brandId: own.brandId,
          contentItemId: item.id,
          requestedByUserId: own.ownerId,
          status: 'PENDING',
        },
        select: { id: true },
      });
      return { itemId: item.id, approvalId: approval.id };
    });
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/content`);
    await expect(page.getByTestId(`content-review-${itemId}`)).toHaveAttribute(
      'href',
      `/${locale}/approvals?review=${approvalId}`,
    );
  });

  test(`several files go up in one upload (${locale})`, async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    const own = await ownWorkspace(`pr-d-multi-${locale}`);
    await enter(page, own.slug, locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/assets`);
    await page.getByTestId('assets-upload-open').click();
    const input = page.getByTestId('assets-file-input');
    await expect(input).toHaveAttribute('multiple', '');
    await input.setInputFiles([
      { name: `one-${locale}.png`, mimeType: 'image/png', buffer: png(1) },
      { name: `two-${locale}.png`, mimeType: 'image/png', buffer: png(2) },
      { name: `three-${locale}.png`, mimeType: 'image/png', buffer: png(3) },
    ]);
    await page.getByTestId('assets-upload-submit').click();
    await page.waitForURL(/ok=ASSET_UPLOADED/, { timeout: 60_000 });
    const names = await withPlatformPrisma((prisma) =>
      prisma.asset.findMany({
        where: { workspaceId: own.workspaceId, deletedAt: null },
        select: { name: true },
      }),
    );
    expect(names.map((row) => row.name).sort()).toEqual(
      [`one-${locale}.png`, `three-${locale}.png`, `two-${locale}.png`].sort(),
    );
  });

  test(`a reader who may not change roles sees them read-only; Copy the set-up key (${locale})`, async ({
    page,
    context,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one workspace per run; the desktop run covers it');
    test.setTimeout(120_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const own = await ownWorkspace(`pr-d-team-${locale}`);
    // A Marketing Manager reads the team but does not assign roles.
    const reader = await member(own, 'marketing_manager');
    const ownerMembership = await withPlatformPrisma((prisma) =>
      prisma.membership.findFirstOrThrow({
        where: { workspaceId: own.workspaceId, userId: own.ownerId },
        select: { id: true },
      }),
    );
    await signInAs(page, reader.email, reader.password, own.slug, locale);

    // Team 1 — the chips, the owner's role pressed, nothing to press.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/members?member=${ownerMembership.id}`);
    const chips = page.getByTestId('member-role-readonly');
    await expect(chips).toBeVisible();
    await expect(chips.getByTestId('role-chip-workspace_owner')).toHaveAttribute(
      'aria-current',
      'true',
    );
    await expect(chips.locator('button')).toHaveCount(0);
    await expect(page.getByTestId('member-role')).toHaveCount(0);

    // Settings 8 — Copy puts the key on the clipboard and says so.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/settings/security`);
    await page.getByTestId('mfa-begin').click();
    await expect(page.getByTestId('mfa-enrolment-key')).toBeVisible();
    const key = ((await page.getByTestId('mfa-enrolment-key').textContent()) ?? '').replace(
      /\s+/g,
      '',
    );
    await page.getByTestId('mfa-enrolment-copy').click();
    await expect(page.getByTestId('mfa-enrolment-copy-toast')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  });
}
