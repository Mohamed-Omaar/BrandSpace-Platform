/**
 * D-574 — THE KEK RE-WRAP COMMAND (docs/SECRET-ROTATION.md).
 *
 *   pnpm secrets:rewrap-kek --domain platform --actor owner@example.com --dry-run
 *   pnpm secrets:rewrap-kek --domain platform --actor owner@example.com
 *
 * Re-wraps every data key of one key domain from the OLD key-encryption key to
 * the NEW one. Both keys are read from environment variables BY NAME; by
 * default the old key is `<KEK>_PREVIOUS` and the new one is `<KEK>` (the
 * order the runbook sets them in). `--old-var` and `--new-var` name others.
 *
 * Prints counts only. Never a key, a data key or a secret value. Exits:
 *   0  every envelope is under the new KEK and decrypts with it (safe to drop the old KEK)
 *   1  something failed or was not verified (keep the old KEK; nothing to drop)
 *   2  the command was used wrongly (missing or equal keys, unknown actor or domain)
 *
 * Runs on the API service, which holds all three key domains. Development and
 * staging only: production seals with AWS KMS, whose keys are not in the
 * environment and rotate inside KMS.
 */
import { getPlatformClient } from '@brandspace/database/platform';
import {
  CUSTOMER_MFA_DOMAIN,
  LocalDevelopmentKeyProvider,
  PLATFORM_SECRET_DOMAIN,
  SOCIAL_TOKEN_DOMAIN,
  isRewrapDomain,
  rewrapKeyDomain,
  type KeyDomain,
  type RewrapDomain,
} from '@brandspace/secrets';

const DOMAINS: Record<RewrapDomain, KeyDomain> = {
  platform: PLATFORM_SECRET_DOMAIN,
  social: SOCIAL_TOKEN_DOMAIN,
  customerMfa: CUSTOMER_MFA_DOMAIN,
};

export interface RewrapCommandIo {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  /** TEST SEAM: a platform-identity client for another database. The command uses the API's own. */
  readonly prisma?: ReturnType<typeof getPlatformClient>;
}

function option(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

/** The whole command, testable without a process: returns the exit code. */
export async function runRewrapCommand(io: RewrapCommandIo): Promise<number> {
  const { argv, env, out } = io;
  const domainName = option(argv, '--domain') ?? '';
  const actorEmail = (option(argv, '--actor') ?? '').trim().toLowerCase();
  const dryRun = argv.includes('--dry-run');

  if (!isRewrapDomain(domainName)) {
    out('Usage: --domain platform|social|customerMfa --actor <platform owner email> [--dry-run]');
    return 2;
  }
  const domain = DOMAINS[domainName];
  const oldVar = option(argv, '--old-var') ?? domain.previousKekVar;
  const newVar = option(argv, '--new-var') ?? domain.kekVar;
  const oldValue = env[oldVar];
  const newValue = env[newVar];
  if (!oldValue || !newValue) {
    out(`Both ${oldVar} (the old key) and ${newVar} (the new key) must be set. No value is shown.`);
    return 2;
  }
  if (oldValue === newValue) {
    out(`${oldVar} and ${newVar} hold the same key. Set the new key before re-wrapping.`);
    return 2;
  }
  if (!actorEmail) {
    out('--actor must name the active platform user running this, for the audit trail.');
    return 2;
  }

  const prisma = io.prisma ?? getPlatformClient();
  const actor = await prisma.platformUser.findFirst({
    where: { email: actorEmail, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!actor) {
    out('No active platform user has that email. Nothing was changed.');
    return 2;
  }

  let oldKek: LocalDevelopmentKeyProvider;
  let newKek: LocalDevelopmentKeyProvider;
  try {
    oldKek = new LocalDevelopmentKeyProvider(oldValue);
    newKek = new LocalDevelopmentKeyProvider(newValue);
  } catch {
    out(
      'The keys could not be used here (each must be at least 32 characters, and this command does not run in production, which uses KMS). No value is shown.',
    );
    return 2;
  }

  const report = await rewrapKeyDomain({
    prisma,
    domain: domainName,
    oldKek,
    newKek,
    dryRun,
    actorPlatformUserId: actor.id,
  });

  out(
    [
      `domain: ${report.domain}${report.dryRun ? ' (dry run: nothing changed)' : ''}`,
      `total: ${report.total}`,
      `already under the new key: ${report.alreadyDone}`,
      `${report.dryRun ? 'would re-wrap' : 're-wrapped'}: ${report.rewrapped}`,
      `failed: ${report.failed}`,
      `verified with the new key: ${report.verified}`,
    ].join('\n'),
  );
  if (report.stoppedBeforeWriting) {
    out(
      `Stopped before writing: ${report.failed} envelope(s) open with neither key. Check ${oldVar}. Keep the old key.`,
    );
    return 1;
  }
  if (report.dryRun) return report.failed === 0 ? 0 : 1;
  if (report.failed > 0 || report.verified !== report.total) {
    out(`Not every envelope verified. Keep ${oldVar}; run again after fixing the cause.`);
    return 1;
  }
  out(`Every envelope opens with the new key. ${oldVar} can now be removed.`);
  return 0;
}

const invokedDirectly = process.argv[1]?.endsWith('rewrap-kek.ts') ?? false;
if (invokedDirectly) {
  runRewrapCommand({
    argv: process.argv.slice(2),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
  })
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      // The error's NAME only: a driver message can carry a connection string.
      process.stderr.write(
        `The re-wrap stopped: ${error instanceof Error ? error.name : 'Error'}\n`,
      );
      process.exit(1);
    });
}
