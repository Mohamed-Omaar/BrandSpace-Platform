import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, noSeriousViolations, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';
import { openRuleMore } from './automation-form';

/**
 * PHASE 2B-3, PR 3 — AUTHORING THE TIMED AUTOMATIONS, AND READING THE
 * REMINDER'S RUNS, IN ENGLISH AND IN ARABIC (RTL).
 *
 * One case per language, each in a workspace of its own:
 *
 *   - the trigger picker offers the three PR 2 triggers and the five timed
 *     ones (and, since PR 4, the two analytics events after them), in the
 *     registry's order, with the approved words;
 *   - each timed trigger offers exactly its actions and its conditions: the
 *     waiting review its post's fields and "Remind the reviewer"; a campaign
 *     boundary the campaign, chosen from the brand's own; the schedule gap and
 *     the expiring fact nothing but "No condition";
 *   - nothing is chosen for the author, and changing the trigger keeps no
 *     action;
 *   - "When a post waits for review" × "Remind the reviewer" is created from
 *     the keyboard, needs no settings, and is listed without a caption;
 *   - Run history reads the reminder's two outcomes in words — "Skipped" for a
 *     review decided first, BLOCKED for nobody able to decide it — and never
 *     prints a code;
 *   - axe finds nothing serious.
 *
 * The runs a case reads are SEEDED through the platform client; the rule it
 * creates goes through the screen. Every producer and the reminder itself are
 * proven on real PostgreSQL in tests/isolation/phase2b3-pr3-*.
 */

interface Seeded {
  readonly ws: OwnWorkspace;
  readonly campaignName: string;
  readonly runs: Readonly<Record<'stale' | 'nobody', string>>;
}

async function seed(label: string): Promise<Seeded> {
  const ws = await ownWorkspace(label);
  const campaignName = `Winter sale ${randomUUID().slice(0, 4)}`;
  const reminderRuleId = randomUUID();
  const runs = { stale: randomUUID(), nobody: randomUUID() };
  await withPlatformPrisma(async (prisma) => {
    await prisma.campaign.create({
      data: {
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        name: campaignName,
        objective: 'AWARENESS',
        status: 'PLANNED',
        createdByUserId: ws.ownerId,
      },
    });
    await prisma.automationRule.create({
      data: {
        id: reminderRuleId,
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        name: 'Nudge reviewers',
        enabled: false,
        triggerType: 'REVIEW_WAITING_24H',
        triggerConfig: {},
        conditions: [],
        actionType: 'REMIND_REVIEWER',
        actionConfig: {},
        maxRunsPerDay: 0,
        createdByUserId: ws.ownerId,
      },
    });
    const run = (id: string, status: string, failureCode: string) =>
      prisma.automationRun.create({
        data: {
          id,
          workspaceId: ws.workspaceId,
          brandId: ws.brandId,
          ruleId: reminderRuleId,
          status: status as never,
          failureCode,
          triggerType: 'REVIEW_WAITING_24H',
          idempotencyKey: `e2e-pr3-${id}`,
          actionType: 'REMIND_REVIEWER',
          correlationId: randomUUID(),
          finishedAt: new Date(),
          durationMs: 0,
        },
      });
    await run(runs.stale, 'SKIPPED', 'occurrence_stale');
    await run(runs.nobody, 'BLOCKED_BY_POLICY', 'no_eligible_reviewer');
  });
  return { ws, campaignName, runs };
}

/*
 * D-468 — the event and the action are the prototype's grids of choices, real
 * radio buttons; the other pickers are still selects. Both read the same way.
 */
const values = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .locator('option, input[type="radio"]:not([value=""])')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
const chosen = (page: Page, testId: string) =>
  page.getByTestId(testId).locator('input[type="radio"]:checked');
const pick = (page: Page, testId: string, value: string) =>
  page.getByTestId(`${testId}-${value}`).check();

const COPY = {
  en: {
    // Round 3 — the tiles' own words (the prototype's).
    triggers: [
      'A post waits for review over 24 hours',
      'A campaign starts',
      'A campaign ends',
      'Nothing is scheduled for the next 3 days',
      'A Brand Brain fact expires within 7 days',
    ],
    remind: 'Remind the reviewer',
    campaignField: 'Campaign',
    skipped: 'Skipped',
    blocked: 'Stopped by policy',
    stale: 'Skipped — what started this automation had changed by the time it ran.',
    nobody: 'Not sent — no one who can review this post is available right now.',
  },
  ar: {
    triggers: [
      'منشور ينتظر المراجعة أكثر من 24 ساعة',
      'بدء حملة',
      'انتهاء حملة',
      'لا منشورات مجدولة في الأيام الثلاثة القادمة',
      'معلومة في Brand Brain تنتهي خلال 7 أيام',
    ],
    remind: 'تذكير المراجِع',
    campaignField: 'الحملة',
    skipped: 'تم التخطي',
    blocked: 'أوقفتها السياسة',
    stale: 'تم التخطي — تغيّر ما أطلق هذه الأتمتة قبل تشغيلها.',
    nobody: 'لم يُرسل — لا يوجد حاليًا من يمكنه مراجعة هذا المنشور.',
  },
} as const;

/** The post's own fields, which a waiting review reaches through its post. */
const CONTENT_FIELDS = [
  'content.channels',
  'content.campaignId',
  'content.hasCampaign',
  'content.type',
  'content.authorUserId',
];

