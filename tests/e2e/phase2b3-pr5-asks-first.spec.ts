import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, noSeriousViolations, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';
import { openRuleMore } from './automation-form';

/**
 * PHASE 2B-3, PR 5 — THE RETRY AND THE PAUSE ASK FIRST, IN ENGLISH AND IN
 * ARABIC (RTL).
 *
 * One case per language, each in a workspace of its own:
 *
 *   - Home says two requests wait for this member's decision;
 *   - "Needs you" reads each in the approved words — the post a retry
 *     concerns, the campaign a pause names and what a pause does not do — with
 *     Approve for both;
 *   - the pause picker offers only PLANNED or ACTIVE campaigns, and a retry
 *     and a pause are created from the keyboard, stored switched off;
 *   - the retry is skipped and the pause approved, from the keyboard, through
 *     the real API; the campaign is PAUSED, and Run history says who decided
 *     each and why a lapsed request did nothing — never a code;
 *   - axe finds nothing serious.
 *
 * The requests are SEEDED through the platform client; the decisions go
 * through the screen and the API's confirm route. The retry's approval, every
 * stale target and every race are proven on real PostgreSQL in
 * tests/isolation/phase2b3-pr5-*.
 */

interface Seeded {
  readonly ws: OwnWorkspace;
  readonly ownerName: string;
  readonly postTitle: string;
  readonly target: { readonly id: string; readonly name: string };
  readonly planned: { readonly id: string; readonly name: string };
  readonly completed: { readonly id: string; readonly name: string };
  readonly retryRun: string;
  readonly pauseRun: string;
  readonly lapsedRun: string;
}

