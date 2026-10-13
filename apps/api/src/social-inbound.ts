import { randomUUID } from 'node:crypto';
import type { Environment } from '@brandspace/config';
import {
  writeAuditEvent,
  type SocialProvider,
  type TenantScopedClient,
} from '@brandspace/database';
import type { PlatformPrismaClient } from '@brandspace/database/platform';
import { createTotalResourceQuota } from '@brandspace/entitlements';
import {
  dataDeletionConfirmationCode,
  inboundDedupeKey,
  metaWebhookSignatureValid,
  parseMetaSignedRequest,
  subjectHash,
  subjectHashCandidates,
  type SubjectHashKey,
} from '@brandspace/social-connectors';

/**
 * CONNECTORS B — WHAT META TELLS US, RECEIVED AND ACTED ON (D-533).
 *
 * TWO HALVES, ON PURPOSE.
 *
 *   RECEIPT (the routes, `receive…`) proves the delivery is Meta's, records it
 *   once in `social_inbound_event` — a redelivery of the same bytes is the same
 *   row — and answers at once. For a deauthorize or data-deletion request it
 *   also works out WHICH connections it is about, while the person's id is in
 *   hand: the id is hashed under every listed key version (D-526) and matched
 *   through the partial index on `providerSubjectHash`, across workspaces, on
 *   the platform connection. The raw id is never written anywhere; the event
 *   keeps the current-version hash and the matched connection ids.
 *
 *   ACTION (the maintenance sweep, `processSocialInboundEvents`) claims a
 *   recorded delivery, acts on each connection INSIDE ITS OWN WORKSPACE (RLS
 *   applies; one workspace's failure does not touch another's) and marks it
 *   done. Every step is idempotent, so a crashed pass is simply run again.
 *
 * WHAT EACH REQUEST DOES (D-505 "data deletion"):
 *
 *   - DEAUTHORIZE ("this person removed your app"): every matched connection is
 *     revoked exactly as a disconnect revokes it — its tokens destroyed, its
 *     plan slot returned, status REVOKED — and audited as the platform's act.
 *   - DATA DELETION: the same, and then the data Meta gave us about the
 *     account is erased: its name and picture, its Page or account id, the
 *     subject hash, and the analytics read from it. THE CUSTOMER'S OWN CONTENT
 *     STAYS — their posts, drafts and media are theirs, not Meta's.
 *   - WEBHOOK: no field is subscribed in step B, so a delivery is recorded and
 *     marked IGNORED. It is kept (for the retention period) as evidence of what
 *     Meta sent.
 */

/** The Meta app's own secrets, resolved by the caller (never logged). */
export interface MetaAppSecrets {
  readonly appSecret: string;
  /** The webhook verify token the owner typed into the Meta app, or null. */
  readonly verifyToken: string | null;
}

export interface SubjectKeys {
  readonly keys: readonly SubjectHashKey[];
  readonly currentVersion: number | null;
}

/** Providers one Meta app serves: a person's grant covers both. */
const META_PROVIDERS: readonly SocialProvider[] = ['FACEBOOK', 'INSTAGRAM'];

/** The largest payload kept; the column refuses more than 64 KiB. */
const MAX_KEPT_PAYLOAD_BYTES = 48 * 1_024;

type JsonObject = { readonly [key: string]: unknown };

export type InboundReceipt =
  | { readonly accepted: false; readonly reason: 'signature' | 'unreadable' | 'not_configured' }
  | { readonly accepted: true; readonly eventId: string; readonly duplicate: boolean };

export type DeletionReceipt =
  | { readonly accepted: false; readonly reason: 'signature' | 'unreadable' | 'not_configured' }
  | { readonly accepted: true; readonly confirmationCode: string; readonly duplicate: boolean };

function isUniqueViolation(error: unknown): boolean {
  // Prisma's unique-constraint code, read structurally (this app does not import Prisma).
  return (
    error !== null && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002'
  );
}

/** A webhook delivery: signature over the raw bytes, then one row. */
export async function receiveMetaWebhook(input: {
  readonly platform: PlatformPrismaClient;
  readonly secrets: MetaAppSecrets;
  readonly raw: Buffer;
  readonly signature: string | undefined;
}): Promise<InboundReceipt> {
  if (!metaWebhookSignatureValid(input.raw, input.signature, input.secrets.appSecret)) {
    return { accepted: false, reason: 'signature' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw.toString('utf8'));
  } catch {
    return { accepted: false, reason: 'unreadable' };
  }
  const payload =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? input.raw.length <= MAX_KEPT_PAYLOAD_BYTES
        ? (parsed as JsonObject)
        : { truncated: true, bytes: input.raw.length }
      : { unexpectedShape: true };
  const dedupeKey = inboundDedupeKey(input.raw);
  return record(input.platform, {
    provider: 'FACEBOOK',
    kind: 'WEBHOOK',
    dedupeKey,
    subjectHash: null,
    payload,
  });
}

