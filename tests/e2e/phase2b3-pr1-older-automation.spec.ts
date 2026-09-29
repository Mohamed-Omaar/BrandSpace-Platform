import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, noSeriousViolations, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Phase 2B-3, PR 1 — AN OLDER AUTOMATION SAYS SO, in English and in Arabic.
 *
 * A stored rule whose trigger a new rule could not use any more — today, the
 * retired `ANOMALY_DETECTED` — keeps its place in the list with its controls,
 * shows its trigger's name (it used to render empty) and carries the
 * "(older automation)" caption. A current rule carries none, and the authoring
 * form never offers the retired trigger.
 *
 * The rule is SEEDED through the platform client in a workspace of this test's
 * own; the classification itself is proven in tests/unit and on PostgreSQL in
 * tests/isolation.
 */

async function seedRule(
  ws: OwnWorkspace,
  input: { name: string; triggerType: 'ANOMALY_DETECTED' | 'CONTENT_APPROVED' },
): Promise<string> {
  const id = randomUUID();
  await withPlatformPrisma((prisma) =>
    prisma.automationRule.create({
      data: {
        id,
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        name: input.name,
        enabled: false,
        triggerType: input.triggerType,
        triggerConfig: {},
        conditions: [],
        actionType: 'NOTIFY',
        actionConfig: { templateKey: 'automation.notice' },
        maxRunsPerDay: 0,
        createdByUserId: ws.ownerId,
      },
    }),
  );
  return id;
}

test.describe('Phase 2B-3 PR 1 · older automations', () => {
  test('the caption and the trigger name, in English and in Arabic (RTL)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('older-auto');
    const older = await seedRule(ws, { name: 'Old anomaly note', triggerType: 'ANOMALY_DETECTED' });
    const current = await seedRule(ws, { name: 'Approval note', triggerType: 'CONTENT_APPROVED' });
    await enter(page, ws.slug);

    // --- English, left to right ---------------------------------------------
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);
    const rules = page.getByTestId('automation-rules');
    await expect(rules).toContainText('Old anomaly note');
    await expect(rules).toContainText('When an anomaly is detected');
    await expect(page.getByTestId(`automation-older-${older}`)).toContainText('(older automation)');
    await expect(page.getByTestId(`automation-older-${current}`)).toHaveCount(0);
    // Its controls stay: it can still be edited, switched and deleted.
    await expect(page.getByTestId(`automation-edit-${older}`)).toBeVisible();
    await expect(page.getByTestId(`automation-delete-${older}`)).toBeVisible();
    // The retired trigger is never offered for a new rule.
    await expect(
      page.getByTestId('automation-trigger').locator('option[value="ANOMALY_DETECTED"]'),
    ).toHaveCount(0);
    await noSeriousViolations(page);

    // --- Arabic, right to left ----------------------------------------------
    await page.goto(`${DASHBOARD_BASE_URL}/ar/automations`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('automation-rules')).toContainText('عند رصد تغيّر غير معتاد');
    await expect(page.getByTestId(`automation-older-${older}`)).toContainText('(أتمتة أقدم)');
    await expect(page.getByTestId(`automation-older-${current}`)).toHaveCount(0);
    await noSeriousViolations(page);
  });
});
