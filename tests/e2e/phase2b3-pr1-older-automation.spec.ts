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

/**
 * A run SKIPPED because a value its rule names is no longer available (D-408).
 * Written the way the engine records one; the screen must not call it
 * "Conditions did not hold" and must not show the raw code.
 */
async function seedValueUnavailableRun(ws: OwnWorkspace, ruleId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await withPlatformPrisma((prisma) =>
    prisma.automationRun.create({
      data: {
        id,
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        ruleId,
        status: 'SKIPPED',
        failureCode: 'condition_value_unavailable',
        triggerType: 'CONTENT_APPROVED',
        idempotencyKey: `e2e-stale-${id}`,
        actionType: 'NOTIFY',
        correlationId: randomUUID(),
        finishedAt: now,
        durationMs: 0,
      },
    }),
  );
  return id;
}

const STALE_EN =
  "Skipped — something this rule's conditions name is no longer available (a campaign, person or brand). Edit the rule to choose a current one.";
const STALE_AR =
  'تم التخطي — شيء تذكره شروط هذه القاعدة لم يعد متاحًا (حملة أو شخص أو علامة تجارية). عدّل القاعدة واختر قيمة حالية.';

test.describe('Phase 2B-3 PR 1 · older automations', () => {
  test('the caption, the trigger name and a stale-value skip, in English and in Arabic (RTL)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('older-auto');
    const older = await seedRule(ws, { name: 'Old anomaly note', triggerType: 'ANOMALY_DETECTED' });
    const current = await seedRule(ws, { name: 'Approval note', triggerType: 'CONTENT_APPROVED' });
    const staleRun = await seedValueUnavailableRun(ws, current);
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
    // A stale-value skip: its own label and the localized reason, no raw code.
    await expect(page.getByTestId(`automation-run-status-${staleRun}`)).toHaveText('Skipped');
    await expect(page.getByTestId(`automation-run-failure-${staleRun}`)).toHaveText(STALE_EN);
    await expect(page.getByTestId(`automation-run-${staleRun}`)).not.toContainText(
      'Conditions did not hold',
    );
    await expect(page.getByTestId(`automation-run-${staleRun}`)).not.toContainText(
      'condition_value_unavailable',
    );
    await noSeriousViolations(page);

    // --- Arabic, right to left ----------------------------------------------
    await page.goto(`${DASHBOARD_BASE_URL}/ar/automations`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('automation-rules')).toContainText('عند رصد تغيّر غير معتاد');
    await expect(page.getByTestId(`automation-older-${older}`)).toContainText('(أتمتة أقدم)');
    await expect(page.getByTestId(`automation-older-${current}`)).toHaveCount(0);
    await expect(page.getByTestId(`automation-run-status-${staleRun}`)).toHaveText('تم التخطي');
    await expect(page.getByTestId(`automation-run-failure-${staleRun}`)).toHaveText(STALE_AR);
    await expect(page.getByTestId(`automation-run-${staleRun}`)).not.toContainText(
      'لم تتحقق الشروط',
    );
    await expect(page.getByTestId(`automation-run-${staleRun}`)).not.toContainText(
      'condition_value_unavailable',
    );
    await noSeriousViolations(page);
  });
});
