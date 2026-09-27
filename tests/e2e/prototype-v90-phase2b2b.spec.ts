import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v90, Phase 2B-2b (PR A) — campaign results, automations v2, the
 * Copilot's approvals summary, storage and the late-post wording, as a person
 * meets them in a real browser.
 *
 * EVERY TEST THAT NEEDS DATA CREATES ITS OWN WORKSPACE with one brand, so
 * nothing another suite reads moves, and runs once (the desktop project). The
 * rules themselves are proven against PostgreSQL in tests/isolation; data is
 * SEEDED here through the platform client, and every assertion is made through
 * the screen.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

interface OwnWorkspace {
  readonly slug: string;
  readonly workspaceId: string;
  readonly brandId: string;
  readonly ownerId: string;
}

/** A workspace of its own, owned by the e2e customer, with one ACTIVE brand. */
async function ownWorkspace(label: string): Promise<OwnWorkspace> {
  const { customer } = credentials();
  const slug = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  const brandId = randomUUID();
  const workspaceId = randomUUID();
  let ownerId = '';
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    ownerId = owner.id;
    const role = await prisma.role.findFirstOrThrow({
      where: { key: 'workspace_owner', workspaceId: null },
      select: { id: true },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        workspaceId,
        slug,
        name: `E2E ${label} ${slug.slice(-8)}`,
        ownerUserId: owner.id,
        status: 'ACTIVE',
        country: 'US',
        defaultLocale: 'EN',
        timezone: 'UTC',
        currency: 'USD',
      },
    });
    await prisma.membership.create({
      data: {
        workspaceId,
        userId: owner.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
    await prisma.brand.create({
      data: {
        id: brandId,
        workspaceId,
        slug: `${slug}-brand`,
        name: `${label} Brand`,
        status: 'ACTIVE',
      },
    });
  });
  return { slug, workspaceId, brandId, ownerId };
}