async function seed(label: string): Promise<Seeded> {
  const ws = await ownWorkspace(label);
  const tag = randomUUID().slice(0, 6);
  const postTitle = `Spring launch post ${tag}`;
  const target = { id: randomUUID(), name: `Spring launch ${tag}` };
  const planned = { id: randomUUID(), name: `Summer ${tag}` };
  const completed = { id: randomUUID(), name: `Winter ${tag}` };
  const retryRule = randomUUID();
  const pauseRule = randomUUID();
  const retryRun = randomUUID();
  const pauseRun = randomUUID();
  const lapsedRun = randomUUID();
  let ownerName = '';

  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findUniqueOrThrow({
      where: { id: ws.ownerId },
      select: { name: true, email: true },
    });
    ownerName = owner.name ?? owner.email;
    const base = { workspaceId: ws.workspaceId, brandId: ws.brandId };

    // --- A post that failed to publish: what a retry request concerns ----------
    const connection = await prisma.socialConnection.create({
      data: {
        ...base,
        provider: 'LINKEDIN',
        externalAccountId: `e2e-pr5-${tag}`,
        displayName: `E2E PR5 ${tag}`,
        targetKind: 'organization',
        status: 'ACTIVE',
        grantedScopes: ['w_member_social'],
        connectedAt: new Date(),
        connectedByUserId: ws.ownerId,
      },
      select: { id: true },
    });
    const item = await prisma.contentItem.create({
      data: { ...base, title: postTitle, status: 'APPROVED', primaryLocale: 'EN' },
      select: { id: true },
    });
    const variant = await prisma.contentVariant.create({
      data: {
        ...base,
        contentItemId: item.id,
        platformKey: 'linkedin',
        locale: 'EN',
        body: `${postTitle} words`,
      },
      select: { id: true },
    });
    const slot = await prisma.calendarSlot.create({
      data: {
        ...base,
        contentItemId: item.id,
        scheduledAtUtc: new Date(Date.now() - 3_600_000),
        scheduledLocalTime: '2026-01-15T09:00',
        timezone: 'UTC',
        status: 'FAILED',
        platformKeys: ['linkedin'],
        createdByUserId: ws.ownerId,
      },
      select: { id: true },
    });
    const job = await prisma.publishJob.create({
      data: {
        ...base,
        calendarSlotId: slot.id,
        contentItemId: item.id,
        contentVariantId: variant.id,
        socialConnectionId: connection.id,
        provider: 'LINKEDIN',
        status: 'FAILED',
        idempotencyKey: `e2e-pr5-${tag}`,
        scheduledAtUtc: new Date(Date.now() - 3_600_000),
        attemptCount: 1,
        maxAttempts: 5,
        failureClass: 'CONTENT_REJECTED',
        completedAt: new Date(),
        createdByUserId: ws.ownerId,
      },
      select: { id: true },
    });
    const attempt = await prisma.publishAttempt.create({
      data: {
        workspaceId: ws.workspaceId,
        publishJobId: job.id,
        attemptNumber: 1,
        outcome: 'PERMANENT_FAILURE',
        failureClass: 'CONTENT_REJECTED',
        finishedAt: new Date(),
        durationMs: 5,
      },
      select: { id: true },
    });

    // --- The campaigns: one to pause, one the picker offers, one it does not --
    for (const [campaign, status] of [
      [target, 'ACTIVE'],
      [planned, 'PLANNED'],
      [completed, 'COMPLETED'],
    ] as const) {
      await prisma.campaign.create({
        data: {
          ...base,
          id: campaign.id,
          name: campaign.name,
          objective: 'AWARENESS',
          status,
          createdByUserId: ws.ownerId,
        },
      });
    }

    // --- Two ENABLED asks-first rules, and their waiting requests -------------
    for (const [id, actionType, actionConfig, name] of [
      [retryRule, 'RETRY_PUBLISH', {}, 'Retry failed posts'],
      [pauseRule, 'PAUSE_CAMPAIGN', { campaignId: target.id }, 'Pause the launch'],
    ] as const) {
      await prisma.automationRule.create({
        data: {
          ...base,
          id,
          name,
          enabled: true,
          triggerType: 'POST_FAILED',
          triggerConfig: {},
          conditions: [],
          actionType,
          actionConfig,
          createdByUserId: ws.ownerId,
          armedAt: new Date(),
        },
      });
    }
    const waiting = {
      ...base,
      status: 'AWAITING_CONFIRMATION' as const,
      triggerType: 'POST_FAILED' as const,
      conditionsHeld: true,
      confirmationExpiresAt: new Date(Date.now() + 24 * 3_600_000),
    };
    await prisma.automationRun.create({
      data: {
        ...waiting,
        id: retryRun,
        ruleId: retryRule,
        idempotencyKey: `e2e-pr5-${retryRun}`,
        actionType: 'RETRY_PUBLISH',
        resourceType: 'PublishAttempt',
        resourceId: attempt.id,
        correlationId: randomUUID(),
      },
    });
    await prisma.automationRun.create({
      data: {
        ...waiting,
        id: pauseRun,
        ruleId: pauseRule,
        idempotencyKey: `e2e-pr5-${pauseRun}`,
        actionType: 'PAUSE_CAMPAIGN',
        resourceType: 'Campaign',
        resourceId: target.id,
        correlationId: randomUUID(),
      },
    });
    // --- …and one nobody approved in time ---------------------------------------
    await prisma.automationRun.create({
      data: {
        ...base,
        id: lapsedRun,
        ruleId: pauseRule,
        status: 'EXPIRED',
        failureCode: 'confirmation_window_closed',
        triggerType: 'POST_FAILED',
        idempotencyKey: `e2e-pr5-${lapsedRun}`,
        conditionsHeld: true,
        actionType: 'PAUSE_CAMPAIGN',
        resourceType: 'Campaign',
        resourceId: target.id,
        startedAt: new Date(Date.now() - 48 * 3_600_000),
        finishedAt: new Date(Date.now() - 24 * 3_600_000),
        correlationId: randomUUID(),
      },
    });
  });
  return { ws, ownerName, postTitle, target, planned, completed, retryRun, pauseRun, lapsedRun };
}

