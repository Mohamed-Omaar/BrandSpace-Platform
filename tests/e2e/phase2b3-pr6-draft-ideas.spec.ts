import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { enter, noSeriousViolations, ownWorkspace, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * PHASE 2B-3, PR 6 — DRAFT 3 IDEAS WITH AI, IN ENGLISH AND IN ARABIC (RTL).
 *
 * One case per language, each in a workspace of its own whose plan includes
 * the action through a WORKSPACE OVERRIDE of its own — a cap of 0, so it is
 * offered and its monthly limit already reads as reached, with no counter and
 * no dependence on what month it is:
 *
 *   - the rule card says the monthly AI limit is reached (no notification);
 *   - Run history reads each DRAFT_IDEAS outcome in the approved words: a run
 *     drafting ("Drafting ideas…"), one that drafted three ideas (linked to the
 *     brand's drafts), one skipped at the cap, one whose answer could not be
 *     used — never a code;
 *   - the ideas link opens the content library on the brand's drafts;
 *   - a DRAFT_IDEAS rule is authored from the keyboard and stored switched off;
 *   - axe finds nothing serious.
 *
 * The runs are SEEDED through the platform client; the executor that produces
 * them — claim, cap, credits, replay — is proven on real PostgreSQL in
 * tests/isolation/phase2b3-pr6-executor. The waiting run is due a week from
 * now, so the E2E scheduler leaves it waiting.
 */

interface Seeded {
  readonly ws: OwnWorkspace;
  readonly ruleId: string;
  readonly ideas: readonly string[];
  readonly drafting: string;
  readonly drafted: string;
  readonly capped: string;
  readonly unusable: string;
}

async function seed(label: string): Promise<Seeded> {
  const ws = await ownWorkspace(label);
  const tag = randomUUID().slice(0, 6);
  const ruleId = randomUUID();
  const [drafting, drafted, capped, unusable] = [
    randomUUID(),
    randomUUID(),
    randomUUID(),
    randomUUID(),
  ];
  const ideas = [`Idea one ${tag}`, `Idea two ${tag}`, `Idea three ${tag}`];

  await withPlatformPrisma(async (prisma) => {
    const base = { workspaceId: ws.workspaceId, brandId: ws.brandId };
    const platformUser = await prisma.platformUser.findFirstOrThrow({ select: { id: true } });
    await prisma.workspaceOverride.create({
      data: {
        workspaceId: ws.workspaceId,
        featureKey: 'limit.automation_ai_actions',
        enabled: true,
        limitValue: 0,
        reason: 'E2E PR 6: the action is included and this month is used up',
        grantedByPlatformUserId: platformUser.id,
      },
    });
    await prisma.automationRule.create({
      data: {
        ...base,
        id: ruleId,
        name: `Ideas for empty days ${tag}`,
        enabled: true,
        triggerType: 'SCHEDULE_GAP',
        triggerConfig: {},
        conditions: [],
        actionType: 'DRAFT_IDEAS',
        actionConfig: {},
        createdByUserId: ws.ownerId,
        armedAt: new Date(),
      },
    });
    const items = [];
    for (const [index, title] of ideas.entries()) {
      items.push(
        await prisma.contentItem.create({
          data: {
            ...base,
            title,
            status: 'DRAFT',
            origin: 'AI_GENERATED',
            primaryLocale: 'EN',
            createdByUserId: ws.ownerId,
            idempotencyKey: `automation-ideas:${drafted}:${index + 1}`,
          },
          select: { id: true },
        }),
      );
    }
    const run = {
      ...base,
      ruleId,
      triggerType: 'SCHEDULE_GAP' as const,
      actionType: 'DRAFT_IDEAS' as const,
      conditionsHeld: true,
    };
    await prisma.automationRun.create({
      data: {
        ...run,
        id: drafting,
        status: 'AWAITING_EXECUTION',
        idempotencyKey: `e2e-pr6-${drafting}`,
        executionAvailableAt: new Date(Date.now() + 7 * 86_400_000),
        correlationId: randomUUID(),
      },
    });
    await prisma.automationRun.create({
      data: {
        ...run,
        id: drafted,
        status: 'SUCCEEDED',
        idempotencyKey: `e2e-pr6-${drafted}`,
        actionResult: { ideaItemIds: items.map((item) => item.id) },
        resourceType: 'ContentItem',
        resourceId: items[0]!.id,
        executionAttempts: 1,
        finishedAt: new Date(),
        correlationId: randomUUID(),
      },
    });
    for (const [id, status, failureCode] of [
      [capped, 'SKIPPED', 'monthly_ai_cap_reached'],
      [unusable, 'FAILED', 'ai_output_unusable'],
    ] as const) {
      await prisma.automationRun.create({
        data: {
          ...run,
          id,
          status,
          failureCode,
          idempotencyKey: `e2e-pr6-${id}`,
          executionAttempts: 1,
          finishedAt: new Date(),
          correlationId: randomUUID(),
        },
      });
    }
  });
  return { ws, ruleId, ideas, drafting, drafted, capped, unusable };
}

const COPY = {
  en: {
    action: 'Draft 3 ideas with AI',
    cap: 'Monthly AI limit reached — resumes next month',
    drafting: 'Drafting ideas…',
    succeeded: 'Succeeded',
    skipped: 'Skipped',
    failed: 'Failed',
    drafted: 'Drafted 3 ideas in your content library.',
    capReason:
      "Skipped: this month's limit for AI automation actions is reached. It resets at the start of next month. Nothing was charged.",
    unusable:
      "The AI reply couldn't be used, so no ideas were saved. Credits for this attempt were used.",
  },
  ar: {
    action: 'صياغة 3 أفكار بالذكاء الاصطناعي',
    cap: 'بلغ الحد الشهري لإجراءات الأتمتة بالذكاء الاصطناعي — يُستأنف الشهر القادم',
    drafting: 'جارٍ صياغة الأفكار…',
    succeeded: 'نجحت',
    skipped: 'تم التخطي',
    failed: 'فشلت',
    drafted: 'تمت صياغة 3 أفكار في مكتبة المحتوى.',
    capReason:
      'تم التخطي: بلغت إجراءات الأتمتة بالذكاء الاصطناعي حدّها لهذا الشهر، ويُعاد ضبطه مع بداية الشهر القادم. لم يُخصم أي رصيد.',
    unusable: 'تعذّر استخدام ردّ الذكاء الاصطناعي، فلم تُحفظ أي أفكار. استُخدم رصيد هذه المحاولة.',
  },
} as const;

// D-468 — the event and the action are the prototype's grids of radio choices.
const optionValues = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .locator('input[type="radio"]:not([value=""])')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));

