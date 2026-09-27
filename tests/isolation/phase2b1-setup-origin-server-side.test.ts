import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace, type TenantScopedClient } from '@brandspace/database';
import { BrandKnowledgeService, type StalenessPolicy } from '@brandspace/brand-brain';
import {
  applyCandidateReview,
  reviewCandidateInputFrom,
  setupReviewInProgress,
} from '../../apps/dashboard/src/server/candidate-review';
import { GOAL_ITEM_KEY } from '../../apps/dashboard/src/server/setup-wizard-state';
import { appRoleClient, createIsolationFixtures, type IsolationFixtures } from './fixtures';

/**
 * PHASE 2B-1 REVIEW, ITEM 15 — SETUP IS NEVER CLIENT-AUTHORISED, AGAINST REAL
 * POSTGRESQL.
 *
 * The two review paths share one decoder and one service call and differ only
 * in who decides the origin: Brand Brain passes DOCUMENT, always; the setup
 * wizard asks the server whether that brand's setup is still in progress (it
 * has no first goal yet). A forged request — the Brand Brain form carrying the
 * wizard's return path, or the wizard's own form after setup has finished, or
 * a candidate from a brand outside the member's scope — produces no SETUP.
 */

let app: PrismaClient;
let fixtures: IsolationFixtures;
const POLICY: StalenessPolicy = { reviewIntervalDays: 90 };

beforeAll(async () => {
  app = appRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
});

const inA = <T>(fn: (db: TenantScopedClient, knowledge: BrandKnowledgeService) => Promise<T>) =>
  withWorkspace(
    fixtures.a.workspaceId,
    (db) => fn(db, new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId })),
    { prisma: app },
  );

const actor = (brandScope: string[] = []) => ({
  userId: fixtures.a.userId,
  permissionKeys: [] as string[],
  brandScope,
});

/** A brand of its own, so its setup state is this test's alone. */
async function brandWithCandidate() {
  return inA(async (db) => {
    const suffix = randomUUID().slice(0, 8);
    const brand = await db.brand.create({
      data: {
        workspaceId: fixtures.a.workspaceId,
        slug: `setup-origin-${suffix}`,
        name: `Setup origin ${suffix}`,
        status: 'ACTIVE',
      },
    });
    const candidate = () =>
      db.brandKnowledgeCandidate.create({
        data: {
          workspaceId: fixtures.a.workspaceId,
          brandId: brand.id,
          sourceDocumentId: fixtures.a.sourceDocumentId,
          area: 'AUDIENCE',
          itemKey: `audience.forged.${randomUUID().slice(0, 8)}`,
          extractedTitle: { en: 'Extracted' },
          extractedBody: { en: 'text' },
          confidenceMilli: 700,
          evidence: [{ chunkId: fixtures.a.sourceChunkId, locator: 'page 1' }],
        },
      });
    return { brandId: brand.id, first: (await candidate()).id, second: (await candidate()).id };
  });
}

function formFor(candidateId: string, extra: Record<string, string> = {}): FormData {
  const form = new FormData();
  form.set('candidateId', candidateId);
  form.set('decision', 'accept');
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

const originOf = (itemId: string | null) =>
  inA(async (db) =>
    itemId
      ? (await db.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } })).origin
      : null,
  );

/** Exactly what `reviewSetupCandidateAction` does, minus the session gate. */
function viaSetupWizard(form: FormData, brandScope: string[] = []) {
  const parsed = reviewCandidateInputFrom(form);
  return inA(async (db, knowledge) =>
    applyCandidateReview(
      knowledge,
      parsed,
      actor(brandScope),
      POLICY,
      await setupReviewInProgress(db, parsed.candidateId, brandScope),
    ),
  );
}

/** Exactly what Brand Brain's `reviewCandidateAction` does, minus the session gate. */
function viaBrandBrain(form: FormData) {
  const parsed = reviewCandidateInputFrom(form);
  return inA((_db, knowledge) => applyCandidateReview(knowledge, parsed, actor(), POLICY, false));
}

describe('Review item 15 · who may mark knowledge as SETUP', () => {
  it('the wizard, during an unfinished setup, records SETUP', async () => {
    const w = await brandWithCandidate();
    expect(await inA((db) => setupReviewInProgress(db, w.first, []))).toBe(true);
    const outcome = await viaSetupWizard(formFor(w.first));
    expect(await originOf(outcome.itemId)).toBe('SETUP');
  });

  it('forged: Brand Brain’s form carrying the wizard’s return path and markers still records DOCUMENT', async () => {
    const w = await brandWithCandidate();
    const outcome = await viaBrandBrain(
      formFor(w.first, { returnTo: '/onboarding', step: 'review', origin: 'SETUP', setup: '1' }),
    );
    expect(await originOf(outcome.itemId)).toBe('DOCUMENT');
  });

  it('forged: the wizard’s action after the brand’s setup has finished records DOCUMENT', async () => {
    const w = await brandWithCandidate();
    // Setup ends with the first goal.
    await inA((_db, knowledge) =>
      knowledge.createItem({
        brandId: w.brandId,
        area: 'STRATEGY',
        itemKey: GOAL_ITEM_KEY,
        title: { en: 'Generate leads' },
        body: { en: 'Our first goal' },
        actor: actor(),
        policy: POLICY,
      }),
    );
    expect(await inA((db) => setupReviewInProgress(db, w.second, []))).toBe(false);
    const outcome = await viaSetupWizard(formFor(w.second, { origin: 'SETUP' }));
    expect(await originOf(outcome.itemId)).toBe('DOCUMENT');
  });

  it('a candidate outside the member’s BrandScope is "not in setup", and the review itself is refused', async () => {
    const w = await brandWithCandidate();
    const elsewhere = [randomUUID()];
    expect(await inA((db) => setupReviewInProgress(db, w.first, elsewhere))).toBe(false);
    await expect(viaSetupWizard(formFor(w.first), elsewhere)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('another workspace’s candidate is never read as in setup', async () => {
    const theirs = await withWorkspace(
      fixtures.b.workspaceId,
      (db) =>
        db.brandKnowledgeCandidate.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            brandId: fixtures.b.brandId,
            sourceDocumentId: fixtures.b.sourceDocumentId,
            area: 'AUDIENCE',
            itemKey: `audience.theirs.${randomUUID().slice(0, 8)}`,
            extractedTitle: { en: 'Theirs' },
            extractedBody: { en: 'text' },
            confidenceMilli: 700,
            evidence: [{ chunkId: fixtures.b.sourceChunkId, locator: 'page 1' }],
          },
        }),
      { prisma: app },
    );
    expect(await inA((db) => setupReviewInProgress(db, theirs.id, []))).toBe(false);
  });
});
