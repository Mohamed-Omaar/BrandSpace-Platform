import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { hashPassword } from '@brandspace/auth';
import { DASHBOARD_BASE_URL } from './apps';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * PERF A (#2, #4) — WHAT IS ASKED ONCE PER REQUEST IS STILL ASKED ON EVERY
 * REQUEST.
 *
 * The session, the workspace list, the membership, the role and its
 * permissions are now resolved once per request instead of several times. They
 * are never kept between requests, so each change below must take effect on the
 * very next page: a changed role, a removed membership and a revoked session.
 *
 * A member of its own, made for this test, so no other suite signing in as a
 * seeded person sees the role change.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function freshMember(roleKey: string): Promise<{ email: string; password: string }> {
  const { customer } = credentials();
  const email = `e2e-fresh-${randomUUID().slice(0, 8)}@brandspace.test`;
  const password = `e2e-${randomBytes(18).toString('base64url')}`;
  await withPlatformPrisma(async (prisma) => {
    const user = await prisma.user.create({
      data: {
        email,
        name: 'Fresh Member',
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
        workspaceId: customer.workspaceId,
        userId: user.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
  });
  return { email, password };
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  const { customer } = credentials();
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  const pick = page.getByTestId(`choose-workspace-${customer.workspaceSlug}`);
  if (await pick.count()) await pick.click();
  await page.waitForURL(/\/en\/(overview|content|calendar|approvals)/);
}

async function setRole(email: string, roleKey: string): Promise<void> {
  const { customer } = credentials();
  await withPlatformPrisma(async (prisma) => {
    const role = await prisma.role.findFirstOrThrow({
      where: { key: roleKey, workspaceId: null },
      select: { id: true },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    await prisma.membership.updateMany({
      where: { userId: user.id, workspaceId: customer.workspaceId },
      data: { roleId: role.id },
    });
  });
}

// `member.read`: a copywriter holds it, a read-only viewer does not.
const members = `${DASHBOARD_BASE_URL}/en/members`;

test.describe('PERF A · per-request answers are never kept between requests', () => {
  test('a changed role takes effect on the next request, both ways', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one size is enough for the server');
    const { email, password } = await freshMember('copywriter');
    await signIn(page, email, password);
    await page.goto(members);
    await expect(page.getByTestId('route-no-access')).toHaveCount(0);

    await setRole(email, 'client_viewer');
    // The very next request: a read-only viewer is told the page is not open
    // to their role (the product's "No access to this page" screen).
    await page.goto(members);
    await expect(page.getByTestId('route-no-access')).toBeVisible();

    await setRole(email, 'copywriter');
    await page.goto(members);
    await expect(page.getByTestId('route-no-access')).toHaveCount(0);
  });

  test('a removed member is out on the next request', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one size is enough for the server');
    const { customer } = credentials();
    const { email, password } = await freshMember('copywriter');
    await signIn(page, email, password);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page).toHaveURL(/\/en\/overview$/);

    await withPlatformPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      await prisma.membership.updateMany({
        where: { userId: user.id, workspaceId: customer.workspaceId },
        data: { status: 'REMOVED' },
      });
    });
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    // A member of nothing has a page for exactly that (requireWorkspace).
    await expect(page).toHaveURL(/\/en\/(no-workspace|workspaces)/);
  });

  test('a revoked session is signed out on the next request, as before', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one size is enough for the server');
    const { email, password } = await freshMember('copywriter');
    await signIn(page, email, password);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page).toHaveURL(/\/en\/overview$/);

    await withPlatformPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      await prisma.customerSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });

  test('an expired session is signed out on the next request, as before', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one size is enough for the server');
    const { email, password } = await freshMember('copywriter');
    await signIn(page, email, password);
    await withPlatformPrisma(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
      await prisma.customerSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
    });
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });
});