async function record(
  platform: PlatformPrismaClient,
  data: {
    provider: SocialProvider;
    kind: 'WEBHOOK' | 'DEAUTHORIZE' | 'DATA_DELETION';
    dedupeKey: string;
    subjectHash: string | null;
    payload: JsonObject;
    occurredAt?: Date | null;
  },
): Promise<InboundReceipt> {
  try {
    const created = await platform.socialInboundEvent.create({
      data: { ...data, payload: data.payload as never, occurredAt: data.occurredAt ?? null },
      select: { id: true },
    });
    return { accepted: true, eventId: created.id, duplicate: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await platform.socialInboundEvent.findUniqueOrThrow({
      where: {
        provider_kind_dedupeKey: {
          provider: data.provider,
          kind: data.kind,
          dedupeKey: data.dedupeKey,
        },
      },
      select: { id: true },
    });
    return { accepted: true, eventId: existing.id, duplicate: true };
  }
}

/**
 * The connections a Meta person's grant reached, found while their id is in
 * hand: every listed key version, both Meta providers, every workspace.
 */
async function connectionsOf(
  platform: PlatformPrismaClient,
  userId: string,
  keys: SubjectKeys,
): Promise<{ workspaceId: string; connectionId: string }[]> {
  const candidates = subjectHashCandidates(userId, keys.keys);
  if (candidates.length === 0) return [];
  const rows = await platform.socialConnection.findMany({
    where: {
      provider: { in: [...META_PROVIDERS] },
      providerSubjectHash: { in: candidates },
    },
    select: { id: true, workspaceId: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => ({ workspaceId: row.workspaceId, connectionId: row.id }));
}

function currentHash(userId: string, keys: SubjectKeys): string | null {
  const key = keys.keys.find((candidate) => candidate.version === keys.currentVersion);
  return key ? subjectHash(userId, key) : null;
}

/** Meta's `signed_request` form field, from a raw form body. */
export function signedRequestFrom(raw: Buffer): string | null {
  const value = new URLSearchParams(raw.toString('utf8')).get('signed_request');
  return value && value.length > 0 ? value : null;
}

/** "This person removed your app." */
export async function receiveMetaDeauthorize(input: {
  readonly platform: PlatformPrismaClient;
  readonly secrets: MetaAppSecrets;
  readonly keys: SubjectKeys;
  readonly signedRequest: string | null;
}): Promise<InboundReceipt> {
  const verified = input.signedRequest
    ? parseMetaSignedRequest(input.signedRequest, input.secrets.appSecret)
    : null;
  if (!verified) return { accepted: false, reason: 'signature' };
  const hash = currentHash(verified.userId, input.keys);
  if (hash === null) return { accepted: false, reason: 'not_configured' };
  const connections = await connectionsOf(input.platform, verified.userId, input.keys);
  return record(input.platform, {
    provider: 'FACEBOOK',
    kind: 'DEAUTHORIZE',
    dedupeKey: inboundDedupeKey(input.signedRequest ?? ''),
    subjectHash: hash,
    payload: { connections },
    occurredAt: verified.issuedAt === null ? null : new Date(verified.issuedAt * 1_000),
  });
}

/**
 * "Delete what you hold about this person." Answers with the code Meta shows
 * the person; the same request redelivered answers the same code.
 */
export async function receiveMetaDataDeletion(input: {
  readonly platform: PlatformPrismaClient;
  readonly secrets: MetaAppSecrets;
  readonly keys: SubjectKeys;
  readonly signedRequest: string | null;
}): Promise<DeletionReceipt> {
  const verified = input.signedRequest
    ? parseMetaSignedRequest(input.signedRequest, input.secrets.appSecret)
    : null;
  if (!verified) return { accepted: false, reason: 'signature' };
  const hash = currentHash(verified.userId, input.keys);
  if (hash === null) return { accepted: false, reason: 'not_configured' };
  const connections = await connectionsOf(input.platform, verified.userId, input.keys);
  const receipt = await record(input.platform, {
    provider: 'FACEBOOK',
    kind: 'DATA_DELETION',
    dedupeKey: inboundDedupeKey(input.signedRequest ?? ''),
    subjectHash: hash,
    payload: { connections },
    occurredAt: verified.issuedAt === null ? null : new Date(verified.issuedAt * 1_000),
  });
  if (!receipt.accepted) return receipt;
  const existing = await input.platform.socialDataDeletionRequest.findUnique({
    where: { inboundEventId: receipt.eventId },
    select: { confirmationCode: true },
  });
  if (existing) {
    return { accepted: true, confirmationCode: existing.confirmationCode, duplicate: true };
  }
  try {
    const created = await input.platform.socialDataDeletionRequest.create({
      data: {
        provider: 'FACEBOOK',
        confirmationCode: dataDeletionConfirmationCode(),
        subjectHash: hash,
        inboundEventId: receipt.eventId,
        connectionsFound: connections.length,
      },
      select: { confirmationCode: true },
    });
    return { accepted: true, confirmationCode: created.confirmationCode, duplicate: false };
  } catch (error) {
    // Two deliveries of the same request racing: the first one's code stands.
    if (!isUniqueViolation(error)) throw error;
    const winner = await input.platform.socialDataDeletionRequest.findUniqueOrThrow({
      where: { inboundEventId: receipt.eventId },
      select: { confirmationCode: true },
    });
    return { accepted: true, confirmationCode: winner.confirmationCode, duplicate: true };
  }
}

/** What the status page may say about a request: its state and dates, nothing else. */
export async function dataDeletionStatus(
  platform: PlatformPrismaClient,
  confirmationCode: string,
): Promise<{ status: string; requestedAt: Date; completedAt: Date | null } | null> {
  if (!/^[A-Za-z0-9]{20,64}$/.test(confirmationCode)) return null;
  return platform.socialDataDeletionRequest.findUnique({
    where: { confirmationCode },
    select: { status: true, requestedAt: true, completedAt: true },
  });
}

// ---------------------------------------------------------------------------
// ACTION — the maintenance sweep
// ---------------------------------------------------------------------------

export interface InboundProcessingOptions {
  readonly platform: PlatformPrismaClient;
  /** Runs one workspace's work in its own tenant transaction (RLS applies). */
  readonly inWorkspace: <T>(
    workspaceId: string,
    fn: (db: TenantScopedClient) => Promise<T>,
  ) => Promise<T>;
  readonly environment: Environment;
  readonly now: Date;
  readonly batchSize: number;
  readonly maxAttempts: number;
  readonly leaseSeconds: number;
}

/** One pass: claim, act, finish. Returns how many deliveries were finished. */
export async function processSocialInboundEvents(
  options: InboundProcessingOptions,
): Promise<number> {
  const { platform, now } = options;
  const staleBefore = new Date(now.getTime() - options.leaseSeconds * 1_000);
  const claimable = {
    OR: [
      { status: 'RECEIVED' as const },
      { status: 'PROCESSING' as const, claimedAt: { lt: staleBefore } },
    ],
  };
  const due = await platform.socialInboundEvent.findMany({
    where: claimable,
    orderBy: { receivedAt: 'asc' },
    take: options.batchSize,
    select: { id: true },
  });
  let finished = 0;
  for (const candidate of due) {
    const token = randomUUID();
    const claimed = await platform.socialInboundEvent.updateMany({
      where: { id: candidate.id, ...claimable },
      data: {
        status: 'PROCESSING',
        claimToken: token,
        claimedAt: now,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) continue;
    const event = await platform.socialInboundEvent.findUniqueOrThrow({
      where: { id: candidate.id },
      include: { deletionRequest: { select: { id: true } } },
    });
    try {
      const outcome = await act(options, event);
      const done = await platform.socialInboundEvent.updateMany({
        where: { id: event.id, claimToken: token },
        data: {
          status: outcome.ignored ? 'IGNORED' : 'PROCESSED',
          claimToken: null,
          claimedAt: null,
          processedAt: now,
          failureCode: outcome.ignored ? 'inbound.no_subscribed_field' : null,
        },
      });
      if (done.count === 1) finished += 1;
    } catch {
      const exhausted = event.attempts >= options.maxAttempts;
      await platform.socialInboundEvent.updateMany({
        where: { id: event.id, claimToken: token },
        data: exhausted
          ? {
              status: 'FAILED',
              claimToken: null,
              claimedAt: null,
              processedAt: now,
              failureCode: 'inbound.processing_failed',
            }
          : { status: 'RECEIVED', claimToken: null, claimedAt: null },
      });
      if (exhausted) finished += 1;
    }
  }
  return finished;
}

function connectionsIn(payload: unknown): { workspaceId: string; connectionId: string }[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const list = (payload as Record<string, unknown>)['connections'];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object') return [];
    const { workspaceId, connectionId } = entry as Record<string, unknown>;
    return typeof workspaceId === 'string' && typeof connectionId === 'string'
      ? [{ workspaceId, connectionId }]
      : [];
  });
}

async function act(
  options: InboundProcessingOptions,
  event: {
    id: string;
    kind: 'WEBHOOK' | 'DEAUTHORIZE' | 'DATA_DELETION';
    payload: unknown;
    deletionRequest: { id: string } | null;
  },
): Promise<{ ignored: boolean }> {
  if (event.kind === 'WEBHOOK') return { ignored: true };
  const erase = event.kind === 'DATA_DELETION';
  const connections = connectionsIn(event.payload);
  if (erase && event.deletionRequest) {
    await options.platform.socialDataDeletionRequest.updateMany({
      where: { id: event.deletionRequest.id, status: 'RECEIVED' },
      data: { status: 'IN_PROGRESS' },
    });
  }
  let erased = 0;
  for (const target of connections) {
    const done = await options.inWorkspace(target.workspaceId, (db) =>
      revokeAtPlatform(db, {
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
        environment: options.environment,
        now: options.now,
        erase,
        eventId: event.id,
      }),
    );
    if (done) erased += 1;
  }
  if (erase && event.deletionRequest) {
    await options.platform.socialDataDeletionRequest.updateMany({
      where: { id: event.deletionRequest.id, status: { not: 'COMPLETED' } },
      data: { status: 'COMPLETED', completedAt: options.now, connectionsDeleted: erased },
    });
  }
  return { ignored: false };
}

/**
 * One connection, inside its own workspace: tokens destroyed, plan slot
 * returned, REVOKED; for a deletion, Meta's data about it erased as well.
 * Idempotent: a second pass finds nothing left to do and changes nothing.
 * Answers whether the connection is (now) in the requested end state.
 */
async function revokeAtPlatform(
  db: TenantScopedClient,
  input: {
    workspaceId: string;
    connectionId: string;
    environment: Environment;
    now: Date;
    erase: boolean;
    eventId: string;
  },
): Promise<boolean> {
  const connection = await db.socialConnection.findFirst({
    where: { id: input.connectionId, workspaceId: input.workspaceId },
  });
  if (!connection) return false;
  await db.socialCredential.deleteMany({
    where: { workspaceId: input.workspaceId, socialConnectionId: connection.id },
  });
  const wasRevoked = connection.status === 'REVOKED';
  if (!wasRevoked) {
    // The same key the disconnect uses: the slot comes back exactly once.
    await createTotalResourceQuota({
      db,
      workspaceId: input.workspaceId,
      environment: input.environment,
      dimension: 'socialAccounts',
    }).refund(`social-account-refund:${connection.id}`);
    await db.socialConnection.update({
      where: { id: connection.id },
      data: {
        status: 'REVOKED',
        revokedAt: input.now,
        disconnectedAt: input.now,
        tokenExpiresAt: null,
        grantedScopes: [],
      },
    });
    await writeAuditEvent(db, input.workspaceId, {
      action: 'social.connection.removed_at_platform',
      actorType: 'SYSTEM',
      resourceType: 'SocialConnection',
      resourceId: connection.id,
      brandId: connection.brandId,
      before: { status: connection.status },
      after: { status: 'REVOKED', inboundEventId: input.eventId },
    });
  }
  if (!input.erase) return true;
  const alreadyErased =
    connection.providerSubjectHash === null &&
    connection.avatarUrl === null &&
    connection.externalAccountId === `erased-${connection.id}`;
  if (alreadyErased) return true;
  await db.metricObservation.deleteMany({
    where: { workspaceId: input.workspaceId, socialConnectionId: connection.id },
  });
  await db.analyticsIngestionCursor.deleteMany({
    where: { workspaceId: input.workspaceId, socialConnectionId: connection.id },
  });
  await db.socialConnection.update({
    where: { id: connection.id },
    data: {
      // The platform's name for it, not the account's: the row stays so the
      // customer's own posts keep their history, but says nothing about the person.
      displayName: connection.provider === 'INSTAGRAM' ? 'Instagram' : 'Facebook',
      avatarUrl: null,
      externalAccountId: `erased-${connection.id}`,
      providerSubjectHash: null,
    },
  });
  await writeAuditEvent(db, input.workspaceId, {
    action: 'social.connection.data_deleted',
    actorType: 'SYSTEM',
    resourceType: 'SocialConnection',
    resourceId: connection.id,
    brandId: connection.brandId,
    after: { inboundEventId: input.eventId },
  });
  return true;
}
