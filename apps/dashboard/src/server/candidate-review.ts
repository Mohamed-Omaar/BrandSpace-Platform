import {
  reviewCandidateSchema,
  type BrandKnowledgeService,
  type KnowledgeActor,
  type LocalizedText,
  type StalenessPolicy,
} from '@brandspace/brand-brain';
import type { TenantScopedClient } from '@brandspace/database';
import { brandIdQueryFilter } from '@brandspace/shared';
import { GOAL_ITEM_KEY } from './setup-wizard-state';

/**
 * REVIEWING AN EXTRACTED CANDIDATE — the form decoding and the review call,
 * shared by the Brand Brain's review action and the setup wizard's (review
 * item 15), so the two cannot come to parse or apply a decision differently.
 *
 * WHO DECIDES "SETUP" (D-335). Never the request. Nothing a client posts — a
 * return path, a hidden field, a URL — can mark knowledge as setup's. The Brand
 * Brain's action ALWAYS records DOCUMENT. The wizard's own action records SETUP
 * only when the server finds that brand's setup still in progress; otherwise
 * it too records DOCUMENT.
 */

export type ReviewCandidateInput = ReturnType<typeof reviewCandidateSchema.parse>;

function localized(formData: FormData, prefix: string): LocalizedText {
  const en = String(formData.get(`${prefix}En`) ?? '').trim();
  const ar = String(formData.get(`${prefix}Ar`) ?? '').trim();
  return {
    ...(en.length > 0 ? { en } : {}),
    ...(ar.length > 0 ? { ar } : {}),
  };
}

export function reviewCandidateInputFrom(formData: FormData): ReviewCandidateInput {
  const decision = String(formData.get('decision') ?? '');
  return reviewCandidateSchema.parse({
    candidateId: String(formData.get('candidateId') ?? ''),
    decision,
    // Only an edited acceptance may carry text. The schema refuses an edit
    // smuggled alongside a plain accept, so this stays honest.
    ...(decision === 'accept_edited'
      ? { title: localized(formData, 'title'), body: localized(formData, 'body') }
      : {}),
    ...(formData.get('reason') ? { reason: String(formData.get('reason')) } : {}),
  });
}

/**
 * Is setup still in progress for the brand this candidate belongs to? Setup
 * for a brand ends with its first goal (D-278, D-303): until the brand has a
 * goal in its strategy memory, the wizard's Review step is part of an
 * unfinished setup. Read in the caller's transaction, under RLS and the
 * member's BrandScope — a candidate the member cannot see is "not in setup".
 */
export async function setupReviewInProgress(
  db: TenantScopedClient,
  candidateId: string,
  brandScope: readonly string[],
): Promise<boolean> {
  const candidate = await db.brandKnowledgeCandidate.findFirst({
    where: { id: candidateId, ...brandIdQueryFilter({ brandScope }) },
    select: { brandId: true },
  });
  if (!candidate) return false;
  const goal = await db.brandKnowledgeItem.findFirst({
    where: {
      brandId: candidate.brandId,
      area: 'STRATEGY',
      itemKey: GOAL_ITEM_KEY,
      status: { in: ['ACTIVE', 'STALE'] },
    },
    select: { id: true },
  });
  return goal === null;
}

/** Apply a review decision. `acceptedInSetup` is decided by the caller, on the server. */
export function applyCandidateReview(
  knowledge: BrandKnowledgeService,
  input: ReviewCandidateInput,
  actor: KnowledgeActor,
  staleness: StalenessPolicy,
  acceptedInSetup: boolean,
): Promise<{ readonly itemId: string | null; readonly version: number | null }> {
  return knowledge.reviewCandidate({
    candidateId: input.candidateId,
    decision: input.decision,
    title: input.title,
    body: input.body,
    reason: input.reason,
    actor,
    policy: staleness,
    acceptedInSetup,
  });
}