async function enter(page: Page, slug: string, locale = 'en'): Promise<void> {
  await signIn(page, locale);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/workspaces`);
  await page.click(`[data-testid="choose-workspace-${slug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

async function noSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const DAY = 86_400_000;
const dayKey = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const dateOnly = (offsetDays: number) => new Date(`${dayKey(offsetDays)}T00:00:00.000Z`);

async function seedCampaign(
  ws: OwnWorkspace,
  input: {
    name: string;
    status: 'DRAFT' | 'PLANNED' | 'ACTIVE';
    start?: number;
    end?: number;
  },
): Promise<string> {
  const id = randomUUID();
  await withPlatformPrisma((prisma) =>
    prisma.campaign.create({
      data: {
        id,
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        name: input.name,
        objective: 'ENGAGEMENT',
        status: input.status,
        ...(input.start === undefined ? {} : { startDate: dateOnly(input.start) }),
        ...(input.end === undefined ? {} : { endDate: dateOnly(input.end) }),
        createdByUserId: ws.ownerId,
      },
    }),
  );
  return id;
}

/** A published post in a campaign with daily engagements and impressions, a few days ago. */
async function seedPublishedPost(
  ws: OwnWorkspace,
  campaignId: string,
  readings: { engagements: number; impressions: number },
): Promise<void> {
  await withPlatformPrisma(async (prisma) => {
    const connection =
      (await prisma.socialConnection.findFirst({
        where: { workspaceId: ws.workspaceId },
        select: { id: true },
      })) ??
      (await prisma.socialConnection.create({
        data: {
          workspaceId: ws.workspaceId,
          brandId: ws.brandId,
          provider: 'LINKEDIN',
          externalAccountId: `e2e-${randomUUID()}`,
          displayName: 'E2E account',
          targetKind: 'organization',
          status: 'ACTIVE',
          grantedScopes: ['w_member_social'],
          connectedByUserId: ws.ownerId,
          connectedAt: new Date(),
        },
        select: { id: true },
      }));
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        campaignId,
        title: `Post ${randomUUID().slice(0, 6)}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'PUBLISHED',
        createdByUserId: ws.ownerId,
      } as never,
      select: { id: true },
    });
    const subject = `e2e-post-${randomUUID()}`;
    const periodStart = new Date(`${dayKey(-3)}T00:00:00.000Z`);
    const periodEnd = new Date(periodStart.getTime() + DAY);
    for (const [metricKey, value] of Object.entries(readings)) {
      await prisma.metricObservation.create({
        data: {
          workspaceId: ws.workspaceId,
          brandId: ws.brandId,
          socialConnectionId: connection.id,
          provider: 'LINKEDIN',
          subjectType: 'POST',
          subjectExternalId: subject,
          contentItemId: item.id,
          metricKey,
          granularity: 'DAY',
          periodStart,
          periodEnd,
          value: BigInt(value),
          unit: 'COUNT',
          observedAt: periodEnd,
          sourceKind: 'PROVIDER',
          sourceVersion: 'e2e',
          observationKey: createHash('sha256')
            .update(`${subject}|${metricKey}|${periodStart.toISOString()}`)
            .digest('hex'),
        },
      });
    }
  });
}

test.describe('B11 · campaign results', () => {
  test('the Best campaign card: the pooled rate, the name beneath it, in both languages', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('best');
    const long =
      'A very long spring launch campaign name that cannot possibly fit on one line of a card';
    const winner = await seedCampaign(ws, { name: long, status: 'ACTIVE', start: -10 });
    const other = await seedCampaign(ws, { name: 'Quiet one', status: 'ACTIVE', start: -10 });
    await seedPublishedPost(ws, winner, { engagements: 30, impressions: 200 });
    await seedPublishedPost(ws, winner, { engagements: 10, impressions: 200 });
    await seedPublishedPost(ws, other, { engagements: 1, impressions: 1000 });
    await enter(page, ws.slug);

    await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns`);
    const card = page.getByTestId('campaign-best');
    // 40 engagements over 400 impressions, pooled: 10%.
    await expect(card).toContainText('Best campaign');
    await expect(card).toContainText('10%');
    const caption = card.getByTitle(`${long} · avg engagement`);
    await expect(caption).toBeVisible();
    // A long name stays on one line, cut with an ellipsis, inside the card.
    const fits = await caption.evaluate((el) => ({
      nowrap: getComputedStyle(el).whiteSpace === 'nowrap',
      clipped: el.scrollWidth > el.clientWidth,
      inside:
        el.getBoundingClientRect().right <=
        (el.closest('[data-testid="campaign-best"]') as HTMLElement).getBoundingClientRect().right +
          1,
    }));
    expect(fits).toEqual({ nowrap: true, clipped: true, inside: true });

    await page.goto(`${DASHBOARD_BASE_URL}/ar/campaigns`);
    await expect(page.getByTestId('campaign-best')).toContainText('أفضل حملة');
    await expect(page.getByTestId('campaign-best')).toContainText('10%');
    await expect(page.getByTestId('campaign-best')).toContainText('متوسط التفاعل');
    await noSeriousViolations(page);
  });

  test('no published post anywhere: "—" and "No campaign has published yet"', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('best-none');
    await seedCampaign(ws, { name: 'Not yet', status: 'PLANNED', start: 5 });
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns`);
    await expect(page.getByTestId('campaign-best-unavailable')).toHaveText('—');
    await expect(page.getByTestId('campaign-best')).toContainText('No campaign has published yet');
  });

  test('a running campaign: its own dates, a percentage, clicks as "—", and "Ends in N days"', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('results');
    const id = await seedCampaign(ws, { name: 'Running', status: 'ACTIVE', start: -10, end: 5 });
    await seedPublishedPost(ws, id, { engagements: 47, impressions: 1000 });
    await enter(page, ws.slug);

    await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns/${id}`);
    await expect(page.getByTestId('campaign-ends-in')).toHaveText('Ends in 5 days');
    await expect(page.getByTestId('campaign-results-period')).toContainText(
      'Over the campaign’s dates',
    );
    // 47 per mille is 4.7% — never the raw 47.
    await expect(page.getByTestId('campaign-metric-engagement_rate')).toContainText('4.7%');
    await expect(page.getByTestId('campaign-metric-clicks')).toContainText('—');

    await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns/${id}?tab=performance`);
    await expect(page.getByTestId('campaign-what-changed')).toContainText(
      'What changed · last 30 days',
    );

    await page.goto(`${DASHBOARD_BASE_URL}/ar/campaigns/${id}`);
    await expect(page.getByTestId('campaign-ends-in')).toHaveText('تنتهي بعد 5 أيام');
    await noSeriousViolations(page);
  });

  test('no start date reads "No results yet"', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('no-start');
    const id = await seedCampaign(ws, { name: 'Undated', status: 'DRAFT' });
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns/${id}`);
    await expect(page.getByTestId('campaign-performance-empty')).toContainText('No results yet');
    await expect(page.getByTestId('campaign-ends-in')).toHaveCount(0);
  });

  test('"Start now" starts a planned campaign today; one past its end is refused', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('start-now');
    const planned = await seedCampaign(ws, {
      name: 'Launch',
      status: 'PLANNED',
      start: 7,
      end: 30,
    });
    const ended = await seedCampaign(ws, { name: 'Missed', status: 'PLANNED', start: -9, end: -2 });
    await enter(page, ws.slug);

    await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns/${planned}`);
    await page.getByTestId('campaign-start-now').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'CAMPAIGN_STARTED');
    await expect(page.getByTestId('campaign-status')).toContainText('Active');
    await expect(page.getByTestId('campaign-start-now')).toHaveCount(0);

    await page.goto(`${DASHBOARD_BASE_URL}/en/campaigns/${ended}`);
    await page.getByTestId('campaign-start-now').click();
    await page.waitForURL((url) => url.searchParams.get('error') === 'CAMPAIGN_ALREADY_ENDED');
    await expect(page.getByText('This campaign’s end date has passed')).toBeVisible();
    await expect(page.getByTestId('campaign-status')).toContainText('Planned');
  });
});

async function seedRule(
  ws: OwnWorkspace,
  input: {
    name: string;
    triggerType: 'SCHEDULED_TIME' | 'CONTENT_APPROVED';
    triggerConfig: unknown;
    actionType: 'NOTIFY' | 'PROPOSE_PUBLISH';
    conditions?: unknown[];
  },
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
        triggerConfig: input.triggerConfig as never,
        conditions: (input.conditions ?? []) as never,
        actionType: input.actionType,
        actionConfig: (input.actionType === 'NOTIFY'
          ? { templateKey: 'automation.notice' }
          : {}) as never,
        maxRunsPerDay: 0,
        createdByUserId: ws.ownerId,
      },
    }),
  );
  return id;
}

test.describe('B12 + G13 (a) · automations v2', () => {
  test('a rule is edited in place: name, description and time; the rest stays', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('auto-edit');
    const ruleId = await seedRule(ws, {
      name: 'Morning note',
      triggerType: 'SCHEDULED_TIME',
      triggerConfig: { hourLocal: 9, daysOfWeek: [] },
      actionType: 'NOTIFY',
    });
    await enter(page, ws.slug);

    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);
    await page.getByTestId(`automation-edit-${ruleId}`).click();
    const form = page.getByTestId('automation-edit-form');
    await expect(form).toBeVisible();
    // Trigger and action are named, not offered.
    await expect(form.getByTestId('automation-trigger')).toHaveCount(0);
    await expect(form.getByTestId('automation-hour')).toHaveValue('9');
    await form.getByTestId('automation-name').fill('Early note');
    await form.getByTestId('automation-description').fill('Before the stand-up.');
    await form.getByTestId('automation-hour').selectOption('7');
    await form.getByTestId('automation-edit-submit').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'AUTOMATION_UPDATED');
    await expect(page.getByTestId('automation-rules')).toContainText('Early note');
    // Still disabled: editing never switches a rule on.
    await expect(page.getByTestId('automation-rules')).toContainText('Disabled');

    await page.getByTestId(`automation-edit-${ruleId}`).click();
    await expect(page.getByTestId('automation-hour')).toHaveValue('7');
    await expect(page.getByTestId('automation-description')).toHaveValue('Before the stand-up.');
    await noSeriousViolations(page);
  });

  test('a rule with several conditions keeps them all when edited', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('auto-keep');
    const ruleId = await seedRule(ws, {
      name: 'Two conditions',
      triggerType: 'CONTENT_APPROVED',
      triggerConfig: {},
      actionType: 'NOTIFY',
      conditions: [
        { field: 'content.type', operator: 'equals', value: 'REEL' },
        { field: 'content.hasCampaign', operator: 'is_true' },
      ],
    });
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations?edit=${ruleId}`);
    await expect(page.getByTestId('automation-conditions-kept')).toContainText('2 conditions');
    await expect(page.getByTestId('automation-condition')).toHaveCount(0);
    await page.getByTestId('automation-name').fill('Two conditions, renamed');
    await page.getByTestId('automation-edit-submit').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'AUTOMATION_UPDATED');
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations?edit=${ruleId}`);
    await expect(page.getByTestId('automation-conditions-kept')).toContainText('2 conditions');
  });

  test('the create form offers campaign, format and post author on a content trigger', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('auto-fields');
    await seedCampaign(ws, { name: 'Autumn', status: 'ACTIVE' });
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);
    await page.getByTestId('automation-trigger').selectOption('CONTENT_APPROVED');
    const fields = page.getByTestId('automation-condition-field');
    await fields.selectOption('content.campaignId');
    await expect(page.getByTestId('automation-condition-value')).toContainText('Autumn');
    await fields.selectOption('content.type');
    await expect(page.getByTestId('automation-condition-value')).toContainText('Reel');
    await fields.selectOption('content.authorUserId');
    await expect(page.getByTestId('automation-condition-value').locator('option')).not.toHaveCount(
      0,
    );
  });

  test('"Needs you" on Home and on Automations; Skip leaves it in the history', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('auto-skip');
    const ruleId = await seedRule(ws, {
      name: 'Publish when approved',
      triggerType: 'CONTENT_APPROVED',
      triggerConfig: {},
      actionType: 'PROPOSE_PUBLISH',
    });
    const runId = randomUUID();
    await withPlatformPrisma((prisma) =>
      prisma.automationRun.create({
        data: {
          id: runId,
          workspaceId: ws.workspaceId,
          brandId: ws.brandId,
          ruleId,
          status: 'AWAITING_CONFIRMATION',
          triggerType: 'CONTENT_APPROVED',
          idempotencyKey: `e2e-${randomUUID()}`,
          conditionsHeld: true,
          actionType: 'PROPOSE_PUBLISH',
          confirmationExpiresAt: new Date(Date.now() + 3_600_000),
          correlationId: randomUUID(),
        },
      }),
    );
    await enter(page, ws.slug);

    await expect(page.getByTestId('attention-automations-waiting')).toContainText(
      '1 automation action is waiting for your decision.',
    );

    await page.goto(`${DASHBOARD_BASE_URL}/en/automations`);
    const waiting = page.getByTestId(`automation-needs-you-${runId}`);
    await expect(waiting).toContainText('Publish when approved');
    await expect(waiting.getByTestId('automation-confirm')).toBeVisible();
    await waiting.getByTestId('automation-skip').click();
    await page.waitForURL((url) => url.searchParams.get('ok') === 'AUTOMATION_SKIPPED');
    await expect(page.getByTestId('automations-needs-you')).toHaveCount(0);
    await expect(page.getByTestId('automation-runs')).toContainText('Skipped');

    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page.getByTestId('attention-automations-waiting')).toHaveCount(0);
  });
});
