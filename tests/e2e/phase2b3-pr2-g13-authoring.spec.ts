import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, noSeriousViolations, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PHASE 2B-3, PR 2 — AUTHORING A G13 AUTOMATION, AND READING ITS RUNS, IN
 * ENGLISH AND IN ARABIC (RTL).
 *
 * One case per language, each in a workspace of its own:
 *
 *   - the trigger picker offers exactly the three G13 triggers, and none of
 *     the four retired ones;
 *   - each trigger offers exactly its G13 actions (the compatibility table);
 *   - "Notify a chosen person" and "Add to a campaign" show their picker,
 *     the next Tab stop after the action; the other two need none;
 *   - a rule created through the form is listed without a caption, while a
 *     stored rule of a retired shape keeps "(older automation)";
 *   - Run history reads every reason in words — a typed skip, a block, an
 *     existing code, and an unknown code through the fallback — and never
 *     prints a code;
 *   - axe finds nothing serious.
 *
 * The rules and runs a case reads are SEEDED through the platform client; the
 * one it creates goes through the screen. The engine behind each outcome is
 * proven on real PostgreSQL in tests/isolation.
 */

interface Seeded {
  readonly ws: OwnWorkspace;
  readonly campaignName: string;
  readonly olderRuleId: string;
  readonly runs: Readonly<Record<'inReview' | 'recipient' | 'lostPermission' | 'unknown', string>>;
}

async function seed(label: string): Promise<Seeded> {
  const ws = await ownWorkspace(label);
  const campaignName = `Autumn launch ${randomUUID().slice(0, 4)}`;
  const olderRuleId = randomUUID();
  const copyRuleId = randomUUID();
  const runs = {
    inReview: randomUUID(),
    recipient: randomUUID(),
    lostPermission: randomUUID(),
    unknown: randomUUID(),
  };
  await withPlatformPrisma(async (prisma) => {
    await prisma.campaign.create({
      data: {
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        name: campaignName,
        objective: 'ENGAGEMENT',
        status: 'ACTIVE',
        createdByUserId: ws.ownerId,
      },
    });
    const rule = (
      id: string,
      name: string,
      triggerType: string,
      actionType: string,
      actionConfig: object,
    ) =>
      prisma.automationRule.create({
        data: {
          id,
          workspaceId: ws.workspaceId,
          brandId: ws.brandId,
          name,
          enabled: false,
          triggerType: triggerType as never,
          triggerConfig: (triggerType === 'SCHEDULED_TIME'
            ? { hourLocal: 9, daysOfWeek: [] }
            : {}) as never,
          conditions: [],
          actionType: actionType as never,
          actionConfig: actionConfig as never,
          maxRunsPerDay: 0,
          createdByUserId: ws.ownerId,
        },
      });
    // A stored rule of a retired shape, and a G13 rule the runs belong to.
    await rule(olderRuleId, 'Morning digest', 'SCHEDULED_TIME', 'NOTIFY', {
      templateKey: 'automation.notice',
    });
    await rule(copyRuleId, 'Copy approved posts', 'CONTENT_APPROVED', 'MAKE_DRAFT_COPY', {});
    const run = (id: string, status: string, failureCode: string, actionType: string) =>
      prisma.automationRun.create({
        data: {
          id,
          workspaceId: ws.workspaceId,
          brandId: ws.brandId,
          ruleId: copyRuleId,
          status: status as never,
          failureCode,
          triggerType: 'CONTENT_APPROVED',
          idempotencyKey: `e2e-g13-${id}`,
          actionType: actionType as never,
          correlationId: randomUUID(),
          finishedAt: new Date(),
          durationMs: 0,
        },
      });
    await run(runs.inReview, 'SKIPPED', 'content_in_review', 'ADD_TO_CAMPAIGN');
    await run(runs.recipient, 'BLOCKED_BY_POLICY', 'recipient_unavailable', 'NOTIFY_PERSON');
    await run(
      runs.lostPermission,
      'BLOCKED_BY_AUTHORIZATION',
      'creator_lost_permission',
      'MAKE_DRAFT_COPY',
    );
    await run(runs.unknown, 'FAILED', 'internal', 'MAKE_DRAFT_COPY');
  });
  return { ws, campaignName, olderRuleId, runs };
}

const values = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));

const COPY = {
  en: {
    trigger: 'When a post fails to publish',
    actions: [
      'Schedule in the next free slot',
      'Notify a chosen person',
      'Add to a campaign',
      'Make a draft copy',
    ],
    person: 'Person to notify',
    campaign: 'Campaign',
    older: '(older automation)',
    skipped: 'Skipped',
    inReview: "Skipped — this post is waiting for review, so it wasn't changed.",
    recipient:
      'Not sent — the person this automation notifies is no longer an active member with access to this brand. Edit the rule to choose someone else.',
    lostPermission:
      'Not run — the person who created this automation no longer has permission for this action.',
    fallback: 'Something went wrong running this automation.',
  },
  ar: {
    trigger: 'عند فشل نشر منشور',
    actions: ['جدولة في أول موعد متاح', 'تنبيه شخص محدد', 'إضافة إلى حملة', 'إنشاء نسخة مسودة'],
    person: 'الشخص المراد تنبيهه',
    campaign: 'الحملة',
    older: '(أتمتة أقدم)',
    skipped: 'تم التخطي',
    inReview: 'تم التخطي — هذا المنشور بانتظار المراجعة، لذلك لم يُعدَّل.',
    recipient:
      'لم يُرسل — الشخص الذي تنبّهه هذه الأتمتة لم يعد عضوًا نشطًا له صلاحية على هذه العلامة التجارية. عدّل القاعدة واختر شخصًا آخر.',
    lostPermission: 'لم تُشغَّل — منشئ هذه الأتمتة لم تعد لديه صلاحية هذا الإجراء.',
    fallback: 'حدث خطأ أثناء تشغيل هذه الأتمتة.',
  },
} as const;

