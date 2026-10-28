/**
 * A SEPARATE PROCESS that raises platform-ceiling alerts, for
 * `tests/isolation/platform-ceiling-alert.test.ts`. Several of these run at once
 * against the same database to prove the alert is raised once per period and
 * threshold across processes, not merely once per process.
 *
 * Reads the crossings as JSON from argv[2] and a start instant (epoch ms) from
 * argv[3]. It opens its database connection first and then waits for that
 * instant, so every child raises the alert at the same moment — the race the
 * advisory lock exists for. Its last stdout line is "done".
 */
import { getPlatformClient } from '@brandspace/database/platform';
import { alertPlatformOwner } from '../../../apps/api/src/ai-gateway-factory';
import type { PlatformThresholdCrossing } from '@brandspace/ai-gateway';

type Wire = Omit<PlatformThresholdCrossing, 'periodStart' | 'spentMicroMinor'> & {
  periodStart: string;
  spentMicroMinor: string;
};

async function main(): Promise<void> {
  const wire = JSON.parse(process.argv[2] ?? '[]') as Wire[];
  const crossings: PlatformThresholdCrossing[] = wire.map((c) => ({
    ...c,
    periodStart: new Date(c.periodStart),
    spentMicroMinor: BigInt(c.spentMicroMinor),
  }));
  // Warm the pool and the email provider's configuration read, then line up.
  await getPlatformClient().$queryRaw`SELECT 1`;
  const startAt = Number(process.argv[3] ?? Date.now());
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, startAt - Date.now())));
  await alertPlatformOwner(crossings);
  process.stdout.write('done\n');
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.name : 'Error'}\n`);
  process.exit(1);
});
