/**
 * Recompute every workspace's storage counter from what is actually stored — B-1.
 *
 * The `20260925120000_storage_bytes_meter` migration already backfills every
 * counter, so this is a CHECK: run the dry run after deploying to confirm there
 * is nothing to correct, and `--apply` only if it reports drift. Never run it
 * against a database you have not been asked to touch.
 *
 *   pnpm storage:recompute            # dry run: prints what would change
 *   pnpm storage:recompute --apply    # writes, one audited transaction per workspace
 *   pnpm storage:recompute --workspace <uuid> [--apply]   # one workspace only
 *
 * It uses the platform database role (DATABASE_PLATFORM_URL), because the
 * counters of every workspace are the point. It prints workspace ids and byte
 * totals only — never a name, a file or a storage key.
 */
import { getPlatformClient } from '@brandspace/database/platform';
import { recomputeStorageUsage } from '@brandspace/entitlements';

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const flag = process.argv.indexOf('--workspace');
  const workspaceId = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (flag >= 0 && !workspaceId) throw new Error('--workspace needs a workspace id.');
  const prisma = getPlatformClient();
  try {
    const rows = await recomputeStorageUsage(prisma, {
      apply,
      ...(workspaceId ? { workspaceId } : {}),
    });
    for (const row of rows) {
      console.log(
        `${row.workspaceId}  bytes ${row.recordedBytes} -> ${row.storedBytes}  ` +
          `GB ${row.recordedGb} -> ${row.storedGb}`,
      );
    }
    console.log(
      apply
        ? `STORAGE_RECOMPUTE_APPLIED workspaces=${rows.length}`
        : `STORAGE_RECOMPUTE_DRY_RUN workspaces_to_correct=${rows.length} (re-run with --apply to write)`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // The message, never the stack or a connection string.
  console.error(error instanceof Error ? error.message : 'Storage recompute failed.');
  process.exitCode = 1;
});
