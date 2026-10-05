import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, ownWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * REVIEW OF #67 — THE SMALL ELEMENTS THE PROTOTYPE DRAWS, BUILT FOR REAL.
 *
 * Each reads existing data, in a workspace of the suite's own so the figures
 * are exactly what this file wrote: the seat count against the plan's seat
 * quota, the plan card's usage bars, a rule's "Listens to …" and run count, the
 * On/Off chip, the rule summary box, the bell's "Mark all as read", and
 * sign-in's Show button and "Create account" line. Nothing depends on the date.
 */

test.describe('review of #67 · the prototype’s small elements, from real data', () => {
  test.skip(
    ({ isMobile }) => isMobile === true,
    'one run creates its own workspace; the desktop run covers it',
  );

  test('Team counts seats against the plan, and Billing draws usage against it', async ({
    page,
  }) => {
    const own = await ownWorkspace('r67-seats');
    await withPlatformPrisma(async (prisma) => {
      const operator = await prisma.platformUser.findFirstOrThrow({ select: { id: true } });
      for (const [featureKey, limitValue] of [
        ['limit.seats', 8],
        ['limit.social_accounts', 12],
      ] as const) {
        await prisma.workspaceOverride.create({
          data: {
            workspaceId: own.workspaceId,
            featureKey,
            enabled: true,
            limitValue,
            reason: 'r67 small-elements fixture',
            grantedByPlatformUserId: operator.id,
          },
        });
      }
    });
    await enter(page, own.slug);

    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    await expect(page.getByTestId('members-seats')).toHaveText('1 of 8 seats used');

    await page.goto(`${DASHBOARD_BASE_URL}/en/billing`);
    const accounts = page.getByTestId('billing-usage-social-accounts');
    await expect(accounts).toContainText('Connected accounts');
    await expect(accounts).toContainText('0 / 12');
  });

  test('a rule says what it listens to, how often it ran, and On or Off', async ({ page }) => {
    const own = await ownWorkspace('r67-rule');
    const ruleId = await withPlatformPrisma(async (prisma) => {
      const rule = await prisma.automationRule.create({
        data: {
          workspaceId: own.workspaceId,
          brandId: own.brandId,
          name: 'Notify on approval',
          enabled: true,
          triggerType: 'CONTENT_APPROVED',
          actionType: 'NOTIFY',
          createdByUserId: own.ownerId,
        },
        select: { id: true },
      });
      for (let index = 0; index < 2; index += 1) {
        await prisma.automationRun.create({
          data: {
            workspaceId: own.workspaceId,
            brandId: own.brandId,
            ruleId: rule.id,
            status: 'SUCCEEDED',
            triggerType: 'CONTENT_APPROVED',
            actionType: 'NOTIFY',
            idempotencyKey: `r67-${rule.id}-${index}`,
            correlationId: randomUUID(),
            finishedAt: new Date(),
          },
        });
      }
      return rule.id;
    });
    await enter(page, own.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);

    await expect(page.getByTestId(`automation-listens-${ruleId}`)).toHaveText(
      'Listens to Approvals',
    );
    await expect(page.getByTestId(`automation-ran-${ruleId}`)).toHaveText(/^Ran 2 times · last /);
    await expect(page.getByTestId(`automation-state-${ruleId}`)).toHaveText('On');

    // The dialog's "The rule" box is drawn before anything is chosen, and reads
    // the rule back once a trigger is picked.
    await page.getByTestId('automation-new').click();
    const summary = page.getByTestId('automation-preview');
    await expect(summary).toContainText('The rule');
    await expect(summary).toContainText('Choose when it runs and what it does.');
    await page.getByTestId('automation-trigger-CONTENT_APPROVED').check();
    await expect(summary).toContainText('When content is approved');
  });

  test('the bell’s “Mark all as read” marks the reader’s notes read', async ({ page }) => {
    const own = await ownWorkspace('r67-bell');
    await withPlatformPrisma(async (prisma) => {
      await prisma.notification.create({
        data: {
          workspaceId: own.workspaceId,
          userId: own.ownerId,
          brandId: own.brandId,
          templateKey: 'approval.requested',
          payload: { itemTitle: 'Weekend brunch' },
          linkPath: '/approvals',
          idempotencyKey: `r67-bell-${own.slug}`,
        },
      });
    });
    await enter(page, own.slug);
    await expect(page.getByTestId('topbar-notifications-dot')).toHaveText('1');

    await page.getByTestId('topbar-notifications').click();
    const feed = page.getByTestId('notifications-feed');
    await expect(feed.locator('[data-unread="true"]')).toHaveCount(1);
    await feed.getByTestId('notifications-mark-all').click();
    await page.waitForURL(/\/en\/notifications/);
    await expect(page.getByTestId('topbar-notifications-dot')).toHaveCount(0);
  });
});

test.describe('review of #67 · sign-in', () => {
  test('Show reveals the password, and “Create account” leads to sign-up', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    const password = page.locator('#password');
    await password.fill('a-secret-phrase');
    await expect(password).toHaveAttribute('type', 'password');
    await page.getByTestId('signin-password-show').click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(page.getByTestId('signin-password-show')).toHaveText('Hide');
    await expect(page.getByTestId('signin-forgot')).toHaveAttribute('href', '/en/reset');
    await expect(page.getByTestId('signin-create-account')).toHaveAttribute('href', '/en/sign-up');
  });
});