const COPY = {
  en: {
    waiting: '2 automation actions are waiting for your decision.',
    retryAction: 'Retry the failed post',
    pauseAction: 'Pause a campaign',
    retry: (content: string) => `Retry "${content}"`,
    pause: (campaign: string) => `Pause the campaign "${campaign}"`,
    note: 'Pausing marks the campaign as paused. Posts already scheduled still go out.',
    approve: 'Approve',
    skip: 'Skip',
    skipped: 'Skipped',
    succeeded: 'Succeeded',
    expired: 'Confirmation window closed',
    lapsed: 'Nobody approved this in the time allowed, so nothing was done.',
    approvedBy: (name: string) => `Approved by ${name}`,
    skippedBy: (name: string) => `Skipped by ${name}`,
  },
  ar: {
    waiting: '2 من إجراءات الأتمتة بانتظار قرارك.',
    retryAction: 'إعادة محاولة نشر المنشور المتعثّر',
    pauseAction: 'إيقاف حملة مؤقتًا',
    retry: (content: string) => `إعادة محاولة «${content}»`,
    pause: (campaign: string) => `إيقاف الحملة «${campaign}» مؤقتًا`,
    note: 'الإيقاف يضع الحملة في حالة «متوقفة». المنشورات المجدولة تُنشر كما هي.',
    approve: 'موافقة',
    skip: 'تخطٍّ',
    skipped: 'تم التخطي',
    succeeded: 'نجحت',
    expired: 'انتهت مهلة التأكيد',
    lapsed: 'لم يوافق عليه أحد خلال المهلة، فلم يُنفَّذ شيء.',
    approvedBy: (name: string) => `وافق عليه ${name}`,
    skippedBy: (name: string) => `تخطّاه ${name}`,
  },
} as const;

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

async function create(page: Page, name: string): Promise<void> {
  await openRuleMore(page);
  await page.getByTestId('automation-name').fill(name);
  await page.getByTestId('automation-submit').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('automation-rules').getByTitle(name, { exact: true })).toHaveCount(
    1,
  );
}

const storedRule = (workspaceId: string, name: string) =>
  withPlatformPrisma((prisma) =>
    prisma.automationRule.findFirstOrThrow({
      where: { workspaceId, name },
      select: { triggerType: true, actionType: true, actionConfig: true, enabled: true },
    }),
  );

/** Press a decision's button from the keyboard, and wait for its answer. */
async function decide(page: Page, runId: string, testId: string, ok: string): Promise<void> {
  const button = page.getByTestId(`automation-needs-you-${runId}`).getByTestId(testId);
  await button.focus();
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.searchParams.get('ok') === ok);
}

