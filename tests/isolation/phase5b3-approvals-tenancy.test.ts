import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Cross-tenant and cross-BRAND isolation for the three models Phase 5B-3 adds.
 *
 * The D-29 gate requires this file. `Approval`, `ApprovalPolicy` and
 * `Notification` get the assertions every earlier phase established — a direct
 * read of B's row from A returns null, a listing from A excludes B, a write
 * aimed at B is refused, and an aggregate is treated as a read — plus the
 * properties specific to what these tables hold:
 *
 *   - A VERDICT NAMES A PERSON. `decidedByUserId`, `decidedAt` and the notes are
 *     asserted separately from the row's existence: "who in this company signs
 *     off on what, and how quickly" is an organisational chart drawn from
 *     another tenant's workflow.
 *
 *   - AN APPROVAL POLICY IS A SECURITY SETTING. Reading B's would tell A whether
 *     B requires approval at all, and whether it permits self-approval — which
 *     is a map of where B's controls are weakest.
 *
 *   - A NOTIFICATION CARRIES A CONTENT TITLE. Its `payload` is asserted unreadable
 *     for the same reason the caption is: it is the customer's own words.
 *
 *   - `approval.contentItemId` IS F-80 AND F-83'S SHAPE — a child pointing at a
 *     tenant-owned parent — so the refusal is asserted from inside A's OWN
 *     workspace context, which is the case RLS does not cover and the case both
 *     findings were about (D-112).
 *
 * Everything runs through `withWorkspace()`, so PostgreSQL RLS — not a `where`
 * clause a test remembered — is what is being measured.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