async function journey(page: Page, locale: 'en' | 'ar', seeded: Seeded): Promise<void> {
  const copy = COPY[locale];
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations`);
  if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // --- The catalogue: exactly the three G13 triggers ---------------------------
  expect(await values(page, 'automation-trigger')).toEqual([
    'CONTENT_APPROVED',
    'POST_PUBLISHED',
    'POST_FAILED',
  ]);
  await expect(page.getByTestId('automation-trigger')).toContainText(copy.trigger);

  // --- Each trigger's actions: the compatibility table ------------------------
  await page.getByTestId('automation-trigger').selectOption('POST_FAILED');
  expect(await values(page, 'automation-action')).toEqual(['NOTIFY_PERSON', 'MAKE_DRAFT_COPY']);
  expect(await values(page, 'automation-condition-field')).toContain('publish.failureClass');
  await page.getByTestId('automation-trigger').selectOption('CONTENT_APPROVED');
  expect(await values(page, 'automation-action')).toEqual([
    'SCHEDULE_NEXT_FREE_SLOT',
    'NOTIFY_PERSON',
    'ADD_TO_CAMPAIGN',
    'MAKE_DRAFT_COPY',
  ]);
  for (const label of copy.actions) {
    await expect(page.getByTestId('automation-action')).toContainText(label);
  }

  // --- The action's own settings, and the keyboard reaches them ---------------
  const action = page.getByTestId('automation-action');
  await expect(action).toHaveValue('SCHEDULE_NEXT_FREE_SLOT');
  await expect(page.getByTestId('automation-action-person')).toHaveCount(0);
  await expect(page.getByTestId('automation-action-campaign')).toHaveCount(0);

  await action.selectOption('NOTIFY_PERSON');
  const person = page.getByTestId('automation-action-person');
  await expect(person).toBeVisible();
  await expect(page.locator('label', { has: person })).toContainText(copy.person);
  await expect(person.locator('option')).not.toHaveCount(0);
  // The picker is the next stop after the action, by Tab.
  await action.focus();
  await page.keyboard.press('Tab');
  await expect(person).toBeFocused();

  await action.selectOption('ADD_TO_CAMPAIGN');
  const campaign = page.getByTestId('automation-action-campaign');
  await expect(campaign).toBeVisible();
  await expect(page.locator('label', { has: campaign })).toContainText(copy.campaign);
  await expect(campaign).toContainText(seeded.campaignName);
  await expect(page.getByTestId('automation-action-person')).toHaveCount(0);
  await action.focus();
  await page.keyboard.press('Tab');
  await expect(campaign).toBeFocused();

  await action.selectOption('MAKE_DRAFT_COPY');
  await expect(page.getByTestId('automation-action-person')).toHaveCount(0);
  await expect(page.getByTestId('automation-action-campaign')).toHaveCount(0);
  await action.selectOption('ADD_TO_CAMPAIGN');

  // --- A rule created through the form, submitted from the keyboard -----------
  const name = `G13 ${locale} ${randomUUID().slice(0, 6)}`;
  await page.getByTestId('automation-name').fill(name);
  await page.getByTestId('automation-submit').focus();
  await page.keyboard.press('Enter');
  const rules = page.getByTestId('automation-rules');
  await expect(rules).toContainText(name);
  await expect(rules).toContainText(copy.actions[2]);
  const created = await withPlatformPrisma((prisma) =>
    prisma.automationRule.findFirstOrThrow({
      where: { workspaceId: seeded.ws.workspaceId, name },
      select: { id: true, actionType: true, actionConfig: true, enabled: true },
    }),
  );
  expect(created.actionType).toBe('ADD_TO_CAMPAIGN');
  expect(created.enabled).toBe(false);
  expect(created.actionConfig).toMatchObject({ campaignId: expect.any(String) });
  // A G13 rule carries no caption; a stored retired shape keeps its own.
  await expect(page.getByTestId(`automation-older-${created.id}`)).toHaveCount(0);
  await expect(page.getByTestId(`automation-older-${seeded.olderRuleId}`)).toContainText(
    copy.older,
  );

  // --- Run history, in words ---------------------------------------------------
  const { runs } = seeded;
  await expect(page.getByTestId(`automation-run-status-${runs.inReview}`)).toHaveText(copy.skipped);
  await expect(page.getByTestId(`automation-run-failure-${runs.inReview}`)).toHaveText(
    copy.inReview,
  );
  await expect(page.getByTestId(`automation-run-failure-${runs.recipient}`)).toHaveText(
    copy.recipient,
  );
  await expect(page.getByTestId(`automation-run-failure-${runs.lostPermission}`)).toHaveText(
    copy.lostPermission,
  );
  await expect(page.getByTestId(`automation-run-failure-${runs.unknown}`)).toHaveText(
    copy.fallback,
  );
  const history = page.getByTestId('automation-runs');
  for (const code of [
    'content_in_review',
    'recipient_unavailable',
    'creator_lost_permission',
    'internal',
  ]) {
    await expect(history).not.toContainText(code);
  }

  await noSeriousViolations(page);
}

test.describe('Phase 2B-3 PR 2 · G13 authoring and run history', () => {
  test('G13 authoring, action settings and run history — English (LTR)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('g13-en');
    await enter(page, seeded.ws.slug);
    await journey(page, 'en', seeded);
  });

  test('G13 authoring, action settings and run history — Arabic (RTL)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('g13-ar');
    await enter(page, seeded.ws.slug, 'ar');
    await journey(page, 'ar', seeded);
  });
});
