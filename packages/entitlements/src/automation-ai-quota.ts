import type { Environment } from '@brandspace/config';
import type { PrismaClient, TenantScopedClient } from '@brandspace/database';
import { AppError } from '@brandspace/shared';
import { AUTOMATION_AI_ACTIONS_FEATURE } from './automation-ai-cap';
import { EntitlementService, TenantCatalogueSource } from './service';
import { UsageService, type QuotaWindow } from './usage';

/**
 * PHASE 2B-3 PR 6 — COUNTING AI AUTOMATION ACTIONS PER WORKSPACE-LOCAL MONTH
 * (D-458, D-460).
 *
 * THE ONE PLACE THAT BUILDS THE WINDOW. No caller computes a month boundary by
 * hand: the executor asks for the label, keeps it on the run, and passes it
 * back to claim and to release, so a release always reaches the counter row
 * the claim moved — even when it happens in the next month.
 *
 * WHY `billing_cycle`. `UsageService` counts a `month` in UTC; a workspace in
 * Riyadh or Los Angeles is owed its OWN calendar month. The service already
 * counts any explicit window it is given under `period: 'billing_cycle'` with
 * a `cycle`, and a counter row records only the window (`periodStart`,
 * `periodEnd`), never the period's name. So the cap reuses that path unchanged
 * (owner decision, D-460) rather than growing a second window parameter, and
 * this wrapper is what keeps the reuse honest.
 *
 * ANCHORS, NOT INSTANTS. The window is the month LABEL's UTC anchors — the 1st
 * of the label's month and of the next, at 00:00 UTC — not the true local
 * midnight. The counter row's identity is therefore the label itself:
 *   - DST never moves it (no instant is computed in the zone's offset);
 *   - a time-zone change mid-month keeps counting on the same row;
 *   - the label is decided once, from the workspace's time zone, at claim.
 */

/** `YYYY-MM` for `now` in `timezone`. An unknown zone is read as UTC. */
export function workspaceMonthLabel(timezone: string, now: Date): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(now);
  }
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  return `${year}-${month}`;
}

const LABEL = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The counter window a `YYYY-MM` label anchors. */
export function workspaceMonthWindow(label: string): QuotaWindow {
  const match = LABEL.exec(label);
  if (!match) throw new AppError('VALIDATION_FAILED', 'A month label is YYYY-MM.');
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
}

export const automationCapClaimKey = (runId: string) => `automation-cap:${runId}`;
export const automationCapReleaseKey = (runId: string) => `automation-cap-refund:${runId}`;

export interface AutomationAiQuota {
  /** The ceiling in force: 0 when off, `null` when unlimited. */
  limit(): Promise<number | null>;
  /** Take one slot for `runId` in `monthLabel`. Idempotent per run. */
  claim(runId: string, monthLabel: string): Promise<'claimed' | 'cap_reached'>;
  /** Give the run's slot back. Idempotent per run; a no-op if none was taken. */
  release(runId: string, monthLabel: string): Promise<void>;
}

export function createAutomationAiQuota(input: {
  readonly db: TenantScopedClient;
  readonly workspaceId: string;
  readonly environment: Environment;
}): AutomationAiQuota {
  const client = input.db as unknown as PrismaClient;
  const usage = new UsageService({ prisma: client });
  const entitlements = new EntitlementService({
    prisma: client,
    catalogueSource: new TenantCatalogueSource(client, input.environment),
    environment: input.environment,
  });
  const { workspaceId } = input;

  return {
    limit: () => entitlements.limit(workspaceId, AUTOMATION_AI_ACTIONS_FEATURE),

    async claim(runId, monthLabel) {
      const limitValue = await entitlements.limit(workspaceId, AUTOMATION_AI_ACTIONS_FEATURE);
      if (limitValue === 0) return 'cap_reached';
      try {
        await usage.consume({
          workspaceId,
          featureKey: AUTOMATION_AI_ACTIONS_FEATURE,
          limitValue,
          period: 'billing_cycle',
          cycle: workspaceMonthWindow(monthLabel),
          idempotencyKey: automationCapClaimKey(runId),
        });
        return 'claimed';
      } catch (error: unknown) {
        if (error instanceof AppError && error.code === 'QUOTA_EXCEEDED') return 'cap_reached';
        throw error;
      }
    },

    async release(runId, monthLabel) {
      // ONLY A SLOT THIS RUN TOOK. A refund decrements the month's counter
      // whoever moved it, so a release for a run that never claimed would give
      // away another run's slot.
      const claimed = await client.usageEvent.findUnique({
        where: { idempotencyKey: automationCapClaimKey(runId) },
        select: { workspaceId: true },
      });
      if (!claimed || claimed.workspaceId !== workspaceId) return;
      await usage.refund({
        workspaceId,
        featureKey: AUTOMATION_AI_ACTIONS_FEATURE,
        period: 'billing_cycle',
        cycle: workspaceMonthWindow(monthLabel),
        idempotencyKey: automationCapReleaseKey(runId),
      });
    },
  };
}