function inA<T>(fn: (db: Parameters<Parameters<typeof withWorkspace>[1]>[0]) => Promise<T>) {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

describe('Approval is tenant-owned', () => {
  it('A cannot read B approval by id', async () => {
    const row = await inA((db) => db.approval.findUnique({ where: { id: fixtures.b.approvalId } }));
    expect(row).toBeNull();
  });

  it("A's approval list excludes B", async () => {
    const rows = await inA((db) => db.approval.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.approvalId);
    expect(rows.map((r) => r.id)).toContain(fixtures.a.approvalId);
  });

  it("A cannot count B's queue — an aggregate is a read", async () => {
    const count = await inA((db) => db.approval.count({ where: { brandId: fixtures.b.brandId } }));
    expect(count).toBe(0);
  });

  it('A cannot learn WHO decided B, or WHEN, or WHY', async () => {
    /*
     * The disclosure that matters most here. The row's existence is one thing;
     * the identity of the approver, the timestamp and the free-text reason are
     * the organisationally useful facts. A query that selects only those columns
     * and filters on none must still return nothing of B's.
     */
    const rows = await inA((db) =>
      db.approval.findMany({
        select: {
          id: true,
          decidedByUserId: true,
          decidedAt: true,
          decisionNote: true,
          requestNote: true,
          policySnapshot: true,
        },
      }),
    );
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.approvalId);
    expect(rows.every((r) => r.id === fixtures.a.approvalId)).toBe(true);
    const notes = rows.map((r) => `${r.decisionNote ?? ''}${r.requestNote ?? ''}`).join(' ');
    expect(notes).not.toContain(fixtures.b.slug);
  });

  it("A cannot search B's notes by content", async () => {
    const rows = await inA((db) =>
      db.approval.findMany({ where: { decisionNote: { contains: fixtures.b.slug } } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('A cannot write an approval into B', async () => {
    await expect(
      inA((db) =>
        db.approval.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            contentItemId: fixtures.b.contentItemId,
            requestedByUserId: fixtures.a.userId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A cannot open a review over B's DRAFT from inside its own workspace — F-80/F-83's shape", async () => {
    /*
     * THE CASE RLS DOES NOT COVER, and the reason D-112 exists.
     *
     * The row carries A's own workspaceId, so the tenant policy admits it and
     * the insert reaches the constraints. Referential integrity then runs with
     * RLS BYPASSED — so a plain `contentItemId` would have resolved B's draft
     * perfectly well and accepted the row, putting B's content in A's queue AND
     * answering "does that id exist?". `approval_item_fkey` on
     * `(workspaceId, contentItemId)` refuses it: the PAIR does not exist.
     */
    await expect(
      inA((db) =>
        db.approval.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId: fixtures.b.contentItemId,
            requestedByUserId: fixtures.a.userId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a REAL foreign id and a FABRICATED one fail identically', async () => {
    /*
     * THE EXISTENCE ORACLE, CLOSED AND MEASURED. If a real id from B produced a
     * different error from an id that never existed, the difference would answer
     * "does this draft exist?" — which is the whole of what F-80 was.
     */
    const attempt = (contentItemId: string) =>
      inA((db) =>
        db.approval.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.a.brandId,
            contentItemId,
            requestedByUserId: fixtures.a.userId,
          },
        }),
      ).then(
        () => ({ code: 'ACCEPTED', constraint: '' }),
        (error: unknown) => ({
          code: (error as { code?: string }).code ?? 'UNKNOWN',
          constraint: String((error as { meta?: { constraint?: string } }).meta?.constraint ?? ''),
        }),
      );

    const real = await attempt(fixtures.b.contentItemId);
    const fabricated = await attempt(randomUUID());
    expect(real.code).not.toBe('ACCEPTED');
    expect(real).toEqual(fabricated);
  });

  it("A cannot attach its own review to B's brand — the composite key refuses it", async () => {
    await expect(
      inA((db) =>
        db.approval.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            contentItemId: fixtures.a.contentItemId,
            requestedByUserId: fixtures.a.userId,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A cannot decide B's review by updating it", async () => {
    const result = await inA((db) =>
      db.approval.updateMany({
        where: { id: fixtures.b.approvalId },
        data: { status: 'REJECTED' },
      }),
    );
    expect(result.count).toBe(0);
  });

  it("the application role cannot DELETE an approval AT ALL — not B's, and not its own", async () => {
    /*
     * `20260915210000_phase_5b_3_approval_integrity` revoked DELETE from
     * `brandspace_app`. An approval is the record that somebody reviewed
     * something; erasing one through any application path removes the evidence
     * that the review happened, which is the property the module exists to
     * provide. So this is stronger than the cross-tenant assertion it replaces:
     * the privilege is gone rather than merely filtered.
     */
    await expect(
      inA((db) => db.approval.deleteMany({ where: { id: fixtures.b.approvalId } })),
    ).rejects.toThrow();
    await expect(
      inA((db) => db.approval.deleteMany({ where: { id: fixtures.a.approvalId } })),
    ).rejects.toThrow();
  });

  it('a DECIDED approval cannot be reopened or rewritten through raw app-role SQL', async () => {
    /*
     * The fixture's approval is APPROVED. Moving it back to PENDING would let a
     * decided cycle be re-decided, and the history would describe a review that
     * did not happen. The trigger refuses it however the write arrives.
     */
    await expect(
      inA((db) =>
        db.approval.updateMany({
          where: { id: fixtures.a.approvalId },
          data: { status: 'PENDING' },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      inA((db) =>
        db.approval.updateMany({
          where: { id: fixtures.a.approvalId },
          data: { decisionNote: 'rewritten after the fact' },
        }),
      ),
    ).rejects.toThrow();
  });

  it("a PENDING approval's identity is immutable — subject, requester and snapshot", async () => {
    const pending = await inA((db) =>
      db.approval.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          contentItemId: fixtures.a.contentItemId,
          requestedByUserId: fixtures.a.userId,
          status: 'PENDING',
          policySnapshot: { allowSelfApproval: false },
        },
      }),
    );

    // The spine cannot move, even while the cycle is open.
    for (const data of [
      { requestedByUserId: fixtures.b.userId },
      { cycle: 99 },
      { policySnapshot: { allowSelfApproval: true } },
    ]) {
      await expect(
        inA((db) => db.approval.updateMany({ where: { id: pending.id }, data })),
      ).rejects.toThrow();
    }

    // But the legitimate PENDING → terminal transition still works: that is the
    // workflow, and an integrity rule that blocked it would block the product.
    const decided = await inA((db) =>
      db.approval.updateMany({
        where: { id: pending.id, status: 'PENDING' },
        data: { status: 'APPROVED', decidedByUserId: fixtures.a.userId, decidedAt: new Date() },
      }),
    );
    expect(decided.count).toBe(1);
  });
});

describe('ApprovalPolicy is tenant-owned', () => {
  it('A cannot read B policy by id', async () => {
    const row = await inA((db) =>
      db.approvalPolicy.findUnique({ where: { id: fixtures.b.approvalPolicyId } }),
    );
    expect(row).toBeNull();
  });

  it("A cannot read B's SECURITY SETTINGS by any query", async () => {
    /*
     * Reading these would tell A whether B requires approval at all and whether
     * B permits self-approval — a map of where another tenant's controls are
     * weakest, which is worth more to an attacker than any single row.
     */
    const rows = await inA((db) =>
      db.approvalPolicy.findMany({
        select: { id: true, allowSelfApproval: true, clientApprovalEnabled: true },
      }),
    );
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.approvalPolicyId);
    expect(rows.every((r) => r.id === fixtures.a.approvalPolicyId)).toBe(true);
  });

  it("A cannot count B's policies", async () => {
    const count = await inA((db) =>
      db.approvalPolicy.count({ where: { brandId: fixtures.b.brandId } }),
    );
    expect(count).toBe(0);
  });

  it('the application role cannot DELETE a policy — reset is a NULL override', async () => {
    /*
     * A NULL column already means "no opinion", which is what an absent row
     * means, so DELETE buys nothing — and `updatedByUserId` records who last
     * changed a brand's approval rules, which is worth keeping.
     */
    await expect(
      inA((db) => db.approvalPolicy.deleteMany({ where: { id: fixtures.a.approvalPolicyId } })),
    ).rejects.toThrow();
  });

  it("A cannot RELAX B's policy", async () => {
    const result = await inA((db) =>
      db.approvalPolicy.updateMany({
        where: { id: fixtures.b.approvalPolicyId },
        data: { requireApprovalBeforeScheduling: false, allowSelfApproval: true },
      }),
    );
    expect(result.count).toBe(0);
  });

  it('A cannot write a policy into B', async () => {
    await expect(
      inA((db) =>
        db.approvalPolicy.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            allowSelfApproval: true,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A cannot write a policy for B's brand from inside its own workspace", async () => {
    await expect(
      inA((db) =>
        db.approvalPolicy.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            brandId: fixtures.b.brandId,
            allowSelfApproval: true,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('Notification is tenant-owned', () => {
  it('A cannot read B notification by id', async () => {
    const row = await inA((db) =>
      db.notification.findUnique({ where: { id: fixtures.b.notificationId } }),
    );
    expect(row).toBeNull();
  });

  it("A's inbox excludes B", async () => {
    const rows = await inA((db) => db.notification.findMany());
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.notificationId);
    expect(rows.map((r) => r.id)).toContain(fixtures.a.notificationId);
  });

  it("A cannot read B's PAYLOAD — it carries the customer's own title", async () => {
    const rows = await inA((db) => db.notification.findMany({ select: { payload: true } }));
    expect(JSON.stringify(rows)).not.toContain(fixtures.b.slug);
  });

  it("A cannot count B's unread", async () => {
    const count = await inA((db) =>
      db.notification.count({ where: { userId: fixtures.b.userId, readAt: null } }),
    );
    expect(count).toBe(0);
  });

  it("A cannot mark B's notification read", async () => {
    const result = await inA((db) =>
      db.notification.updateMany({
        where: { id: fixtures.b.notificationId },
        data: { readAt: new Date() },
      }),
    );
    expect(result.count).toBe(0);
    // And it is still unread, read back with B's own context.
    const row = await withWorkspace(
      fixtures.b.workspaceId,
      (db) => db.notification.findUnique({ where: { id: fixtures.b.notificationId } }),
      { prisma: app },
    );
    expect(row?.readAt).toBeNull();
  });

  it('A cannot address a notification into B', async () => {
    await expect(
      inA((db) =>
        db.notification.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            userId: fixtures.b.userId,
            templateKey: 'approval.requested',
            idempotencyKey: `intrusion-${randomUUID()}`,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("A's idempotency key does not collide with B's identical one", async () => {
    /*
     * The unique index is `(workspaceId, idempotencyKey)`, not the key alone. If
     * it were the key alone, one tenant choosing a guessable key could BLOCK
     * another tenant's notification from ever being written — a denial of
     * service across the boundary, and a probe for which keys are already taken.
     */
    const created = await inA((db) =>
      db.notification.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          userId: fixtures.a.userId,
          templateKey: 'approval.approved',
          idempotencyKey: fixtures.b.notificationIdempotencyKey,
        },
      }),
    );
    expect(created.id).toBeTruthy();
    await inA((db) => db.notification.delete({ where: { id: created.id } }));
  });

  it("A cannot delete B's notification", async () => {
    const result = await inA((db) =>
      db.notification.deleteMany({ where: { id: fixtures.b.notificationId } }),
    );
    expect(result.count).toBe(0);
  });
});

describe('the Activity Log adds no table, and the audit trail stays append-only', () => {
  it("A's audit events exclude B's", async () => {
    const rows = await inA((db) => db.auditEvent.findMany({ select: { id: true } }));
    expect(rows.map((r) => r.id)).not.toContain(fixtures.b.auditEventId);
  });

  it('AC-15.7 — the application role still cannot UPDATE an audit event', async () => {
    await expect(
      inA((db) =>
        db.auditEvent.updateMany({
          where: { id: fixtures.a.auditEventId },
          data: { action: 'tampered' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('AC-15.7 — the application role still cannot DELETE an audit event', async () => {
    await expect(
      inA((db) => db.auditEvent.deleteMany({ where: { id: fixtures.a.auditEventId } })),
    ).rejects.toThrow();
  });
});
