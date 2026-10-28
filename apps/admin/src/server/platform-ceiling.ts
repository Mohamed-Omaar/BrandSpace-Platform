import {
  measurePlatformSpend,
  platformPeriodStarts,
  platformThresholdsReached,
} from '@brandspace/ai-gateway';
import type { ConfigurationService, Environment } from '@brandspace/config';
import type { PlatformPrismaClient } from '@brandspace/database/platform';
import { systemClock, type Clock } from '@brandspace/shared';

/** The highest platform-ceiling alert level reached, or null. */
export type PlatformCeilingNotice = {
  readonly period: 'day' | 'month';
  readonly percent: 80 | 100;
} | null;

/**
 * D-573 — where the platform's AI spend stands against `ai.budgets.platform`,
 * by the same sum the gateway admits against. 100% means AI is paused for
 * every customer. A month alert outranks a day alert at the same level,
 * because it lasts longer.
 *
 * Kept free of Next's server-only modules, and given its dependencies, so the
 * real reading can be tested against PostgreSQL (`platform-ceiling-alert.test.ts`).
 */
export async function platformCeilingNotice(deps: {
  readonly configuration: Pick<ConfigurationService, 'get'>;
  readonly prisma: Pick<PlatformPrismaClient, 'aiRequest'>;
  readonly environment: Environment;
  readonly clock?: Clock;
}): Promise<PlatformCeilingNotice> {
  const budgets = await deps.configuration.get('ai.budgets', deps.environment);
  const limits = budgets.platform;
  if (
    limits.providerCostPerDayMicroMinor === null &&
    limits.providerCostPerMonthMicroMinor === null
  ) {
    return null;
  }
  const now = (deps.clock ?? systemClock).now();
  const spend = await measurePlatformSpend(deps.prisma, now);
  const crossings = platformThresholdsReached(limits, spend, platformPeriodStarts(now));
  const rank = (c: { percent: number; period: string }) =>
    c.percent * 2 + (c.period === 'month' ? 1 : 0);
  let best: PlatformCeilingNotice = null;
  for (const crossing of crossings) {
    const candidate = { period: crossing.period, percent: crossing.thresholdPercent };
    if (best === null || rank(candidate) > rank(best)) best = candidate;
  }
  return best;
}
