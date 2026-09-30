import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, noSeriousViolations, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PHASE 2B-3, PR 4 — AUTHORING THE ANALYTICS AUTOMATIONS, IN ENGLISH AND IN
 * ARABIC (RTL).
 *
 * One case per language, each in a workspace of its own, against the operator
 * thresholds `seed-automation-events.ts` activates:
 *
 *   - the trigger picker offers the two analytics events after the timed ones,
 *     choosable, with the approved words and without "not available yet";
 *   - the weekly drop offers "Notify a chosen person" and no condition (the
 *     event is the condition); the top 10% offers "Notify a chosen person" and
 *     "Make a draft copy", and its post's own fields;
 *   - "When weekly engagement drops" × "Notify a chosen person" and "When a
 *     post ranks in your top 10%" × "Make a draft copy" are created from the
 *     keyboard, stored switched off and armed, and listed without a caption;
 *   - Run history reads a top-post run skipped at delivery in words, never as
 *     a code;
 *   - axe finds nothing serious.
 *
 * The run a case reads is SEEDED through the platform client; the rules it
 * creates go through the screen. Both producers, the arithmetic and the
 * delivery re-check are proven on real PostgreSQL in
 * tests/isolation/phase2b3-pr4-*; the "not available yet" state, which needs
 * the thresholds unset, in tests/unit/phase2b3-pr4-*.
 */

interface Seeded {
  readonly ws: OwnWorkspace;
  readonly staleRun: string;
}

async function seed(label: string): Promise<Seeded> {
  const ws = await ownWorkspace(label);
  const ruleId = randomUUID();
  const staleRun = randomUUID();
  await withPlatformPrisma(async (prisma) => {
    await prisma.automationRule.create({
      data: {
        id: ruleId,
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        name: 'Copy our best posts',
        enabled: false,
        triggerType: 'POST_TOP_10_PERCENT',
        triggerConfig: {},
        conditions: [],
        actionType: 'MAKE_DRAFT_COPY',
        actionConfig: {},
        maxRunsPerDay: 0,
        createdByUserId: ws.ownerId,
      },
    });
    await prisma.automationRun.create({
      data: {
        id: staleRun,
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        ruleId,
        status: 'SKIPPED',
        failureCode: 'occurrence_stale',
        triggerType: 'POST_TOP_10_PERCENT',
        idempotencyKey: `e2e-pr4-${staleRun}`,
        actionType: 'MAKE_DRAFT_COPY',
        correlationId: randomUUID(),
        finishedAt: new Date(),
        durationMs: 0,
      },
    });
  });
  return { ws, staleRun };
}

const values = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .locator('option')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));

const disabled = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .locator('option')
    .evaluateAll((nodes) =>
      nodes.filter((node) => (node as HTMLOptionElement).disabled).map((node) => node.textContent),
    );

const COPY = {
  en: {
    weekly: 'When weekly engagement drops by 20% or more',
    top: 'When a post ranks in your top 10%',
    unavailable: 'not available yet',
    notify: 'Notify a chosen person',
    copy: 'Make a draft copy',
    skipped: 'Skipped',
    stale: 'Skipped — what started this automation had changed by the time it ran.',
  },
  ar: {
    weekly: 'عند انخفاض التفاعل الأسبوعي بنسبة 20% أو أكثر',
    top: 'عند وصول منشور إلى أفضل 10% من منشوراتك',
    unavailable: 'غير متاح بعد',
    notify: 'تنبيه شخص محدد',
    copy: 'إنشاء نسخة مسودة',
    skipped: 'تم التخطي',
    stale: 'تم التخطي — تغيّر ما أطلق هذه الأتمتة قبل تشغيلها.',
  },
} as const;

/** The post's own fields: the top 10% names its post directly. */
const CONTENT_FIELDS = [
  'content.channels',
  'content.campaignId',
  'content.hasCampaign',
  'content.type',
  'content.authorUserId',
];

async function create(page: Page, name: string): Promise<void> {
  await page.getByTestId('automation-name').fill(name);
  await page.getByTestId('automation-submit').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('automation-rules')).toContainText(name);
}

async function stored(workspaceId: string, name: string) {
  return withPlatformPrisma((prisma) =>
    prisma.automationRule.findFirstOrThrow({
      where: { workspaceId, name },
      select: {
        id: true,
        triggerType: true,
        actionType: true,
        actionConfig: true,
        conditions: true,
        enabled: true,
        armedAt: true,
      },
    }),
  );
}