async function journey(page: Page, locale: 'en' | 'ar', seeded: Seeded): Promise<void> {
  const copy = COPY[locale];
  const { ws } = seeded;

  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations`);
  if (locale === 'ar') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // --- The rule card: the cap, in words, and no notification ------------------
  await expect(page.getByTestId(`automation-ai-cap-${seeded.ruleId}`)).toHaveText(copy.cap);

  // --- Run history, every outcome in the approved words, on its own tab -------
  await page.getByTestId('automations-tab-runs').click();
  await expect(page.getByTestId('automation-runs')).toBeVisible();
  await expect(page.getByTestId(`automation-run-status-${seeded.drafting}`)).toHaveText(
    copy.drafting,
  );
  await expect(page.getByTestId(`automation-run-failure-${seeded.drafting}`)).toHaveCount(0);
  await expect(page.getByTestId(`automation-run-status-${seeded.drafted}`)).toHaveText(
    copy.succeeded,
  );
  await expect(page.getByTestId(`automation-run-status-${seeded.capped}`)).toHaveText(copy.skipped);
  await expect(page.getByTestId(`automation-run-failure-${seeded.capped}`)).toHaveText(
    copy.capReason,
  );
  await expect(page.getByTestId(`automation-run-status-${seeded.unusable}`)).toHaveText(
    copy.failed,
  );
  await expect(page.getByTestId(`automation-run-failure-${seeded.unusable}`)).toHaveText(
    copy.unusable,
  );
  const runs = page.getByTestId('automation-runs');
  for (const code of ['monthly_ai_cap_reached', 'ai_output_unusable', 'AWAITING_EXECUTION']) {
    await expect(runs).not.toContainText(code);
  }
  await noSeriousViolations(page);

  // --- Authoring, from the keyboard: offered, and stored switched off ---------
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/automations?new=1`);
  await page.getByTestId('automation-trigger-SCHEDULE_GAP').check();
  expect(await optionValues(page, 'automation-action')).toContain('DRAFT_IDEAS');
  const action = page.getByTestId('automation-action');
  await expect(action).toContainText(copy.action);
  const ideas = page.getByTestId('automation-action-DRAFT_IDEAS');
  await ideas.focus();
  await expect(ideas).toBeFocused();
  await ideas.check();
  const name = `Ideas ${locale} ${randomUUID().slice(0, 6)}`;
  await page.getByTestId('automation-name').fill(name);
  await page.getByTestId('automation-submit').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('automation-rules')).toContainText(name);
  const stored = await withPlatformPrisma((prisma) =>
    prisma.automationRule.findFirstOrThrow({
      where: { workspaceId: ws.workspaceId, name },
      select: { triggerType: true, actionType: true, actionConfig: true, enabled: true },
    }),
  );
  expect(stored).toEqual({
    triggerType: 'SCHEDULE_GAP',
    actionType: 'DRAFT_IDEAS',
    actionConfig: {},
    enabled: false,
  });
  // The screen with the new rule on it. (The content library opened below is
  // not scanned here: its "Search posts" label is a pre-existing contrast
  // finding, listed for the final review — not something this PR changed.)
  // The saved banner animates in; contrast is judged once it has settled.
  // Only FINITE animations: a looping decoration never settles and is not text.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getComputedTiming().endTime === Infinity,
      ),
  );
  await noSeriousViolations(page);

  // --- The ideas link opens the brand's drafts ---------------------------------
  await page.getByTestId('automations-tab-runs').click();
  const link = page.getByTestId(`automation-run-ideas-${seeded.drafted}`);
  await expect(link).toHaveText(copy.drafted);
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL(
    (url) =>
      url.pathname === `/${locale}/content` &&
      url.searchParams.get('brand') === ws.brandId &&
      url.searchParams.get('status') === 'DRAFT',
  );
  const library = page.getByRole('main');
  for (const title of seeded.ideas) await expect(library).toContainText(title);
}

test.describe('Phase 2B-3 PR 6 · draft 3 ideas with AI', () => {
  test('cap line, Run history, authoring and the ideas — English (LTR)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('pr6-en');
    await enter(page, seeded.ws.slug);
    await journey(page, 'en', seeded);
  });

  test('cap line, Run history, authoring and the ideas — Arabic (RTL)', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const seeded = await seed('pr6-ar');
    await enter(page, seeded.ws.slug, 'ar');
    await journey(page, 'ar', seeded);
  });
});
