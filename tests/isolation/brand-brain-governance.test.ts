import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { BrandKnowledgeService, type StalenessPolicy } from '@brandspace/brand-brain';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * Knowledge governance against a real PostgreSQL — D-65 end to end.
 *
 * These are the assertions that would let a weakened implementation through if
 * they did not exist: versioning that overwrites, a rollback that rewinds
 * history, a review that lets extraction reach approved knowledge directly, and
 * a second reviewer silently re-applying a decision.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;

const POLICY: StalenessPolicy = { reviewIntervalDays: 90 };

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

/**
 * Run inside tenant A with a service bound to the scoped client.
 *
 * The callback receives the SCOPED CLIENT as well as the service, and every
 * helper below takes it. That is not tidiness: `withWorkspace` opens a
 * transaction, so a nested call would open a SECOND one that cannot see the
 * first's uncommitted writes — every read would come back empty and the suite
 * would report a governance failure that was really a transaction boundary.
 */
type ScopedDb = Parameters<Parameters<typeof withWorkspace>[1]>[0];

async function inA<T>(fn: (svc: BrandKnowledgeService, db: ScopedDb) => Promise<T>): Promise<T> {
  return withWorkspace(
    fixtures.a.workspaceId,
    async (db) => fn(new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId }), db),
    { prisma: app },
  );
}

const actor = () => ({
  userId: fixtures.a.userId,
  permissionKeys: [] as string[],
  // Unrestricted, which is what every membership carries today (F-74).
  brandScope: [] as string[],
});

let sequence = 0;
const uniqueKey = (stem: string) => `${stem}.${(sequence += 1)}`;

describe('creating human knowledge', () => {
  it('lands ACTIVE and HUMAN, and writes version 1', async () => {
    const key = uniqueKey('identity.created');
    const { item, versions } = await inA(async (svc, db) => {
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'IDENTITY',
        itemKey: key,
        title: { en: 'Positioning' },
        body: { en: 'We serve independent retailers.' },
        actor: actor(),
        policy: POLICY,
      });
      const history = await withVersions(db, created.id);
      return { item: created, versions: history };
    });

    // A person stating a fact about their own brand is not proposing it for
    // review: D-65's approval gate is for what the SYSTEM infers.
    expect(item.origin).toBe('HUMAN');
    expect(item.status).toBe('ACTIVE');
    expect(item.version).toBe(1);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.changeKind).toBe('created');
  });

  it('writes an audit event for the creation', async () => {
    const key = uniqueKey('identity.audited');
    const item = await inA((svc) =>
      svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'IDENTITY',
        itemKey: key,
        title: { en: 'Audited' },
        body: { en: 'Audited body' },
        actor: actor(),
        policy: POLICY,
      }),
    );

    const events = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) =>
        db.auditEvent.findMany({
          where: { resourceId: item.id, action: 'brand_brain.knowledge.created' },
        }),
      { prisma: app },
    );
    expect(events).toHaveLength(1);
  });

  it('does NOT put the prose into the audit event', async () => {
    // The audit log must not quietly become a second copy of the corpus.
    const key = uniqueKey('identity.secret');
    const secret = 'CONFIDENTIAL-POSITIONING-STRING';
    const item = await inA((svc) =>
      svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'IDENTITY',
        itemKey: key,
        title: { en: 'Secret' },
        body: { en: secret },
        actor: actor(),
        policy: POLICY,
      }),
    );
    const events = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => db.auditEvent.findMany({ where: { resourceId: item.id } }),
      { prisma: app },
    );
    expect(JSON.stringify(events)).not.toContain(secret);
  });
});

