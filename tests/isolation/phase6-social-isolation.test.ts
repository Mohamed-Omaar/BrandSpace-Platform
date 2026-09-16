import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Phase 6 tenant isolation — the five new tables, on real PostgreSQL.
 *
 * WHY THESE MATTER MORE THAN MOST. `social_credential` holds a customer's OAuth
 * token: the single most valuable row in this schema, because whoever holds it
 * can post to the world as that customer. `publish_job` and `publish_attempt`
 * record what a workspace said in public and what came back. A leak here is not
 * an information disclosure, it is an account takeover.
 *
 * EVERY ASSERTION IS MADE THROUGH THE UNPRIVILEGED APPLICATION ROLE inside a
 * real workspace context, because that is the only identity that can settle the
 * question. A mocked client would prove that a `where` clause was written, not
 * that the database enforces it.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

type Db = Parameters<Parameters<typeof withWorkspace>[1]>[0];
const inA = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.a.workspaceId, fn as never, { prisma: app }) as Promise<T>;
const inB = <T>(fn: (db: Db) => Promise<T>) =>
  withWorkspace(fixtures.b.workspaceId, fn as never, { prisma: app }) as Promise<T>;

describe('SocialConnection is invisible across the tenant boundary', () => {
  it('a cross-tenant read returns null, not a forbidden', async () => {
    const found = await inA((db) =>
      db.socialConnection.findFirst({ where: { id: fixtures.b.socialConnectionId } }),
    );
    expect(found).toBeNull();
  });

  it('listing never includes the other tenant', async () => {
    const rows = await inA((db) => db.socialConnection.findMany({}));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
  });

  it('a COUNT never counts the other tenant — a count is a disclosure', async () => {
    const count = await inA((db) => db.socialConnection.count({}));
    const all = await inA((db) => db.socialConnection.findMany({ select: { id: true } }));
    expect(count).toBe(all.length);
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.socialConnection.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            provider: 'X',
            externalAccountId: `probe-${randomUUID()}`,
            displayName: 'Probe',
            targetKind: 'profile',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a cross-tenant UPDATE changes nothing rather than failing loudly', async () => {
    /*
     * `updateMany` matches ZERO rows under RLS rather than raising, which is
     * the correct shape: an error would confirm the row exists. The assertion
     * is therefore that the other tenant's row is UNCHANGED afterwards.
     */
    const result = await inA((db) =>
      db.socialConnection.updateMany({
        where: { id: fixtures.b.socialConnectionId },
        data: { status: 'REVOKED', revokedAt: new Date() },
      }),
    );
    expect(result.count).toBe(0);

    const still = await inB((db) =>
      db.socialConnection.findFirst({
        where: { id: fixtures.b.socialConnectionId },
        select: { status: true },
      }),
    );
    expect(still?.status).toBe('ACTIVE');
  });

  it('a cross-tenant DELETE removes nothing', async () => {
    const result = await inA((db) =>
      db.socialConnection.deleteMany({ where: { id: fixtures.b.socialConnectionId } }),
    );
    expect(result.count).toBe(0);
    const still = await inB((db) =>
      db.socialConnection.findFirst({ where: { id: fixtures.b.socialConnectionId } }),
    );
    expect(still).not.toBeNull();
  });
});

