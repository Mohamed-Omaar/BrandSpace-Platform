import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { withWorkspace } from '@brandspace/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * CONNECTORS STEP B — THE TWO PLATFORM-OWNED TABLES AND THE TWO LOOKUP INDEXES,
 * AGAINST REAL POSTGRESQL.
 *
 *   - the tenant role can neither read, count, write nor infer a single row of
 *     `social_inbound_event` or `social_data_deletion_request` — not even
 *     inside a workspace's own context;
 *   - the platform role can, and the database refuses what the application
 *     layer must never write: an unhashed subject, a malformed dedupe key or
 *     confirmation code, a deauthorize with no subject, a claim without its
 *     token, an oversized payload;
 *   - a redelivery of the same body is the same row;
 *   - a deletion request outlives the inbound event it came from;
 *   - the two partial lookup indexes exist and are what the planner uses.
 */

let app: PrismaClient;
let platform: PrismaClient;
let fixtures: IsolationFixtures;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const SUBJECT = `v1:${'b'.repeat(64)}`;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 90_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

async function refusal(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

const event = (overrides: Record<string, unknown> = {}) =>
  platform.socialInboundEvent.create({
    data: {
      provider: 'FACEBOOK',
      kind: 'WEBHOOK',
      dedupeKey: sha(randomUUID()),
      payload: { object: 'page', entries: 1 },
      ...overrides,
    },
  });

describe('connectors B — platform-only: the tenant role reaches nothing', () => {
  it('cannot read, count or write either table, even inside its own workspace', async () => {
    await event();
    for (const table of ['social_inbound_event', 'social_data_deletion_request']) {
      const read = await refusal(() =>
        withWorkspace(
          fixtures.a.workspaceId,
          async (db) => db.$queryRawUnsafe(`SELECT count(*) FROM "${table}"`),
          { prisma: app },
        ),
      );
      expect(read, table).toMatch(/permission denied/i);
      const write = await refusal(() =>
        withWorkspace(
          fixtures.a.workspaceId,
          async (db) => db.$executeRawUnsafe(`DELETE FROM "${table}"`),
          { prisma: app },
        ),
      );
      expect(write, table).toMatch(/permission denied/i);
    }
  });

  it('the database itself says so: RLS forced, no tenant privilege', async () => {
    const rows = await platform.$queryRaw<
      { relname: string; forced: boolean; tenant: boolean }[]
    >`SELECT relname, relrowsecurity AND relforcerowsecurity AS forced,
             has_table_privilege('brandspace_app', 'public.' || relname, 'SELECT, INSERT, UPDATE, DELETE') AS tenant
        FROM pg_class
       WHERE relname IN ('social_inbound_event', 'social_data_deletion_request')
         AND relnamespace = 'public'::regnamespace
       ORDER BY relname`;
    expect(rows).toEqual([
      { relname: 'social_data_deletion_request', forced: true, tenant: false },
      { relname: 'social_inbound_event', forced: true, tenant: false },
    ]);
  });
});

describe('connectors B — what the database refuses', () => {
  it('a malformed dedupe key, an unhashed subject, and a deauthorize with no subject', async () => {
    expect(await refusal(() => event({ dedupeKey: 'not-a-hash' }))).toMatch(/dedupe_key_shape/);
    expect(await refusal(() => event({ kind: 'DEAUTHORIZE', subjectHash: '1234567890' }))).toMatch(
      /subject_hash_shape/,
    );
    expect(await refusal(() => event({ kind: 'DEAUTHORIZE' }))).toMatch(/subject_for_kind/);
    expect(await refusal(() => event({ kind: 'DEAUTHORIZE', subjectHash: SUBJECT }))).toBeNull();
  });

  it('a claim is a token and a time together, and only while PROCESSING', async () => {
    expect(await refusal(() => event({ status: 'PROCESSING' }))).toMatch(/claim_shape/);
    expect(
      await refusal(() =>
        event({ status: 'PROCESSING', claimToken: randomUUID(), claimedAt: new Date() }),
      ),
    ).toBeNull();
    expect(await refusal(() => event({ claimToken: randomUUID(), claimedAt: new Date() }))).toMatch(
      /claim_shape/,
    );
  });

  it('a finished event has its processedAt, and a payload over 64 KiB is refused', async () => {
    expect(await refusal(() => event({ status: 'PROCESSED' }))).toMatch(/processed_at/);
    expect(await refusal(() => event({ status: 'PROCESSED', processedAt: new Date() }))).toBeNull();
    expect(await refusal(() => event({ payload: { blob: randomUUID().repeat(3_000) } }))).toMatch(
      /payload_size/,
    );
  });

  it('a redelivery of the same body is the same row', async () => {
    // One body per run, so the test also passes on a database it has already
    // run against (the row it writes is never removed); within the run the
    // second delivery of the same body is still refused.
    const dedupeKey = sha(`the same raw body ${randomUUID()}`);
    await event({ dedupeKey });
    expect(await refusal(() => event({ dedupeKey }))).toMatch(/Unique constraint|unique/i);
    // The same body for another kind is a different delivery.
    expect(
      await refusal(() => event({ dedupeKey, kind: 'DEAUTHORIZE', subjectHash: SUBJECT })),
    ).toBeNull();
  });
});

describe('connectors B — a deletion request', () => {
  it('refuses a short code or an unhashed subject, and keeps its counts honest', async () => {
    const base = { provider: 'FACEBOOK' as const, subjectHash: SUBJECT };
    expect(
      await refusal(() =>
        platform.socialDataDeletionRequest.create({ data: { ...base, confirmationCode: 'abc' } }),
      ),
    ).toMatch(/code_shape/);
    expect(
      await refusal(() =>
        platform.socialDataDeletionRequest.create({
          data: { ...base, subjectHash: 'raw-user-id', confirmationCode: 'A'.repeat(24) },
        }),
      ),
    ).toMatch(/subject_hash_shape/);
    expect(
      await refusal(() =>
        platform.socialDataDeletionRequest.create({
          data: {
            ...base,
            confirmationCode: 'B'.repeat(24),
            connectionsFound: 1,
            connectionsDeleted: 2,
          },
        }),
      ),
    ).toMatch(/counts/);
    expect(
      await refusal(() =>
        platform.socialDataDeletionRequest.create({
          data: { ...base, confirmationCode: 'C'.repeat(24), status: 'COMPLETED' },
        }),
      ),
    ).toMatch(/completed_at/);
  });

  it('outlives the inbound event it came from', async () => {
    const delivered = await event({ kind: 'DATA_DELETION', subjectHash: SUBJECT });
    const request = await platform.socialDataDeletionRequest.create({
      data: {
        provider: 'FACEBOOK',
        subjectHash: SUBJECT,
        confirmationCode: `D${randomUUID().replace(/-/g, '')}`,
        inboundEventId: delivered.id,
      },
    });
    await platform.socialInboundEvent.delete({ where: { id: delivered.id } });
    const kept = await platform.socialDataDeletionRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(kept.inboundEventId).toBeNull();
    expect(kept.confirmationCode).toBe(request.confirmationCode);
  });
});

describe('connectors B — the two partial lookup indexes', () => {
  it('exist, partial, on the columns approved', async () => {
    const rows = await platform.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
       WHERE indexname IN ('social_connection_provider_subject_hash_idx', 'publish_job_provider_handle_idx')
       ORDER BY indexname`;
    expect(rows.map((row) => row.indexname)).toEqual([
      'publish_job_provider_handle_idx',
      'social_connection_provider_subject_hash_idx',
    ]);
    expect(rows[0]?.indexdef).toMatch(
      /\(provider, "providerHandle"\) WHERE \("providerHandle" IS NOT NULL\)/,
    );
    expect(rows[1]?.indexdef).toMatch(
      /\(provider, "providerSubjectHash"\) WHERE \("providerSubjectHash" IS NOT NULL\)/,
    );
  });

  it('a lookup by subject across workspaces uses its index', async () => {
    const plan = await platform.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      return tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
        `EXPLAIN SELECT id FROM social_connection WHERE provider = 'FACEBOOK' AND "providerSubjectHash" = '${SUBJECT}'`,
      );
    });
    expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(
      'social_connection_provider_subject_hash_idx',
    );
  });
});