async function journey(page: Page, locale: 'en' | 'ar', seeded: Seeded): Promise<void> {
  const copy = COPY[locale];
  const { ws } = seeded;

  // --- Home: two requests wait for this member --------------------------------
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
  await expect(page.getByTestId('attention-automations-waiting')).toContainText(copy.waiting);

  // --- Needs you, in the approved words ----------------------------------------
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations`);
  if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const retry = page.getByTestId(`automation-needs-you-${seeded.retryRun}`);
  const pause = page.getByTestId(`automation-needs-you-${seeded.pauseRun}`);
  await expect(page.getByTestId(`automation-needs-you-line-${seeded.retryRun}`)).toHaveText(
    `${copy.retryAction} · ${copy.retry(seeded.postTitle)}`,
  );
  await expect(page.getByTestId(`automation-needs-you-line-${seeded.pauseRun}`)).toHaveText(
    `${copy.pauseAction} · ${copy.pause(seeded.target.name)}`,
  );
  await expect(page.getByTestId(`automation-pause-note-${seeded.pauseRun}`)).toHaveText(copy.note);
  await expect(page.getByTestId(`automation-pause-note-${seeded.retryRun}`)).toHaveCount(0);
  for (const row of [retry, pause]) {
    await expect(row.getByTestId('automation-confirm')).toHaveText(copy.approve);
    await expect(row.getByTestId('automation-skip')).toHaveText(copy.skip);
  }
  await noSeriousViolations(page);

  // --- Authoring: the retry and the pause, from the keyboard -------------------
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations?new=1`);
  const action = page.getByTestId('automation-action');
  await pick(page, 'automation-trigger', 'POST_FAILED');
  expect(await values(page, 'automation-action')).toEqual(
    expect.arrayContaining(['RETRY_PUBLISH', 'PAUSE_CAMPAIGN']),
  );
  await expect(action).toContainText(copy.retryAction);
  await expect(action).toContainText(copy.pauseAction);

  await pick(page, 'automation-action', 'PAUSE_CAMPAIGN');
  const picker = page.getByTestId('automation-action-pause-campaign');
  await expect(picker).toBeVisible();
  // Only PLANNED or ACTIVE: never a completed campaign.
  expect((await values(page, 'automation-action-pause-campaign')).sort()).toEqual(
    [seeded.target.id, seeded.planned.id].sort(),
  );
  await expect(page.getByTestId('automation-pause-note')).toHaveText(copy.note);
  await chosen(page, 'automation-action').focus();
  await page.keyboard.press('Tab');
  await expect(picker).toBeFocused();
  await picker.selectOption(seeded.planned.id);
  const pauseName = `Pause ${locale} ${randomUUID().slice(0, 6)}`;
  await create(page, pauseName);
  expect(await storedRule(ws.workspaceId, pauseName)).toEqual({
    triggerType: 'POST_FAILED',
    actionType: 'PAUSE_CAMPAIGN',
    actionConfig: { campaignId: seeded.planned.id },
    enabled: false,
  });

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations?new=1`);
  await pick(page, 'automation-trigger', 'POST_FAILED');
  await pick(page, 'automation-action', 'RETRY_PUBLISH');
  // A retry retries the post that failed: nothing to choose.
  await expect(page.getByTestId('automation-action-pause-campaign')).toHaveCount(0);
  await expect(page.getByTestId('automation-action-campaign')).toHaveCount(0);
  const retryName = `Retry ${locale} ${randomUUID().slice(0, 6)}`;
  await create(page, retryName);
  expect(await storedRule(ws.workspaceId, retryName)).toEqual({
    triggerType: 'POST_FAILED',
    actionType: 'RETRY_PUBLISH',
    actionConfig: {},
    enabled: false,
  });

  // --- Skip the retry, approve the pause --------------------------------------
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations`);
  await decide(page, seeded.retryRun, 'automation-skip', 'AUTOMATION_SKIPPED');
  await decide(page, seeded.pauseRun, 'automation-confirm', 'AUTOMATION_CONFIRMED');
  await expect(page.getByTestId('automations-needs-you')).toHaveCount(0);
  const campaign = await withPlatformPrisma((prisma) =>
    prisma.campaign.findUniqueOrThrow({
      where: { id: seeded.target.id },
      select: { status: true },
    }),
  );
  expect(campaign.status).toBe('PAUSED');

  // --- Run history: who decided, and a lapse in words, on its own tab ---------
  await page.getByTestId('automations-tab-runs').click();
  await expect(page.getByTestId('automation-runs')).toBeVisible();
  await expect(page.getByTestId(`automation-run-status-${seeded.retryRun}`)).toHaveText(
    copy.skipped,
  );
  await expect(page.getByTestId(`automation-run-decided-${seeded.retryRun}`)).toHaveText(
    copy.skippedBy(seeded.ownerName),
  );
  await expect(page.getByTestId(`automation-run-status-${seeded.pauseRun}`)).toHaveText(
    copy.succeeded,
  );
  await expect(page.getByTestId(`automation-run-decided-${seeded.pauseRun}`)).toHaveText(
    copy.approvedBy(seeded.ownerName),
  );
  await expect(page.getByTestId(`automation-run-status-${seeded.lapsedRun}`)).toHaveText(
    copy.expired,
  );
  await expect(page.getByTestId(`automation-run-failure-${seeded.lapsedRun}`)).toHaveText(
    copy.lapsed,
  );
  await expect(page.getByTestId(`automation-run-decided-${seeded.lapsedRun}`)).toHaveCount(0);
  await expect(page.getByTestId('automation-runs')).not.toContainText('confirmation_window_closed');

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/overview`);
  await expect(page.getByTestId('attention-automations-waiting')).toHaveCount(0);

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations`);
  await noSeriousViolations(page);
}

test.describe('Phase 2B-3 PR 5 · the retry and the pause ask first', () => {
  test('approve a pause, skip a retry, author both — English (LTR)', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('pr5-en');
    await enter(page, seeded.ws.slug);
    await journey(page, 'en', seeded);
  });

  test('approve a pause, skip a retry, author both — Arabic (RTL)', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('pr5-ar');
    await enter(page, seeded.ws.slug, 'ar');
    await journey(page, 'ar', seeded);
  });
});
