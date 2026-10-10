import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { closeQueues, EVALUATE_AUTOMATION } from '@brandspace/jobs';
import {
  ContentApprovalService,
  ContentCalendarService,
  type ContentPolicy,
} from '@brandspace/content';
import { processAutomationJob } from '../../apps/worker/src/processors/automation';
import { externalActions } from '../../apps/api/src/routes/copilot';
import {
  appRoleClient,
  createIsolationFixtures,
  type IsolationFixtures,
  OPEN_CHANNEL_GATE,
} from './fixtures';

/**
 * PR 0 — ONE BRAND APPROVAL GATE FOR EVERY CALENDAR.
 *
 * THE DEFECT. `ContentCalendarService` took `approvalGate` as OPTIONAL and, when
 * a caller left it out, fell back to `content.calendar.requireApprovalBeforeScheduling`
 * — a different setting from the approvals default `policyForBrand` resolves,
 * and one that ignores the brand's own `approval_policy` row. The automation
 * worker's `PLACE_ON_CALENDAR` and the Copilot's publish-now both built their
 * calendar without it, so a brand that requires approval could have an
 * unapproved post scheduled through either door.
 *
 * THE FIXTURE BRAND REQUIRES APPROVAL: `createIsolationFixtures` writes an
 * `approval_policy` row with `requireApprovalBeforeScheduling: true`, while the
 * activated content defaults leave both settings off. That gap is exactly what
 * the fallback hid.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

/** Far enough ahead that no sweep another suite runs will visit the rule. */
const FUTURE = new Date(Date.UTC(2100, 0, 1));

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await closeQueues();
  await app?.$disconnect();
});

async function makePost(input: {
  brandId?: string;
  status: 'DRAFT' | 'APPROVED';
}): Promise<string> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const item = await db.contentItem.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: input.brandId ?? fixtures.a.brandId,
          title: `PR 0 gate ${randomUUID().slice(0, 8)}`,
          primaryLocale: 'EN',
          status: input.status,
          createdByUserId: fixtures.a.userId,
        },
      });
      await db.contentVariant.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: input.brandId ?? fixtures.a.brandId,
          contentItemId: item.id,
          platformKey: 'instagram',
          locale: 'EN',
          body: 'A caption.',
          characterCount: 10,
          validationState: 'VALID',
        },
      });
      return item.id;
    },
    { prisma: app },
  );
}

async function slotsFor(contentItemId: string): Promise<number> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => db.calendarSlot.count({ where: { contentItemId } }),
    { prisma: app },
  );
}

/**
 * Deliver one CONTENT_APPROVED event to one PLACE_ON_CALENDAR rule through the
 * REAL worker processor — the construction site the defect lived in.
 */
async function runPlaceOnCalendar(contentItemId: string) {
  const { ruleId, event } = await withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const rule = await db.automationRule.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          name: `PR 0 place ${randomUUID()}`,
          enabled: true,
          triggerType: 'CONTENT_APPROVED',
          triggerConfig: {},
          conditions: [],
          actionType: 'PLACE_ON_CALENDAR',
          actionConfig: { offsetHours: 72 },
          maxRunsPerDay: 0,
          createdByUserId: fixtures.a.userId,
          nextEvaluationAt: FUTURE,
        },
        select: { id: true },
      });
      const created = await db.automationEvent.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          triggerType: 'CONTENT_APPROVED',
          refType: 'ContentItem',
          refId: contentItemId,
          dedupeKey: `CONTENT_APPROVED:${contentItemId}:${randomUUID()}`,
          dispatchedAt: new Date(),
        },
      });
      return { ruleId: rule.id, event: created };
    },
    { prisma: app },
  );

  await processAutomationJob({
    kind: EVALUATE_AUTOMATION,
    workspaceId: fixtures.a.workspaceId,
    idempotencyKey: `automation-event-${event.id}`,
    eventId: event.id,
    eventKey: event.dedupeKey,
    brandId: fixtures.a.brandId,
    triggerType: 'CONTENT_APPROVED',
    refType: 'ContentItem',
    refId: contentItemId,
    ruleId: null,
    occurrence: null,
  });

  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => {
      const run = await db.automationRun.findFirstOrThrow({
        where: { ruleId },
        select: { status: true, failureCode: true },
      });
      // Switched off afterwards, so it does not also answer the next test's event.
      await db.automationRule.update({ where: { id: ruleId }, data: { enabled: false } });
      return run;
    },
    { prisma: app },
  );
}

describe('PR 0 — automation PLACE_ON_CALENDAR uses the brand approval gate', () => {
  it('refuses an UNAPPROVED post of a brand that requires approval', async () => {
    const draft = await makePost({ status: 'DRAFT' });
    const run = await runPlaceOnCalendar(draft);

    // The calendar's own refusal (`approvalRequiredBeforeScheduling`, CONFLICT),
    // recorded on the run as every internal action failure is.
    expect(run).toEqual({ status: 'FAILED', failureCode: 'conflict' });
    expect(await slotsFor(draft)).toBe(0);
  });

  it('still schedules an APPROVED post of the same brand', async () => {
    const approved = await makePost({ status: 'APPROVED' });
    const run = await runPlaceOnCalendar(approved);

    expect(run).toEqual({ status: 'SUCCEEDED', failureCode: null });
    expect(await slotsFor(approved)).toBe(1);
  });
});

