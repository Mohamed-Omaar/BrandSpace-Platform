import { expect, test, type Page } from '@playwright/test';
import { ConfigurationService } from '@brandspace/config';
import { DASHBOARD_BASE_URL } from './apps';
import { createFreshWorkspace, finishFreshOnboarding, freshSignUp } from './fresh-signup';
import { withPlatformPrisma } from './platform-prisma';

/**
 * ROUND 6 (D-481) — THE DEFAULT PUBLISHING CONFIGURATION, AS A NEW
 * ENVIRONMENT SHIPS IT: every channel disabled and text-only. A new customer
 * still sees why each format is dimmed, and which channels cannot be
 * connected yet; no press goes unanswered.
 *
 * RUN ON ITS OWN. The configuration is environment-wide: switching it to the
 * defaults changes what every other spec running beside this one sees. It runs
 * only when `BRANDSPACE_E2E_GLOBAL_CONFIG=1` (one worker, nothing else in the
 * run) and puts the configuration back afterwards. The configured case runs in
 * every suite: `r6-format-fit.spec.ts`.
 */

test.describe.configure({ mode: 'serial' });

const ENVIRONMENT = 'DEVELOPMENT' as const;
let saved: unknown = null;

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
    saved ??= await configuration.get('publishing', ENVIRONMENT);
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

const format = (page: Page, type: string) =>
  page.locator(`[data-testid="content-format"] button[data-value="${type}"]`);

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
  await activate(
    { ...(saved as Record<string, unknown>), providers: {} },
    'E2E: the default publishing configuration (round 6).',
  );
});

test.afterAll(async () => {
  if (process.env['BRANDSPACE_E2E_GLOBAL_CONFIG'] !== '1' || saved === null) return;
  await activate(saved, 'E2E: restore the publishing configuration (round 6).');
});

test('the default configuration: formats dimmed with their reason, no channel connectable', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile === true, 'one fresh workspace per run');
  test.setTimeout(180_000);
  await freshSignUp(page);
  await createFreshWorkspace(page);
  await finishFreshOnboarding(page);
  await page.goto(`${DASHBOARD_BASE_URL}/en/content/compose?mode=write`);
  await expect(page.getByTestId('content-composer')).toBeVisible();

  await expect(format(page, 'POST')).toHaveAttribute('aria-pressed', 'true');
  for (const type of ['CAROUSEL', 'REEL', 'STORY']) {
    await expect(format(page, type)).toHaveAttribute('data-unavailable', 'true');
    await expect(format(page, type)).toHaveAttribute('title', /isn’t set up for any channel/);
  }
  await expect(page.getByTestId('content-format-unavailable')).toHaveText(
    'Carousel, Reel, and Story: not set up for any channel yet.',
  );
  // The press answers: the format's own reason, and nothing is switched.
  await format(page, 'STORY').click({ force: true });
  await expect(page.getByTestId('content-format-fix')).toHaveText(
    'Story isn’t set up for any channel in this workspace yet.',
  );
  await expect(page.getByTestId('content-format-fix-apply')).toHaveCount(0);
  await expect(format(page, 'POST')).toHaveAttribute('aria-pressed', 'true');
  // No account can be connected yet, and the Studio says so beside "Post to".
  await expect(page.getByTestId('studio-connect-unavailable')).toContainText(
    'can’t be connected yet.',
  );
  await expect(page.getByTestId('studio-connect-line')).toHaveCount(0);
});