async function journey(page: Page, locale: 'en' | 'ar', seeded: Seeded): Promise<void> {
  const copy = COPY[locale];
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations?new=1`);
  if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  const trigger = page.getByTestId('automation-trigger');
  const action = page.getByTestId('automation-action');
  await expect(chosen(page, 'automation-trigger')).toHaveCount(0);
  await expect(chosen(page, 'automation-action')).toHaveCount(0);

  // --- The catalogue: the PR 2 triggers and the five timed ones ---------------
  expect(await values(page, 'automation-trigger')).toEqual([
    'CONTENT_APPROVED',
    'POST_PUBLISHED',
    'POST_FAILED',
    'REVIEW_WAITING_24H',
    'CAMPAIGN_STARTED',
    'CAMPAIGN_ENDED',
    'SCHEDULE_GAP',
    'FACT_EXPIRING',
    'WEEKLY_ENGAGEMENT_DROPPED',
    'POST_TOP_10_PERCENT',
  ]);
  for (const label of copy.triggers) await expect(trigger).toContainText(label);

  // --- Each timed trigger: its actions and its conditions ---------------------
  await pick(page, 'automation-trigger', 'REVIEW_WAITING_24H');
  await expect(chosen(page, 'automation-action')).toHaveCount(0);
  expect(await values(page, 'automation-action')).toEqual(['NOTIFY_PERSON', 'REMIND_REVIEWER']);
  await expect(action).toContainText(copy.remind);
  // Round 3 — chips; "No condition" is the empty value the helper skips.
  expect(await values(page, 'automation-condition-field')).toEqual([...CONTENT_FIELDS]);

  for (const [boundary, actions] of [
    // Phase 2B-3 PR 5 — a campaign that starts may be paused (asks first).
    ['CAMPAIGN_STARTED', ['NOTIFY_PERSON', 'PAUSE_CAMPAIGN']],
    ['CAMPAIGN_ENDED', ['NOTIFY_PERSON']],
  ] as const) {
    await pick(page, 'automation-trigger', boundary);
    await expect(chosen(page, 'automation-action')).toHaveCount(0);
    expect(await values(page, 'automation-action')).toEqual(actions);
    expect(await values(page, 'automation-condition-field')).toEqual(['campaign.id']);
  }
  // The campaign is chosen from the brand's own, never typed.
  const field = page.getByTestId('automation-condition-field');
  await expect(field).toContainText(copy.campaignField);
  await page.getByTestId('automation-condition-field-campaign.id').check();
  await expect(page.getByTestId('automation-condition-value')).toContainText(seeded.campaignName);

  for (const state of ['SCHEDULE_GAP', 'FACT_EXPIRING']) {
    await pick(page, 'automation-trigger', state);
    await expect(chosen(page, 'automation-action')).toHaveCount(0);
    expect(await values(page, 'automation-action')).toEqual(['NOTIFY_PERSON']);
    // No condition to choose: the event is the condition.
    expect(await values(page, 'automation-condition-field')).toEqual([]);
  }
  await noSeriousViolations(page);

  // --- Remind the reviewer: no settings, created from the keyboard ------------
  await pick(page, 'automation-trigger', 'REVIEW_WAITING_24H');
  await pick(page, 'automation-action', 'REMIND_REVIEWER');
  await expect(page.getByTestId('automation-action-person')).toHaveCount(0);
  await expect(page.getByTestId('automation-action-campaign')).toHaveCount(0);
  const name = `Remind ${locale} ${randomUUID().slice(0, 6)}`;
  await openRuleMore(page);
  await page.getByTestId('automation-name').fill(name);
  await page.getByTestId('automation-submit').focus();
  await page.keyboard.press('Enter');
  const rules = page.getByTestId('automation-rules');
  await expect(rules.getByTitle(name, { exact: true })).toHaveCount(1);
  await expect(rules).toContainText(copy.remind);
  const created = await withPlatformPrisma((prisma) =>
    prisma.automationRule.findFirstOrThrow({
      where: { workspaceId: seeded.ws.workspaceId, name },
      select: {
        id: true,
        triggerType: true,
        actionType: true,
        actionConfig: true,
        enabled: true,
        armedAt: true,
      },
    }),
  );
  expect(created).toMatchObject({
    triggerType: 'REVIEW_WAITING_24H',
    actionType: 'REMIND_REVIEWER',
    actionConfig: {},
    enabled: false,
  });
  expect(created.armedAt).not.toBeNull();
  await expect(page.getByTestId(`automation-older-${created.id}`)).toHaveCount(0);

  // --- Run history: the reminder's two outcomes, in words, on its own tab ------
  await page.getByTestId('automations-tab-runs').click();
  await expect(page.getByTestId('automation-runs')).toBeVisible();
  const { runs } = seeded;
  await expect(page.getByTestId(`automation-run-status-${runs.stale}`)).toHaveText(copy.skipped);
  await expect(page.getByTestId(`automation-run-failure-${runs.stale}`)).toHaveText(copy.stale);
  await expect(page.getByTestId(`automation-run-status-${runs.nobody}`)).toHaveText(copy.blocked);
  await expect(page.getByTestId(`automation-run-failure-${runs.nobody}`)).toHaveText(copy.nobody);
  const history = page.getByTestId('automation-runs');
  for (const code of ['occurrence_stale', 'no_eligible_reviewer']) {
    await expect(history).not.toContainText(code);
  }

  await noSeriousViolations(page);
}

test.describe('Phase 2B-3 PR 3 · timed automations and the reviewer reminder', () => {
  test('timed triggers, the reviewer reminder and its runs — English (LTR)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('pr3-en');
    await enter(page, seeded.ws.slug);
    await journey(page, 'en', seeded);
  });

  test('timed triggers, the reviewer reminder and its runs — Arabic (RTL)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('pr3-ar');
    await enter(page, seeded.ws.slug, 'ar');
    await journey(page, 'ar', seeded);
  });
});
