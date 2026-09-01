import { createLogger } from '@brandspace/shared';
import { QUEUE_DEFINITIONS, QUEUE_NAMES } from './queues';

/**
 * Worker entrypoint. Phase 1 registers no processors — queues are defined so the
 * boundary and configuration exist, and each queue activates in its own phase.
 */
async function main(): Promise<void> {
  const log = createLogger({ context: { service: 'worker' } });
  log.info('worker starting', {
    queues: QUEUE_NAMES.map((n) => ({
      name: n,
      activeFromPhase: QUEUE_DEFINITIONS[n].activeFromPhase,
    })),
  });
  log.info('phase 1: no processors registered; queue definitions only');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
