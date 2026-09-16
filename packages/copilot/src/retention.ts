import type { PrismaClient } from '@brandspace/database';
import type { Clock } from '@brandspace/shared';
import type { CopilotPolicy } from './policy';

/**
 * COPILOT RETENTION — D-116 and D-117 applied to what the assistant persists.
 *
 * THE COPILOT OWNS AN ARTEFACT NOTHING ELSE OWNS: what a customer asked, in
 * their own words, and what they were told. That is closer to a private
 * conversation than to a content draft, and it has no accounting role, so it
 * gets a window and an owner like everything else — declared in
 * `AI_OUTPUT_RETENTION_REGISTRY` under `ai.copilot`, and honoured here.
 *
 * WHAT HAPPENS TO EACH ARTEFACT, and why they differ:
 *
 *   - `copilot_message.body` — NULLED, never deleted, and stamped with
 *     `bodyPurgedAt` so a purged turn is visibly purged rather than silently
 *     blank. The row survives because the SHAPE of the conversation and its
 *     links to plans, tool calls and audit events must outlive the words: an
 *     audit event pointing at a message that no longer exists is a dangling
 *     reference in a security record. The same decision `brand_brain_message`
 *     and `content_variant` already carry.
 *
 *   - `copilot_action_plan` — EXPIRED, not deleted, and only when it never ran.
 *     A plan that executed is the explanation for a mutation that happened; a
 *     plan nobody confirmed is a draft that went stale, and leaving it
 *     AWAITING_CONFIRMATION for ever would leave a live confirmation credential
 *     lying about. Its token hash is cleared at the same moment, which is the
 *     part that matters.
 *
 *   - `copilot_session` — ARCHIVED past its window, so an old conversation stops
 *     appearing in the list without its rows disappearing underneath the audit
 *     trail.
 *
 * WHAT IS NEVER TOUCHED, whatever a window says: `audit_event`, `ai_request`,
 * `ai_usage_ledger`, `credit_transaction`. A retention control able to erase a
 * financial or a security record is a control that erases evidence.
 *
 * THE PLATFORM IDENTITY RUNS THIS, for the reason the analytics prune does:
 * "which rows are past their window" is a cross-tenant question, and no single
 * tenant can ask it.
 *
 * EVERY PASS IS BOUNDED AND IDEMPOTENT. A second pass over the same rows finds
 * nothing left to do — the message filter excludes anything already purged, and
 * the plan filter excludes anything already expired.
 */

export interface CopilotPruneResult {
  readonly messageBodiesPurged: number;
  readonly plansExpired: number;
  readonly sessionsArchived: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export async function pruneCopilot(input: {
  prisma: PrismaClient;
  policy: CopilotPolicy;
  clock: Clock;
  /** Rows touched per table per pass. Bounded so one pass cannot monopolise. */
  limit?: number;
}): Promise<CopilotPruneResult> {
  const now = input.clock.now();
  const batch = input.limit ?? 500;
  const cutoff = new Date(now.getTime() - input.policy.conversation.retentionDays * DAY_MS);

  /*
   * A BOUNDED UPDATE IS NOT `updateMany` WITH A LIMIT — Prisma has no such
   * option, and an unbounded rewrite over a year of a busy workspace is a lock
   * held for minutes. The ids are selected first, bounded, then updated by key.
   *
   * THE FILTER EXCLUDES ALREADY-PURGED ROWS, which is what makes a second pass
   * free rather than a second rewrite of the same rows.
   */
  const staleMessages = await input.prisma.copilotMessage.findMany({
    where: {
      body: { not: null },
      OR: [{ expiresAt: { lt: now } }, { expiresAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true },
    take: batch,
  });
  const messageBodiesPurged =
    staleMessages.length === 0
      ? 0
      : (
          await input.prisma.copilotMessage.updateMany({
            where: { id: { in: staleMessages.map((row) => row.id) } },
            // BOTH COLUMNS TOGETHER. The CHECK constraint refuses a purge stamp
            // without a cleared body, so a half-applied purge is unrepresentable.
            data: { body: null, bodyPurgedAt: now },
          })
        ).count;

  /*
   * ONLY PLANS THAT NEVER RAN. A COMPLETED or FAILED plan is the explanation for
   * something that happened to tenant data, and explanations outlive the words
   * that produced them.
   */
  const stalePlans = await input.prisma.copilotActionPlan.findMany({
    where: {
      status: { in: ['DRAFT', 'AWAITING_CONFIRMATION'] },
      OR: [
        { confirmationExpiresAt: { lt: now } },
        { expiresAt: { lt: now } },
        { expiresAt: null, createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true },
    take: batch,
  });
  const plansExpired =
    stalePlans.length === 0
      ? 0
      : (
          await input.prisma.copilotActionPlan.updateMany({
            where: { id: { in: stalePlans.map((row) => row.id) } },
            data: {
              status: 'EXPIRED',
              // THE CREDENTIAL IS CLEARED. An expired plan holding a live
              // confirmation hash would be a token waiting to be replayed.
              confirmationTokenHash: null,
              confirmationExpiresAt: null,
              undoStatus: 'NOT_APPLICABLE',
            },
          })
        ).count;

  const staleSessions = await input.prisma.copilotSession.findMany({
    where: {
      archivedAt: null,
      OR: [{ expiresAt: { lt: now } }, { expiresAt: null, createdAt: { lt: cutoff } }],
    },
    select: { id: true },
    take: batch,
  });
  const sessionsArchived =
    staleSessions.length === 0
      ? 0
      : (
          await input.prisma.copilotSession.updateMany({
            where: { id: { in: staleSessions.map((row) => row.id) } },
            data: { archivedAt: now },
          })
        ).count;

  return { messageBodiesPurged, plansExpired, sessionsArchived };
}
