import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  ContentApprovalService,
  approvalNotifier,
  type ApprovalActor,
  type ContentPolicy,
} from '@brandspace/content';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * F-102 (FINAL REVIEW) — A REVIEW AN AUTOMATION ASKS FOR REACHES THE
 * REVIEWER'S INBOX.
 *
 * The worker's SUBMIT_FOR_APPROVAL port built `ContentApprovalService` without
 * a notifier, so the review was opened and nobody was told. The notifier the
 * dashboard used now lives in `@brandspace/content` and the worker passes it.
 * Here, against real PostgreSQL through the tenant role: a submit made the way
 * the worker makes it — the rule creator's own authority, the shared notifier
 * — writes one `approval.requested` notification for an eligible reviewer,
 * pointing at that review, and a retried submit writes no second one.
 */

const CONTENT_POLICY: ContentPolicy = {
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
    requireApprovalBeforeScheduling: false,
  },
  learning: {
    preferenceMinObservations: 4,
    preferenceMinPosts: 3,
    workflowMinRepeats: 4,
    windowDays: 90,
    snoozeDays: 30,
  },
  approvals: {
    requireApprovalBeforeScheduling: false,
    allowSelfApproval: false,
    clientApprovalEnabled: false,
    maxNoteLength: 1_000,
    maxCyclesPerItem: 25,
  },
};

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;
let reviewer: string;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
  const user = await platform.user.create({
    data: {
      email: `f102-reviewer-${randomUUID()}@example.test`,
      name: 'F-102 reviewer',
      status: 'ACTIVE',
      locale: 'EN',
      timezone: 'UTC',
    },
  });
  const role = await platform.role.findFirstOrThrow({
    where: { key: 'approver', realm: 'WORKSPACE' },
  });
  await platform.membership.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      userId: user.id,
      roleId: role.id,
      status: 'ACTIVE',
      brandScope: [],
    },
  });
  reviewer = user.id;
}, 90_000);

afterAll(async () => {
  await app?.$disconnect();
  await platform?.$disconnect();
});

/** The rule creator's live authority, as the engine hands it to the port. */
const creator = (): ApprovalActor => ({
  userId: fixtures.a.userId,
  roleKey: 'content_creator',
  permissionKeys: ['content.read', 'content.submit'],
  brandScope: [],
});

/** A submit built exactly as the worker's port now builds it. */
const submitAsTheWorker = (itemId: string) =>
  withWorkspace(
    fixtures.a.workspaceId,
    (db) =>
      new ContentApprovalService({
        db,
        workspaceId: fixtures.a.workspaceId,
        policy: CONTENT_POLICY,
        notifier: approvalNotifier({ db, workspaceId: fixtures.a.workspaceId }),
      }).submit({ itemId, actor: creator() }),
    { prisma: app },
  );

describe("F-102 · an automation's review request notifies the reviewer", () => {
  it('writes one approval.requested for an eligible reviewer, linked to that review', async () => {
    await platform.contentItem.update({
      where: { id: fixtures.a.contentItemId },
      data: { status: 'DRAFT' },
    });
    const approval = await submitAsTheWorker(fixtures.a.contentItemId);
    const rows = await platform.notification.findMany({
      where: { workspaceId: fixtures.a.workspaceId, resourceId: approval.id },
      select: { userId: true, templateKey: true, linkPath: true, idempotencyKey: true },
    });
    const forReviewer = rows.filter((row) => row.userId === reviewer);
    expect(forReviewer).toEqual([
      {
        userId: reviewer,
        templateKey: 'approval.requested',
        linkPath: `/approvals?review=${approval.id}`,
        // The notifier's key per review; the service adds the recipient.
        idempotencyKey: `approval.requested:${approval.id}:${reviewer}`,
      },
    ]);
    // Never the person (or rule creator) who asked.
    expect(rows.some((row) => row.userId === fixtures.a.userId)).toBe(false);

    // A retried run reuses the open review and is told once.
    const again = await submitAsTheWorker(fixtures.a.contentItemId).catch(() => null);
    if (again) expect(again.id).toBe(approval.id);
    expect(
      await platform.notification.count({
        where: { workspaceId: fixtures.a.workspaceId, resourceId: approval.id, userId: reviewer },
      }),
    ).toBe(1);
  });

  it("the worker's SUBMIT_FOR_APPROVAL port passes the shared notifier", () => {
    const source = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../apps/worker/src/processors/automation.ts',
      ),
      'utf8',
    );
    const port = source.slice(source.indexOf('async submitForApproval(input)'));
    const body = port.slice(0, port.indexOf('return { approvalId: approval.id };'));
    expect(body).toContain('notifier: approvalNotifier({ db, workspaceId })');
  });
});