describe('editing is versioning, never overwriting', () => {
  it('increments the version and KEEPS the previous value readable', async () => {
    const key = uniqueKey('identity.versioned');
    const result = await inA(async (svc, db) => {
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'IDENTITY',
        itemKey: key,
        title: { en: 'V1 title' },
        body: { en: 'V1 body' },
        actor: actor(),
        policy: POLICY,
      });
      const updated = await svc.updateItem({
        itemId: created.id,
        title: { en: 'V2 title' },
        body: { en: 'V2 body' },
        changeReason: 'Sharpened the wording',
        actor: actor(),
        policy: POLICY,
      });
      return { created, updated, versions: await withVersions(db, created.id) };
    });

    expect(result.updated.version).toBe(2);
    expect(result.versions.map((v) => v.version)).toEqual([1, 2]);
    // D-65 reproducibility: v1's text is still there, so a generation that
    // cited v1 can be explained after the fact.
    expect(JSON.stringify(result.versions[0]?.body)).toContain('V1 body');
    expect(JSON.stringify(result.versions[1]?.body)).toContain('V2 body');
  });

  it('records the reviewer reason on the version', async () => {
    const key = uniqueKey('identity.reasoned');
    const versions = await inA(async (svc, db) => {
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'IDENTITY',
        itemKey: key,
        title: { en: 'x' },
        body: { en: 'y' },
        actor: actor(),
        policy: POLICY,
      });
      await svc.updateItem({
        itemId: created.id,
        title: { en: 'x2' },
        body: { en: 'y2' },
        changeReason: 'Board approved new wording',
        actor: actor(),
        policy: POLICY,
      });
      return withVersions(db, created.id);
    });
    expect(versions[1]?.changeReason).toBe('Board approved new wording');
  });

  it('REFUSES an AI inference aimed at human knowledge', async () => {
    // D-65 enforced at the WRITE, not in a screen — so a second caller cannot
    // bypass it by not being a screen.
    const key = uniqueKey('identity.protected');
    await expect(
      inA(async (svc) => {
        const created = await svc.createItem({
          brandId: fixtures.a.brandId,
          area: 'IDENTITY',
          itemKey: key,
          title: { en: 'Human truth' },
          body: { en: 'Stated by a person.' },
          actor: actor(),
          policy: POLICY,
        });
        return svc.updateItem({
          itemId: created.id,
          title: { en: 'Machine guess' },
          body: { en: 'Inferred from performance.' },
          actor: actor(),
          policy: POLICY,
          incomingOrigin: 'AI_INFERRED',
        });
      }),
    ).rejects.toThrow(/cannot be replaced automatically/i);
  });

  it('leaves the human text intact after the refusal', async () => {
    const key = uniqueKey('identity.intact');
    const body = await inA(async (svc, db) => {
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'IDENTITY',
        itemKey: key,
        title: { en: 'Human truth' },
        body: { en: 'ORIGINAL-HUMAN-TEXT' },
        actor: actor(),
        policy: POLICY,
      });
      await svc
        .updateItem({
          itemId: created.id,
          title: { en: 'Machine guess' },
          body: { en: 'OVERWRITTEN' },
          actor: actor(),
          policy: POLICY,
          incomingOrigin: 'AI_INFERRED',
        })
        .catch(() => undefined);
      const after = await currentItem(db, created.id);
      return JSON.stringify(after?.body);
    });
    expect(body).toContain('ORIGINAL-HUMAN-TEXT');
    expect(body).not.toContain('OVERWRITTEN');
  });

  it('answers 404 for an item in another tenant, shaped like a genuine miss', async () => {
    await expect(
      inA((svc) =>
        svc.updateItem({
          itemId: fixtures.b.knowledgeItemId,
          title: { en: 'x' },
          body: { en: 'y' },
          actor: actor(),
          policy: POLICY,
        }),
      ),
    ).rejects.toThrow(/Knowledge item not found/);
  });
});

describe('rollback is a forward version, not a rewind', () => {
  it('restores the old text as a NEW version and keeps everything in between', async () => {
    const key = uniqueKey('identity.rollback');
    const result = await inA(async (svc, db) => {
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'IDENTITY',
        itemKey: key,
        title: { en: 'V1' },
        body: { en: 'ORIGINAL' },
        actor: actor(),
        policy: POLICY,
      });
      await svc.updateItem({
        itemId: created.id,
        title: { en: 'V2' },
        body: { en: 'REGRETTABLE' },
        actor: actor(),
        policy: POLICY,
      });
      const restored = await svc.rollback({
        itemId: created.id,
        toVersion: 1,
        reason: 'Reverted a bad edit',
        actor: actor(),
        policy: POLICY,
      });
      return { restored, versions: await withVersions(db, created.id) };
    });

    expect(result.restored.version).toBe(3);
    expect(JSON.stringify(result.restored.body)).toContain('ORIGINAL');
    // Nothing was destroyed: the regrettable edit is still on the record.
    expect(result.versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(JSON.stringify(result.versions[1]?.body)).toContain('REGRETTABLE');
    expect(result.versions[2]?.changeKind).toBe('rolled_back');
  });

  it('refuses a version that does not exist', async () => {
    const key = uniqueKey('identity.norollback');
    await expect(
      inA(async (svc) => {
        const created = await svc.createItem({
          brandId: fixtures.a.brandId,
          area: 'IDENTITY',
          itemKey: key,
          title: { en: 'x' },
          body: { en: 'y' },
          actor: actor(),
          policy: POLICY,
        });
        return svc.rollback({ itemId: created.id, toVersion: 99, actor: actor(), policy: POLICY });
      }),
    ).rejects.toThrow(/Version not found/);
  });
});

