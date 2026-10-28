import { Prisma, type PrismaClient } from '@brandspace/database';
import { decryptSecret, type KeyProvider } from '@brandspace/vault';

/**
 * D-574 — RE-WRAP EVERY DATA KEY OF ONE KEY DOMAIN UNDER A NEW KEK.
 *
 * Envelope encryption makes a KEK rotation cheap and safe: each secret's value
 * is encrypted by its own DATA KEY, and only the data key is encrypted by the
 * KEK. Rotating the KEK therefore unwraps each data key with the old KEK and
 * wraps it again with the new one. The secret VALUE is never decrypted to do
 * that, and its ciphertext, IV, auth tag and encryption context never change.
 *
 * THE ORDER IS THE SAFETY:
 *
 *   1. CLASSIFY every envelope: already under the new KEK, under the old one, or
 *      under neither. If ANY is under neither (a wrong old KEK, a corrupt row),
 *      stop before writing anything.
 *   2. RE-WRAP each envelope still under the old KEK, one transaction per
 *      envelope, conditional on the wrapped key still being the one that was
 *      read — so a second run, or a run racing another, changes nothing twice.
 *   3. VERIFY every envelope decrypts with the NEW KEK alone. Only a report with
 *      no failure lets the owner remove the old KEK (docs/SECRET-ROTATION.md).
 *   4. AUDIT who ran it, when, on which domain, and the counts. Never a value.
 *
 * Idempotent and resumable: an interrupted run leaves some envelopes under the
 * new KEK and the rest under the old one, and the next run classifies the first
 * as already done and finishes the rest.
 *
 * WHAT IS NEVER PRINTED, LOGGED, RETURNED OR STORED: a KEK, a data key, a
 * secret value. The report holds counts; the verification decrypts each value
 * into memory to prove it opens, and drops it.
 */

export const REWRAP_DOMAINS = ['platform', 'social', 'customerMfa'] as const;
export type RewrapDomain = (typeof REWRAP_DOMAINS)[number];

export function isRewrapDomain(value: string): value is RewrapDomain {
  return (REWRAP_DOMAINS as readonly string[]).includes(value);
}

/** The audit actions, so a reader of the trail can find every rotation. */
export const REWRAP_AUDIT_ACTIONS = {
  checked: 'secret.kek_rewrap.checked',
  completed: 'secret.kek_rewrap.completed',
  failed: 'secret.kek_rewrap.failed',
} as const;

interface Envelope {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly wrappedDataKey: string;
  readonly keyProvider: string;
  readonly keyId: string;
  readonly encryptionContext: string;
}

interface Rewrapped {
  readonly wrappedDataKey: string;
  readonly keyProvider: string;
  readonly keyId: string;
}

interface Item {
  readonly envelope: Envelope;
  /** Write the new wrapped key if the stored one is still `expected`. */
  write(next: Rewrapped, expected: string): Promise<boolean>;
}

/** Where one key domain keeps its envelopes, read fresh on every call. */
type Store = (prisma: PrismaClient) => Promise<Item[]>;

const ENVELOPE_SELECT = {
  id: true,
  ciphertext: true,
  iv: true,
  authTag: true,
  wrappedDataKey: true,
  keyProvider: true,
  keyId: true,
  encryptionContext: true,
} as const;