describe('SocialCredential — the token is invisible, and that is the point', () => {
  it('another tenant cannot read the ciphertext', async () => {
    const found = await inA((db) =>
      db.socialCredential.findFirst({ where: { id: fixtures.b.socialCredentialId } }),
    );
    expect(found).toBeNull();
  });

  it('listing never returns another tenant credential', async () => {
    const rows = await inA((db) => db.socialCredential.findMany({}));
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
  });

  it('NOT EVEN THE ENCRYPTED MATERIAL LEAKS through a selective read', async () => {
    /*
     * A ciphertext is not plaintext, but it is still the customer's token under
     * a key that may one day be compromised, and a fingerprint is a stable
     * identifier that answers "is this the same account?" across tenants. The
     * boundary is the row, not the readability of the value.
     */
    const rows = await inA((db) =>
      db.socialCredential.findMany({ select: { ciphertext: true, fingerprint: true } }),
    );
    const mine = await inA((db) =>
      db.socialCredential.findFirst({
        where: { id: fixtures.a.socialCredentialId },
        select: { ciphertext: true },
      }),
    );
    expect(rows.some((row) => row.ciphertext === mine?.ciphertext)).toBe(true);
    const theirs = await inB((db) =>
      db.socialCredential.findFirst({
        where: { id: fixtures.b.socialCredentialId },
        select: { ciphertext: true },
      }),
    );
    expect(rows.some((row) => row.ciphertext === theirs?.ciphertext)).toBe(false);
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.socialCredential.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            socialConnectionId: fixtures.b.socialConnectionId,
            version: 99,
            ciphertext: 'probe',
            iv: 'probe',
            authTag: 'probe',
            wrappedDataKey: 'probe',
            keyProvider: 'probe',
            keyId: 'probe',
            encryptionContext: 'probe',
            maskedHint: '••••',
            fingerprint: 'probe',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('ATTACHING A CREDENTIAL TO ANOTHER TENANT CONNECTION IS REFUSED (D-112)', async () => {
    /*
     * The composite key at work. From inside workspace A, naming workspace B's
     * connection id must fail — and fail IDENTICALLY to naming an id that never
     * existed, so the difference cannot answer "does that connection exist?".
     */
    const shape = async (connectionId: string): Promise<string> => {
      try {
        await inA((db) =>
          db.socialCredential.create({
            data: {
              workspaceId: fixtures.a.workspaceId,
              socialConnectionId: connectionId,
              version: 98,
              ciphertext: 'probe',
              iv: 'probe',
              authTag: 'probe',
              wrappedDataKey: 'probe',
              keyProvider: 'probe',
              keyId: 'probe',
              encryptionContext: 'probe',
              maskedHint: '••••',
              fingerprint: 'probe',
            },
          }),
        );
      } catch (error: unknown) {
        const e = error as { code?: unknown };
        return String(e.code);
      }
      throw new Error('the write was ACCEPTED; the D-112 composite key has regressed');
    };
    expect(await shape(fixtures.b.socialConnectionId)).toEqual(await shape(randomUUID()));
  });
});

describe('SocialOAuthState — a live CSRF token, scoped like everything else', () => {
  it('another tenant cannot read a state row', async () => {
    const found = await inA((db) =>
      db.socialOAuthState.findFirst({ where: { id: fixtures.b.socialOAuthStateId } }),
    );
    expect(found).toBeNull();
  });

  it('nor find one by its HASH, which is the value a callback presents', async () => {
    const found = await inA((db) =>
      db.socialOAuthState.findFirst({ where: { stateHash: fixtures.b.socialOAuthStateHash } }),
    );
    expect(found).toBeNull();
  });

  it('listing never crosses the boundary', async () => {
    const rows = await inA((db) => db.socialOAuthState.findMany({}));
    expect(rows.every((row) => row.workspaceId === fixtures.a.workspaceId)).toBe(true);
  });

  it('a cross-tenant write is refused', async () => {
    await expect(
      inA((db) =>
        db.socialOAuthState.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            provider: 'X',
            stateHash: randomUUID(),
            verifierCiphertext: 'probe',
            verifierIv: 'probe',
            verifierAuthTag: 'probe',
            verifierWrappedDataKey: 'probe',
            verifierKeyProvider: 'probe',
            verifierKeyId: 'probe',
            verifierEncryptionContext: 'probe',
            redirectUri: 'https://api.invalid/cb',
            startedByUserId: fixtures.b.userId,
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('CONSUMING ANOTHER TENANT STATE IS A NO-OP, not a takeover', async () => {
    /*
     * The exact shape of the attack this guards: an attacker who somehow knows
     * a victim's state token presents it from their own session. The conditional
     * claim matches zero rows because `workspaceId` is in the predicate AND in
     * the RLS policy, so the flow cannot be completed into the wrong workspace.
     */
    const claimed = await inA((db) =>
      db.socialOAuthState.updateMany({
        where: {
          stateHash: fixtures.b.socialOAuthStateHash,
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      }),
    );
    expect(claimed.count).toBe(0);

    const untouched = await inB((db) =>
      db.socialOAuthState.findFirst({
        where: { id: fixtures.b.socialOAuthStateId },
        select: { consumedAt: true },
      }),
    );
    expect(untouched?.consumedAt).toBeNull();
  });
});

describe('PublishJob and PublishAttempt are scoped, and attempts are evidence', () => {
  it('a cross-tenant read of a job returns null', async () => {
    const found = await inA((db) =>
      db.publishJob.findFirst({ where: { id: fixtures.b.publishJobId } }),
    );
    expect(found).toBeNull();
  });

  it('a cross-tenant read of an attempt returns null', async () => {
    const found = await inA((db) =>
      db.publishAttempt.findFirst({ where: { id: fixtures.b.publishAttemptId } }),
    );
    expect(found).toBeNull();
  });

  it('listing and counting stay inside the workspace', async () => {
    const jobs = await inA((db) => db.publishJob.findMany({}));
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.workspaceId === fixtures.a.workspaceId)).toBe(true);
    const attempts = await inA((db) => db.publishAttempt.findMany({}));
    expect(attempts.every((attempt) => attempt.workspaceId === fixtures.a.workspaceId)).toBe(true);
  });

  it('a cross-tenant job write is refused', async () => {
    await expect(
      inA((db) =>
        db.publishJob.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            calendarSlotId: fixtures.b.calendarSlotId,
            contentItemId: fixtures.b.contentItemId,
            contentVariantId: fixtures.b.contentVariantId,
            socialConnectionId: fixtures.b.socialConnectionId,
            provider: 'X',
            idempotencyKey: `probe-${randomUUID()}`,
            scheduledAtUtc: new Date(),
            maxAttempts: 5,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('EVERY tenant-owned parent of a publish job is composite (D-112)', async () => {
    /*
     * Four parents — slot, item, variant, connection — and a foreign id for any
     * one of them must be refused IDENTICALLY to an invented one. The whole
     * point of D-112 is that "accepted" versus "violates foreign key" stops
     * being an answer to "does that id exist in another workspace?".
     */
    const shape = async (overrides: Record<string, string>): Promise<string> => {
      try {
        await inA((db) =>
          db.publishJob.create({
            data: {
              workspaceId: fixtures.a.workspaceId,
              brandId: fixtures.a.brandId,
              calendarSlotId: fixtures.a.calendarSlotId,
              contentItemId: fixtures.a.contentItemId,
              contentVariantId: fixtures.a.contentVariantId,
              socialConnectionId: fixtures.a.socialConnectionId,
              provider: 'LINKEDIN',
              idempotencyKey: `probe-${randomUUID()}`,
              scheduledAtUtc: new Date(),
              maxAttempts: 5,
              ...overrides,
            },
          }),
        );
      } catch (error: unknown) {
        return String((error as { code?: unknown }).code);
      }
      throw new Error('the write was ACCEPTED; a D-112 composite key has regressed');
    };

    for (const [field, foreign] of [
      ['calendarSlotId', fixtures.b.calendarSlotId],
      ['contentItemId', fixtures.b.contentItemId],
      ['contentVariantId', fixtures.b.contentVariantId],
      ['socialConnectionId', fixtures.b.socialConnectionId],
    ] as const) {
      const real = await shape({ [field]: foreign });
      const invented = await shape({ [field]: randomUUID() });
      expect(real, `${field}: a foreign id must be refused like an invented one`).toEqual(invented);
    }
  });

  it('AN ATTEMPT CANNOT BE REWRITTEN, even by its own tenant', async () => {
    /*
     * Immutability, enforced by a trigger that fires for every role including
     * the table owner. A record support and a platform dispute both read is not
     * evidence if it can be edited afterwards — and this is the tenant's OWN
     * row, which is still refused.
     */
    await expect(
      inA((db) =>
        db.publishAttempt.update({
          where: { id: fixtures.a.publishAttemptId },
          data: { safeSummary: 'rewritten after the fact' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('AN ATTEMPT CANNOT BE DELETED BY THE TENANT — the privilege is revoked', async () => {
    /*
     * NON-DELETABILITY IS A PRIVILEGE, NOT A TRIGGER, and the difference is
     * load-bearing. A BEFORE DELETE trigger fires for a CASCADED delete too,
     * with no way to tell one from the other — so a trigger here made deleting
     * a calendar slot, a content item, a brand or a workspace fail the moment a
     * single attempt existed, and turned the Phase 5B-2 and 5B-3 suites red
     * against a table they know nothing about.
     *
     * A revoked privilege says the right thing instead: a direct DELETE is
     * refused, a cascade is unaffected. So an attempt cannot be removed from a
     * sequence to make a history read differently, while an attempt whose job
     * no longer exists goes with it.
     */
    await expect(
      inA((db) => db.publishAttempt.delete({ where: { id: fixtures.a.publishAttemptId } })),
    ).rejects.toThrow();
    await expect(
      inA((db) => db.publishAttempt.deleteMany({ where: { workspaceId: fixtures.a.workspaceId } })),
    ).rejects.toThrow();

    // And it is still there.
    const still = await inA((db) =>
      db.publishAttempt.findFirst({ where: { id: fixtures.a.publishAttemptId } }),
    );
    expect(still).not.toBeNull();
  });

  it('A CASCADE FROM THE JOB REMOVES ITS ATTEMPTS — ordinary lifecycle still works', async () => {
    /*
     * The other half of the same decision, and the regression this whole
     * arrangement exists to prevent: deleting a slot must not be blocked by
     * evidence about it.
     */
    const jobId = await inA(async (db) => {
      const job = await db.publishJob.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: fixtures.a.brandId,
          calendarSlotId: fixtures.a.calendarSlotId,
          contentItemId: fixtures.a.contentItemId,
          contentVariantId: fixtures.a.contentVariantId,
          socialConnectionId: fixtures.a.socialConnectionId,
          provider: 'LINKEDIN',
          idempotencyKey: `cascade-${randomUUID()}`,
          scheduledAtUtc: new Date(),
          maxAttempts: 5,
        },
      });
      await db.publishAttempt.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          publishJobId: job.id,
          attemptNumber: 1,
          outcome: 'PERMANENT_FAILURE',
          failureClass: 'CONTENT_REJECTED',
        },
      });
      return job.id;
    });

    await inA((db) => db.publishJob.delete({ where: { id: jobId } }));

    const orphaned = await inA((db) =>
      db.publishAttempt.findMany({ where: { publishJobId: jobId } }),
    );
    expect(orphaned).toEqual([]);
  });

  it('the idempotency key is unique PER WORKSPACE, not globally', async () => {
    /*
     * Both tenants generate the key the same way, so a global unique would let
     * one workspace's job block another's — a cross-tenant denial of service
     * that no error message would ever explain.
     */
    const sharedKey = `shared-${randomUUID()}`;
    const create = (tenant: typeof fixtures.a, scope: typeof inA) =>
      scope((db) =>
        db.publishJob.create({
          data: {
            workspaceId: tenant.workspaceId,
            brandId: tenant.brandId,
            calendarSlotId: tenant.calendarSlotId,
            contentItemId: tenant.contentItemId,
            contentVariantId: tenant.contentVariantId,
            socialConnectionId: tenant.socialConnectionId,
            provider: 'LINKEDIN',
            idempotencyKey: sharedKey,
            scheduledAtUtc: new Date(),
            maxAttempts: 5,
          },
        }),
      );

    const first = await create(fixtures.a, inA);
    const second = await create(fixtures.b, inB);
    expect(first.idempotencyKey).toBe(second.idempotencyKey);
    expect(first.workspaceId).not.toBe(second.workspaceId);

    // And WITHIN one workspace it really is unique.
    await expect(create(fixtures.a, inA)).rejects.toThrow();

    await inA((db) => db.publishJob.delete({ where: { id: first.id } }));
    await inB((db) => db.publishJob.delete({ where: { id: second.id } }));
  });
});