async function journey(page: Page, locale: 'en' | 'ar', seeded: Seeded): Promise<void> {
  const copy = COPY[locale];
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations`);
  if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  const trigger = page.getByTestId('automation-trigger');
  const action = page.getByTestId('automation-action');
  await expect(trigger).toHaveValue('');

  // --- The catalogue: the analytics events after the timed ones, choosable ----
  expect((await values(page, 'automation-trigger')).slice(-2)).toEqual([
    'WEEKLY_ENGAGEMENT_DROPPED',
    'POST_TOP_10_PERCENT',
  ]);
  await expect(trigger).toContainText(copy.weekly);
  await expect(trigger).toContainText(copy.top);
  await expect(trigger).not.toContainText(copy.unavailable);
  expect(await disabled(page, 'automation-trigger')).toEqual([]);

  // --- Each event: its actions and its conditions ------------------------------
  await trigger.selectOption('WEEKLY_ENGAGEMENT_DROPPED');
  await expect(action).toHaveValue('');
  expect(await values(page, 'automation-action')).toEqual(['', 'NOTIFY_PERSON']);
  // No condition to choose: the event is the condition.
  expect(await values(page, 'automation-condition-field')).toEqual(['']);

  await trigger.selectOption('POST_TOP_10_PERCENT');
  await expect(action).toHaveValue('');
  expect(await values(page, 'automation-action')).toEqual(['', 'NOTIFY_PERSON', 'MAKE_DRAFT_COPY']);
  await expect(action).toContainText(copy.notify);
  await expect(action).toContainText(copy.copy);
  expect(await values(page, 'automation-condition-field')).toEqual(['', ...CONTENT_FIELDS]);
  await noSeriousViolations(page);

  // --- The weekly drop × notify a person, from the keyboard --------------------
  await trigger.selectOption('WEEKLY_ENGAGEMENT_DROPPED');
  await action.selectOption('NOTIFY_PERSON');
  const person = page.getByTestId('automation-action-person');
  await expect(person).toBeVisible();
  await action.focus();
  await page.keyboard.press('Tab');
  await expect(person).toBeFocused();
  const weeklyName = `Weekly ${locale} ${randomUUID().slice(0, 6)}`;
  await create(page, weeklyName);
  const weekly = await stored(seeded.ws.workspaceId, weeklyName);
  expect(weekly).toMatchObject({
    triggerType: 'WEEKLY_ENGAGEMENT_DROPPED',
    actionType: 'NOTIFY_PERSON',
    actionConfig: { userId: expect.any(String) },
    conditions: [],
    enabled: false,
  });
  expect(weekly.armedAt).not.toBeNull();
  await expect(page.getByTestId(`automation-older-${weekly.id}`)).toHaveCount(0);

  // --- The top 10% × a draft copy, which needs no settings ---------------------
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations`);
  await trigger.selectOption('POST_TOP_10_PERCENT');
  await action.selectOption('MAKE_DRAFT_COPY');
  await expect(page.getByTestId('automation-action-person')).toHaveCount(0);
  await expect(page.getByTestId('automation-action-campaign')).toHaveCount(0);
  const topName = `Top ${locale} ${randomUUID().slice(0, 6)}`;
  await create(page, topName);
  const top = await stored(seeded.ws.workspaceId, topName);
  expect(top).toMatchObject({
    triggerType: 'POST_TOP_10_PERCENT',
    actionType: 'MAKE_DRAFT_COPY',
    actionConfig: {},
    enabled: false,
  });
  expect(top.armedAt).not.toBeNull();
  const rules = page.getByTestId('automation-rules');
  await expect(rules).toContainText(copy.weekly);
  await expect(rules).toContainText(copy.top);
  await expect(page.getByTestId(`automation-older-${top.id}`)).toHaveCount(0);

  // --- Run history: a top post re-checked at delivery, in words ---------------
  await expect(page.getByTestId(`automation-run-status-${seeded.staleRun}`)).toHaveText(
    copy.skipped,
  );
  await expect(page.getByTestId(`automation-run-failure-${seeded.staleRun}`)).toHaveText(
    copy.stale,
  );
  await expect(page.getByTestId('automation-runs')).not.toContainText('occurrence_stale');

  await noSeriousViolations(page);
}

test.describe('Phase 2B-3 PR 4 · analytics automations', () => {
  test('weekly drop and top 10% authoring, and a re-checked run — English (LTR)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('pr4-en');
    await enter(page, seeded.ws.slug);
    await journey(page, 'en', seeded);
  });

  test('weekly drop and top 10% authoring, and a re-checked run — Arabic (RTL)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('pr4-ar');
    await enter(page, seeded.ws.slug, 'ar');
    await journey(page, 'ar', seeded);
  });
});
