import { writeAuditEvent, type TenantScopedClient } from '@brandspace/database';
import { knowledgeSignatureFor } from '@brandspace/brand-brain';
import { brandIdQueryFilter, systemClock, type Clock } from '@brandspace/shared';
import { strategyNotFound } from './errors';

/**
 * D13 ACKNOWLEDGE (Phase 2C-4, owner decision: Option 1) — "Brand Brain
 * changed", seen and accepted as it stands.
 *
 * ACKNOWLEDGING IS RE-BASELINING, and nothing else. The ACCEPTED strategy's
 * stored `knowledgeSignature` (M7) is overwritten with the CURRENT signature of
 * the brand's usable facts — the grounding layer's own `knowledgeSignatureFor`,
 * so the alert and its dismissal cannot disagree about what "usable" means. No
 * migration, no column, no table: the baseline the alert compares against is
 * the only state there is. A later change to the usable facts produces a
 * different signature, and the alert returns on its own.
 *
 * THE CALLER CHECKS `strategy.manage` (the API route; the button is not offered
 * without it). The strategy is found through the brand-scope PREDICATE, so a
 * strategy of another workspace or of a brand outside the member's scope is the
 * same 404 as one that does not exist.
 *
 * NOTHING TO ACKNOWLEDGE WRITES NOTHING. When the stored signature is already
 * current — a double click, a stale tab — or the strategy has no stored
 * signature at all (older than M7, which never alerts), nothing is written and
 * no audit event is recorded. Otherwise the write is conditional on the
 * signature the service read, so two people acknowledging at once record one
 * change, and it is audited `strategy.knowledge_change.acknowledged` with the
 * previous and the new signature (as `knowledgeBaseline`, see below).
 */
export async function acknowledgeKnowledgeChange(
  db: TenantScopedClient,
  input: {
    readonly workspaceId: string;
    readonly insightId: string;
    readonly actorUserId: string;
    readonly brandScope: readonly string[];
    readonly clock?: Clock;
  },
): Promise<{ readonly acknowledged: boolean; readonly knowledgeSignature: string | null }> {
  const clock = input.clock ?? systemClock;
  const strategy = await db.insight.findFirst({
    where: {
      id: input.insightId,
      workspaceId: input.workspaceId,
      type: 'STRATEGY',
      status: 'ACCEPTED',
      ...brandIdQueryFilter({ brandScope: input.brandScope }),
    },
    select: { id: true, brandId: true, knowledgeSignature: true },
  });
  if (!strategy) throw strategyNotFound();

  const previous = strategy.knowledgeSignature;
  // No baseline (an older strategy) never alerts, so there is nothing to acknowledge.
  if (previous === null) return { acknowledged: false, knowledgeSignature: null };

  const current = await knowledgeSignatureFor(db, { brandId: strategy.brandId }, clock);
  if (current === previous) return { acknowledged: false, knowledgeSignature: current };

  const claimed = await db.insight.updateMany({
    where: { id: strategy.id, knowledgeSignature: previous },
    data: { knowledgeSignature: current },
  });
  // Somebody else re-baselined it first: their write is the acknowledgement.
  if (claimed.count !== 1) return { acknowledged: false, knowledgeSignature: current };

  await writeAuditEvent(db, input.workspaceId, {
    action: 'strategy.knowledge_change.acknowledged',
    actorType: 'USER',
    actorId: input.actorUserId,
    resourceType: 'Insight',
    resourceId: strategy.id,
    brandId: strategy.brandId,
    // Under `knowledgeBaseline`, not `knowledgeSignature`: the audit redactor
    // blanks every key containing "signature" (it is written for credentials),
    // and this value is a digest of fact ids and versions, not a secret — the
    // owner asked for both values in the record.
    before: { knowledgeBaseline: previous },
    after: { knowledgeBaseline: current },
  });
  return { acknowledged: true, knowledgeSignature: current };
}