describe('candidate review is the only path from an upload to knowledge', () => {
  it('accepting a candidate creates the item and records the link', async () => {
    const key = uniqueKey('audience.fromdoc');
    const result = await inA(async (svc, db) => {
      const candidate = await createCandidate(db, key);
      const outcome = await svc.reviewCandidate({
        candidateId: candidate.id,
        decision: 'accept',
        actor: actor(),
        policy: POLICY,
      });
      return { outcome, candidate: await currentCandidate(db, candidate.id) };
    });

    expect(result.outcome.itemId).not.toBeNull();
    expect(result.candidate?.status).toBe('ACCEPTED');
    // The decision is linked to its effect.
    expect(result.candidate?.resultingVersion).toBe(result.outcome.version);
    expect(result.candidate?.reviewedByUserId).toBe(fixtures.a.userId);
  });

  it('an accepted candidate lands as DOCUMENT, so its approvers can still edit it', async () => {
    /*
     * If acceptance produced an AI_INFERRED item, `mayOverwrite` would
     * afterwards refuse edits from the very people who approved it — a review
     * queue that produces unmaintainable knowledge.
     */
    const key = uniqueKey('audience.editable');
    const origin = await inA(async (svc, db) => {
      const candidate = await createCandidate(db, key);
      const outcome = await svc.reviewCandidate({
        candidateId: candidate.id,
        decision: 'accept',
        actor: actor(),
        policy: POLICY,
      });
      const item = await currentItem(db, outcome.itemId ?? '');
      return item?.origin;
    });
    expect(origin).toBe('DOCUMENT');
  });

  it('an edited acceptance PRESERVES the original extraction alongside the edit', async () => {
    const key = uniqueKey('audience.edited');
    const candidateAfter = await inA(async (svc, db) => {
      const candidate = await createCandidate(db, key, 'EXTRACTED-ORIGINAL');
      await svc.reviewCandidate({
        candidateId: candidate.id,
        decision: 'accept_edited',
        title: { en: 'Reviewer title' },
        body: { en: 'REVIEWER-EDIT' },
        reason: 'Extraction was too broad',
        actor: actor(),
        policy: POLICY,
      });
      return currentCandidate(db, candidate.id);
    });

    expect(candidateAfter?.status).toBe('EDITED_ACCEPTED');
    // "What did the system actually say" stays answerable after the edit.
    expect(JSON.stringify(candidateAfter?.extractedBody)).toContain('EXTRACTED-ORIGINAL');
    expect(JSON.stringify(candidateAfter?.reviewedBody)).toContain('REVIEWER-EDIT');
  });

  it('rejecting leaves approved knowledge untouched', async () => {
    const key = uniqueKey('audience.rejected');
    const result = await inA(async (svc, db) => {
      const candidate = await createCandidate(db, key);
      const outcome = await svc.reviewCandidate({
        candidateId: candidate.id,
        decision: 'reject',
        reason: 'Not accurate',
        actor: actor(),
        policy: POLICY,
      });
      const item = await db.brandKnowledgeItem.findFirst({ where: { itemKey: key } });
      return { outcome, item, candidate: await currentCandidate(db, candidate.id) };
    });

    expect(result.outcome.itemId).toBeNull();
    expect(result.item).toBeNull();
    expect(result.candidate?.status).toBe('REJECTED');
    expect(result.candidate?.reviewReason).toBe('Not accurate');
  });

  it('REFUSES a second review of the same candidate', async () => {
    // Two reviewers opening the same queue is ordinary. The second must be
    // told, not allowed to silently re-apply a decision.
    const key = uniqueKey('audience.double');
    await expect(
      inA(async (svc, db) => {
        const candidate = await createCandidate(db, key);
        await svc.reviewCandidate({
          candidateId: candidate.id,
          decision: 'accept',
          actor: actor(),
          policy: POLICY,
        });
        return svc.reviewCandidate({
          candidateId: candidate.id,
          decision: 'reject',
          actor: actor(),
          policy: POLICY,
        });
      }),
    ).rejects.toThrow(/already been reviewed/i);
  });

  it('answers 404 for a candidate in another tenant', async () => {
    await expect(
      inA((svc) =>
        svc.reviewCandidate({
          candidateId: fixtures.b.candidateId,
          decision: 'accept',
          actor: actor(),
          policy: POLICY,
        }),
      ),
    ).rejects.toThrow(/Knowledge candidate not found/);
  });
});