describe('PR 0 — Copilot publish-now uses the brand approval gate', () => {
  it('refuses an UNAPPROVED post before anything is scheduled or published', async () => {
    const draft = await makePost({ status: 'DRAFT' });

    await expect(
      withWorkspace(
        fixtures.a.workspaceId,
        async (db) =>
          externalActions(db).publishNow({
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: draft,
            actorUserId: fixtures.a.userId,
            actorBrandScope: [],
            idempotencyKey: `pr0-publish-now-${randomUUID()}`,
          }),
        { prisma: app },
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'This content needs approval before it can be scheduled.',
    });

    expect(await slotsFor(draft)).toBe(0);
    const jobs = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.publishJob.count({ where: { contentItemId: draft } }),
      { prisma: app },
    );
    expect(jobs).toBe(0);
  });
});

describe('PR 0 — the brand policy wins, and the calendar setting is no second answer', () => {
  const quota = {
    limit: async () => null,
    consume: async () => true,
    refund: async () => undefined,
  };

  function policy(input: { calendar: boolean; approvalsDefault: boolean }): ContentPolicy {
    const base = {
      dialects: {
        defaultKey: 'msa',
        supported: [{ key: 'msa', labelKey: 'content.dialect.msa', bcp47: 'ar' }],
      },
      platforms: [
        {
          key: 'instagram',
          labelKey: 'content.platform.instagram',
          maxBodyChars: 2_200,
          maxHashtags: 30,
          allowsFirstComment: true,
          maxMediaItems: 10,
        },
      ],
      generation: {
        maxVariantsPerRequest: 4,
        maxDraftsPerBrand: 500,
        maxContextItems: 12,
        maxContextChunks: 8,
        maxContextChars: 12_000,
        maxBriefChars: 2_000,
      },
      retention: { cancellationGraceDays: 30, minCustomerRetentionDays: 7 },
      calendar: {
        weekStartsOn: 0,
        maxDaysAhead: 365,
        minLeadMinutes: 5,
        maxSlotsPerDay: 25,
        requireApprovalBeforeScheduling: input.calendar,
      },
      learning: {
        preferenceMinObservations: 4,
        preferenceMinPosts: 3,
        workflowMinRepeats: 4,
        windowDays: 90,
        snoozeDays: 30,
      },
      approvals: {
        requireApprovalBeforeScheduling: input.approvalsDefault,
        allowSelfApproval: false,
        clientApprovalEnabled: false,
        maxNoteLength: 1_000,
        maxCyclesPerItem: 25,
      },
    };
    return base as ContentPolicy;
  }

  async function schedule(contentItemId: string, active: ContentPolicy) {
    return withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        new ContentCalendarService({
          channelGate: OPEN_CHANNEL_GATE,
          db,
          workspaceId: fixtures.a.workspaceId,
          policy: active,
          timezone: 'UTC',
          quota,
          approvalGate: new ContentApprovalService({
            db,
            workspaceId: fixtures.a.workspaceId,
            policy: active,
          }),
        }).schedule({
          contentItemId,
          localTime: futureLocal(),
          actorUserId: fixtures.a.userId,
          actorBrandScope: [],
        }),
      { prisma: app },
    );
  }

  let day = 0;
  function futureLocal(): string {
    day += 1;
    const when = new Date(Date.now() + (40 + day) * 24 * 3_600_000);
    return `${when.toISOString().slice(0, 10)}T10:00`;
  }

  async function brandWithPolicy(requireApproval: boolean | null): Promise<string> {
    return withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        const brand = await db.brand.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            slug: `pr0-${randomUUID().slice(0, 8)}`,
            name: 'PR 0 brand',
            status: 'ACTIVE',
          },
          select: { id: true },
        });
        if (requireApproval !== null) {
          await db.approvalPolicy.create({
            data: {
              workspaceId: fixtures.a.workspaceId,
              brandId: brand.id,
              requireApprovalBeforeScheduling: requireApproval,
              updatedByUserId: fixtures.a.userId,
            },
          });
        }
        return brand.id;
      },
      { prisma: app },
    );
  }

  it('a brand that REQUIRES approval refuses a draft even when the defaults say no', async () => {
    const draft = await makePost({ status: 'DRAFT' });
    await expect(
      schedule(draft, policy({ calendar: false, approvalsDefault: false })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a brand that does NOT require approval schedules a draft even when the default does', async () => {
    const brandId = await brandWithPolicy(false);
    const draft = await makePost({ brandId, status: 'DRAFT' });
    const view = await schedule(draft, policy({ calendar: true, approvalsDefault: true }));
    expect(view.slot.status).toBe('SCHEDULED');
  });

  it('a brand with no opinion follows the APPROVALS default, never the calendar setting', async () => {
    const brandId = await brandWithPolicy(null);

    // The old fallback's key says "required"; the approvals default says no.
    const allowed = await makePost({ brandId, status: 'DRAFT' });
    const view = await schedule(allowed, policy({ calendar: true, approvalsDefault: false }));
    expect(view.slot.status).toBe('SCHEDULED');

    // And the other way round.
    const refused = await makePost({ brandId, status: 'DRAFT' });
    await expect(
      schedule(refused, policy({ calendar: false, approvalsDefault: true })),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