/** Platform provider credentials and TOTP seeds: every version, live or retired. */
const platformStore: Store = async (prisma) => {
  const rows = await prisma.secretVersion.findMany({
    select: ENVELOPE_SELECT,
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({
    envelope: row,
    write: async (next, expected) =>
      prisma.$transaction(async (tx) => {
        // The one transaction the secret-material trigger lets change a wrapped key.
        await tx.$executeRaw`SELECT set_config('app.kek_rewrap', 'on', true)`;
        const updated = await tx.secretVersion.updateMany({
          where: { id: row.id, wrappedDataKey: expected },
          data: next,
        });
        return updated.count === 1;
      }),
  }));
};

/** Customers' social OAuth tokens: every credential version, live or retired. */
const socialStore: Store = async (prisma) => {
  const rows = await prisma.socialCredential.findMany({
    select: ENVELOPE_SELECT,
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({
    envelope: row,
    write: async (next, expected) => {
      const updated = await prisma.socialCredential.updateMany({
        where: { id: row.id, wrappedDataKey: expected },
        data: next,
      });
      return updated.count === 1;
    },
  }));
};

const MFA_FIELDS = ['mfaSecretMaterial', 'mfaPendingSecretMaterial'] as const;

function asEnvelope(value: unknown): Envelope | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const keys = [
    'ciphertext',
    'iv',
    'authTag',
    'wrappedDataKey',
    'keyProvider',
    'keyId',
    'encryptionContext',
  ];
  return keys.every((k) => typeof v[k] === 'string') ? (v as unknown as Envelope) : null;
}

/** Customers' own authenticator seeds, live and pending, kept as JSON on the user row. */
const customerMfaStore: Store = async (prisma) => {
  const rows = await prisma.user.findMany({
    where: {
      OR: [
        { mfaSecretMaterial: { not: Prisma.DbNull } },
        { mfaPendingSecretMaterial: { not: Prisma.DbNull } },
      ],
    },
    select: { id: true, mfaSecretMaterial: true, mfaPendingSecretMaterial: true },
    orderBy: { id: 'asc' },
  });
  const items: Item[] = [];
  for (const row of rows) {
    for (const field of MFA_FIELDS) {
      const envelope = asEnvelope(row[field]);
      if (!envelope) continue;
      items.push({
        envelope,
        write: async (next, expected) =>
          prisma.$transaction(async (tx) => {
            const locked = await tx.$queryRaw<{ material: unknown }[]>(
              field === 'mfaSecretMaterial'
                ? Prisma.sql`SELECT "mfaSecretMaterial" AS material FROM "user" WHERE id = ${row.id}::uuid FOR UPDATE`
                : Prisma.sql`SELECT "mfaPendingSecretMaterial" AS material FROM "user" WHERE id = ${row.id}::uuid FOR UPDATE`,
            );
            const current = asEnvelope(locked[0]?.material);
            if (!current || current.wrappedDataKey !== expected) return false;
            await tx.user.update({
              where: { id: row.id },
              data: { [field]: { ...current, ...next } as unknown as Prisma.InputJsonValue },
            });
            return true;
          }),
      });
    }
  }
  return items;
};

const STORES: Record<RewrapDomain, Store> = {
  platform: platformStore,
  social: socialStore,
  customerMfa: customerMfaStore,
};

/** Does this provider open this envelope's data key? Never returns the key. */
async function opens(provider: KeyProvider, envelope: Envelope): Promise<boolean> {
  try {
    const dataKey = await provider.unwrapDataKey(
      {
        wrapped: envelope.wrappedDataKey,
        keyProvider: envelope.keyProvider,
        keyId: envelope.keyId,
      },
      envelope.encryptionContext,
    );
    dataKey.fill(0);
    return true;
  } catch {
    return false;
  }
}

export interface RewrapReport {
  readonly domain: RewrapDomain;
  readonly dryRun: boolean;
  /** Envelopes found. */
  readonly total: number;
  /** Already under the new KEK before this run. */
  readonly alreadyDone: number;
  /** Moved from the old KEK to the new one by this run (a dry run counts what it would move). */
  readonly rewrapped: number;
  /** Under neither KEK, or not verified afterwards. Any failure means: keep the old KEK. */
  readonly failed: number;
  /** Decrypted with the NEW KEK alone after the run. Equals `total` when it is safe to drop the old KEK. */
  readonly verified: number;
  /** True when a failure was found before writing, so nothing was changed. */
  readonly stoppedBeforeWriting: boolean;
}

export interface RewrapOptions {
  /** The PLATFORM database identity: it sees every workspace's envelopes. */
  readonly prisma: PrismaClient;
  readonly domain: RewrapDomain;
  readonly oldKek: KeyProvider;
  readonly newKek: KeyProvider;
  readonly dryRun: boolean;
  /** The active platform user running it, for the audit trail. */
  readonly actorPlatformUserId: string;
  /** TEST SEAM: called after each envelope is re-wrapped (a test throws to simulate a crash). */
  readonly afterEach?: (rewrapped: number) => void | Promise<void>;
}

export async function rewrapKeyDomain(options: RewrapOptions): Promise<RewrapReport> {
  const { prisma, domain, oldKek, newKek, dryRun } = options;
  const store = STORES[domain];

  // 1. Classify, writing nothing.
  const items = await store(prisma);
  const pending: Item[] = [];
  let alreadyDone = 0;
  let failed = 0;
  for (const item of items) {
    if (await opens(newKek, item.envelope)) alreadyDone += 1;
    else if (await opens(oldKek, item.envelope)) pending.push(item);
    else failed += 1;
  }

  const base = { domain, dryRun, total: items.length, alreadyDone };
  if (failed > 0 || dryRun) {
    const report: RewrapReport = {
      ...base,
      rewrapped: failed > 0 ? 0 : pending.length,
      failed,
      verified: failed > 0 ? 0 : alreadyDone,
      stoppedBeforeWriting: failed > 0,
    };
    await audit(options, report);
    return report;
  }

  // 2. Re-wrap, one envelope per transaction, conditional on what was read.
  let rewrapped = 0;
  for (const item of pending) {
    const { envelope } = item;
    const dataKey = await oldKek.unwrapDataKey(
      {
        wrapped: envelope.wrappedDataKey,
        keyProvider: envelope.keyProvider,
        keyId: envelope.keyId,
      },
      envelope.encryptionContext,
    );
    let next: Rewrapped;
    try {
      const wrapped = await newKek.wrapDataKey(dataKey, envelope.encryptionContext);
      next = {
        wrappedDataKey: wrapped.wrapped,
        keyProvider: wrapped.keyProvider,
        keyId: wrapped.keyId,
      };
    } finally {
      dataKey.fill(0);
    }
    // A false here means another run moved it first; verification below decides.
    if (await item.write(next, envelope.wrappedDataKey)) rewrapped += 1;
    await options.afterEach?.(rewrapped);
  }

  // 3. Verify every envelope, read fresh, with the NEW KEK alone.
  const after = await store(prisma);
  let verified = 0;
  let unverified = 0;
  for (const item of after) {
    try {
      // The value is opened only to prove it opens, and is not kept.
      await decryptSecret(item.envelope, newKek);
      verified += 1;
    } catch {
      unverified += 1;
    }
  }

  const report: RewrapReport = {
    ...base,
    total: after.length,
    rewrapped,
    failed: unverified,
    verified,
    stoppedBeforeWriting: false,
  };
  await audit(options, report);
  return report;
}

/** Who, when, which domain, and the counts. Never a key or a value. */
async function audit(options: RewrapOptions, report: RewrapReport): Promise<void> {
  const action = report.dryRun
    ? REWRAP_AUDIT_ACTIONS.checked
    : report.failed > 0
      ? REWRAP_AUDIT_ACTIONS.failed
      : REWRAP_AUDIT_ACTIONS.completed;
  await options.prisma.auditEvent.create({
    data: {
      workspaceId: null,
      actorType: 'PLATFORM_USER',
      actorId: options.actorPlatformUserId,
      action,
      resourceType: 'key_domain',
      severity: report.failed > 0 ? 'CRITICAL' : 'NOTICE',
      outcome: report.failed > 0 ? 'ERROR' : 'SUCCESS',
      reason: report.domain,
      after: { ...report },
    },
  });
}