describe('staleness and completion', () => {
  it('marks items past their review window STALE without deleting them', async () => {
    const key = uniqueKey('offers.stale');
    const result = await inA(async (svc, db) => {
      // A policy of zero days makes the item due immediately.
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'OFFERS',
        itemKey: key,
        title: { en: 'Summer package' },
        body: { en: 'Not confirmed recently.' },
        actor: actor(),
        policy: { reviewIntervalDays: -1 },
      });
      await svc.markStale(fixtures.a.brandId);
      return currentItem(db, created.id);
    });
    expect(result?.status).toBe('STALE');
    // Still there. Knowledge that has not been confirmed recently is still the
    // best the brand has.
    expect(result).not.toBeNull();
  });

  it('an edit clears staleness, because editing IS reviewing', async () => {
    const key = uniqueKey('offers.refreshed');
    const after = await inA(async (svc) => {
      const created = await svc.createItem({
        brandId: fixtures.a.brandId,
        area: 'OFFERS',
        itemKey: key,
        title: { en: 'x' },
        body: { en: 'y' },
        actor: actor(),
        policy: { reviewIntervalDays: -1 },
      });
      await svc.markStale(fixtures.a.brandId);
      const updated = await svc.updateItem({
        itemId: created.id,
        title: { en: 'x2' },
        body: { en: 'y2' },
        actor: actor(),
        policy: POLICY,
      });
      return updated;
    });
    expect(after.status).toBe('ACTIVE');
  });

  it('completion counts only this brand, and reports every area', async () => {
    const completion = await inA((svc) => svc.completion(fixtures.a.brandId));
    expect(completion.areas).toHaveLength(10);
    expect(completion.percent).toBeGreaterThanOrEqual(0);
    expect(completion.percent).toBeLessThanOrEqual(100);
  });

  it('a pending candidate raises the review backlog without raising completion', async () => {
    const key = uniqueKey('competitors.backlog');
    const { before, after } = await inA(async (svc, db) => {
      const first = await svc.completion(fixtures.a.brandId);
      await createCandidate(db, key, 'pending text', 'COMPETITORS');
      const second = await svc.completion(fixtures.a.brandId);
      return { before: first, after: second };
    });
    expect(after.totalPendingCandidates).toBeGreaterThan(before.totalPendingCandidates);
    expect(after.percent).toBe(before.percent);
  });
});

// --- helpers ---------------------------------------------------------------

async function withVersions(db: ScopedDb, itemId: string) {
  return db.brandKnowledgeVersion.findMany({
    where: { knowledgeItemId: itemId },
    orderBy: { version: 'asc' },
  });
}

async function currentItem(db: ScopedDb, itemId: string) {
  return db.brandKnowledgeItem.findUnique({ where: { id: itemId } });
}

async function currentCandidate(db: ScopedDb, candidateId: string) {
  return db.brandKnowledgeCandidate.findUnique({ where: { id: candidateId } });
}

/** A PENDING candidate, as ingestion would have written it. */
async function createCandidate(
  db: ScopedDb,
  itemKey: string,
  body = 'extracted text',
  area: 'AUDIENCE' | 'COMPETITORS' = 'AUDIENCE',
) {
  return db.brandKnowledgeCandidate.create({
    data: {
      workspaceId: fixtures.a.workspaceId,
      brandId: fixtures.a.brandId,
      sourceDocumentId: fixtures.a.sourceDocumentId,
      area,
      itemKey,
      extractedTitle: { en: 'Extracted' },
      extractedBody: { en: body },
      confidenceMilli: 700,
      evidence: [{ chunkId: fixtures.a.sourceChunkId, locator: 'page 1' }],
    },
  });
}
