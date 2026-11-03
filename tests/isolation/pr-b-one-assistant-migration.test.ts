import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dropThrowawayDatabase } from './fixtures';

/**
 * PR B — THE ONE-ASSISTANT MIGRATION, AS AN UPGRADE OF REAL-SHAPED DATA.
 *
 * A throwaway database is migrated to the step BEFORE `20261103120000`, seeded
 * with Copilot sessions and Brand Brain conversations in two workspaces, for
 * several people, brands (and no brand), with colliding idempotency keys and
 * plan versions, and one conversation with no starter. The migration is
 * applied, the result is checked to the row, and it is applied AGAIN to prove
 * a second run changes nothing. The database is dropped afterwards.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const migrationsDir = path.join(repoRoot, 'packages', 'database', 'prisma', 'migrations');
const MIGRATION = '20261103120000_one_assistant';

function urlFor(role: 'migrator' | 'platform', database: string): string {
  const source =
    role === 'migrator'
      ? process.env['DATABASE_MIGRATION_URL']
      : process.env['DATABASE_PLATFORM_URL'];
  if (!source) throw new Error(`the ${role} connection URL is required for this suite`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  url.search = '';
  return url.toString();
}

function applyMigration(url: string, name: string): void {
  execFileSync(
    'psql',
    [
      '-v',
      'ON_ERROR_STOP=1',
      '--quiet',
      '--no-psqlrc',
      '-f',
      path.join(migrationsDir, name, 'migration.sql'),
      url,
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString();

describe('PR B migration: one Copilot conversation per person per brand', () => {
  const database = `pb_upgrade_${randomUUID().slice(0, 8)}`;
  let admin: Client;
  let platform: Client;
  const ws = { a: randomUUID(), b: randomUUID() };
  const user = { u1: randomUUID(), u2: randomUUID(), u3: randomUUID() };
  const brand = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID() };
  const id = {
    s1: randomUUID(), // u1 · A1 · Copilot, the earliest: canonical
    s2: randomUUID(), // u1 · A1 · Copilot, later: merged into s1
    sn1: randomUUID(), // u1 · no brand · canonical
    sn2: randomUUID(), // u1 · no brand · merged (NULLS NOT DISTINCT)
    s3: randomUUID(), // u2 · A1 · alone
    s4: randomUUID(), // u3 · B1 · Copilot, canonical for the B1 conversation too
    c1: randomUUID(), // u1 · A1 · Brand Brain → into s1
    c2: randomUUID(), // u1 · A1 · Brand Brain → into s1
    c3: randomUUID(), // u1 · A2 · Brand Brain only → a NEW session with id c3
    c4: randomUUID(), // u3 · B1 · Brand Brain → into s4
    c5: randomUUID(), // A2 · no starter → not merged
    p1: randomUUID(),
    p2: randomUUID(),
  };

  async function snapshot() {
    const q = async (sql: string) => (await platform.query(sql)).rows;
    return {
      sessions: await q(
        `SELECT "id","workspaceId","userId","brandId","lastMessageAt","archivedAt","expiresAt" FROM "copilot_session" ORDER BY "id"`,
      ),
      messages: await q(
        `SELECT "id","sessionId","role","body","idempotencyKey","kind","status","citations","insufficientKnowledge","createdAt"
         FROM "copilot_message" ORDER BY "id"`,
      ),
      plans: await q(
        `SELECT "id","sessionId","planVersion","idempotencyKey" FROM "copilot_action_plan" ORDER BY "id"`,
      ),
      toolCalls: await q(`SELECT "id","sessionId" FROM "copilot_tool_call" ORDER BY "id"`),
    };
  }

  beforeAll(async () => {
    admin = await connect(urlFor('migrator', 'postgres'));
    await admin.query(`CREATE DATABASE "${database}"`);
    const migratorUrl = urlFor('migrator', database);
    const names = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      if (name >= MIGRATION) break;
      applyMigration(migratorUrl, name);
    }
    platform = await connect(urlFor('platform', database));
    const run = (sql: string, values: unknown[] = []) => platform.query(sql, values);

    for (const [key, uid] of Object.entries(user)) {
      await run(
        `INSERT INTO "user" ("id","email","timezone","updatedAt") VALUES ($1,$2,'UTC',now())`,
        [uid, `${key}-${database}@example.local`],
      );
    }
    for (const [key, wid] of Object.entries(ws)) {
      await run(
        `INSERT INTO "workspace" ("id","workspaceId","slug","name","ownerUserId","country","currency","defaultLocale","timezone","updatedAt")
         VALUES ($1,$1,$2,$3,$4,'SA','SAR','EN','UTC',now())`,
        [wid, `pb-${key}-${database}`, `Workspace ${key}`, key === 'a' ? user.u1 : user.u3],
      );
    }
    const brandOf: [string, string][] = [
      [brand.a1, ws.a],
      [brand.a2, ws.a],
      [brand.b1, ws.b],
    ];
    for (const [bid, wid] of brandOf) {
      await run(
        `INSERT INTO "brand" ("id","workspaceId","slug","name","updatedAt") VALUES ($1,$2,$3,$3,now())`,
        [bid, wid, `brand-${bid.slice(0, 8)}`],
      );
    }

    const session = (sid: string, wid: string, uid: string, bid: string | null, minute: number) =>
      run(
        `INSERT INTO "copilot_session" ("id","workspaceId","userId","brandId","createdAt","updatedAt","lastMessageAt")
         VALUES ($1,$2,$3,$4,$5,now(),$5)`,
        [sid, wid, uid, bid, at(minute)],
      );
    await session(id.s1, ws.a, user.u1, brand.a1, 1);
    await session(id.s2, ws.a, user.u1, brand.a1, 5);
    await session(id.sn1, ws.a, user.u1, null, 2);
    await session(id.sn2, ws.a, user.u1, null, 6);
    await session(id.s3, ws.a, user.u2, brand.a1, 3);
    await session(id.s4, ws.b, user.u3, brand.b1, 4);

    const turn = (
      sid: string,
      wid: string,
      role: string,
      body: string,
      minute: number,
      key: string | null,
    ) =>
      run(
        `INSERT INTO "copilot_message" ("id","workspaceId","sessionId","role","body","correlationId","createdAt","idempotencyKey")
         VALUES ($1,$2,$3,$4::"CopilotMessageRole",$5,$6,$7,$8)`,
        [randomUUID(), wid, sid, role, body, randomUUID(), at(minute), key],
      );
    // The SAME idempotency key in s1 and s2: they must not collide once merged.
    await turn(id.s1, ws.a, 'USER', 's1 question', 10, 'k1');
    await turn(id.s1, ws.a, 'ASSISTANT', 's1 answer', 11, null);
    await turn(id.s2, ws.a, 'USER', 's2 question', 20, 'k1');
    await turn(id.s2, ws.a, 'ASSISTANT', 's2 answer', 21, null);
    await turn(id.sn1, ws.a, 'USER', 'general one', 12, 'g1');
    await turn(id.sn2, ws.a, 'USER', 'general two', 22, 'g1');
    await turn(id.s3, ws.a, 'USER', 'u2 question', 13, null);
    await turn(id.s4, ws.b, 'USER', 'u3 copilot', 14, 'b-k');

    // A plan with planVersion 1 in BOTH s1 and s2, each with a tool call; the
    // one in s2 is CONFIRMED, which `copilot_plan_frozen_once_confirmed` makes
    // immutable — the migration must leave it exactly where it is.
    for (const [pid, sid, minute, confirmed] of [
      [id.p1, id.s1, 15, false],
      [id.p2, id.s2, 25, true],
    ] as const) {
      await run(
        `INSERT INTO "copilot_action_plan" ("id","workspaceId","sessionId","userId","planHash","summary","steps","correlationId","createdAt","updatedAt","planVersion","idempotencyKey","confirmedAt","confirmedByUserId","confirmationTokenHash")
         VALUES ($1,$2,$3,$4,'h','{}','[]',$5,$6,now(),1,'plan-k',$7,$8,$9)`,
        [
          pid,
          ws.a,
          sid,
          user.u1,
          randomUUID(),
          at(minute),
          confirmed ? at(minute + 1) : null,
          confirmed ? user.u1 : null,
          confirmed ? `hash-${pid}` : null,
        ],
      );
      await run(
        `INSERT INTO "copilot_tool_call" ("id","workspaceId","planId","sessionId","ordinal","toolKey","actionClass","idempotencyKey","updatedAt")
         VALUES ($1,$2,$3,$4,1,'approvals.summary','READ_ONLY',$5,now())`,
        [randomUUID(), ws.a, pid, sid, `tc-${pid}`],
      );
    }

    const conversation = (
      cid: string,
      wid: string,
      bid: string,
      uid: string | null,
      minute: number,
    ) =>
      run(
        `INSERT INTO "brand_brain_conversation" ("id","workspaceId","brandId","startedByUserId","createdAt","lastMessageAt")
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [cid, wid, bid, uid, at(minute)],
      );
    await conversation(id.c1, ws.a, brand.a1, user.u1, 7);
    await conversation(id.c2, ws.a, brand.a1, user.u1, 8);
    await conversation(id.c3, ws.a, brand.a2, user.u1, 9);
    await conversation(id.c4, ws.b, brand.b1, user.u3, 9);
    await conversation(id.c5, ws.a, brand.a2, null, 9);
    const said = (
      cid: string,
      wid: string,
      bid: string,
      role: string,
      body: string | null,
      minute: number,
      key: string | null,
      extra: { purged?: boolean; insufficient?: boolean } = {},
    ) =>
      run(
        `INSERT INTO "brand_brain_message" ("id","workspaceId","brandId","conversationId","role","body","bodyPurgedAt","citations","insufficientKnowledge","createdAt","idempotencyKey")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(),
          wid,
          bid,
          cid,
          role,
          body,
          extra.purged ? at(59) : null,
          role === 'user' ? null : JSON.stringify([{ itemId: 'x', area: 'TONE_OF_VOICE' }]),
          extra.insufficient ?? false,
          at(minute),
          key,
        ],
      );
    // c1 and c2 share a key: it must not collide in s1 either.
    await said(id.c1, ws.a, brand.a1, 'user', 'bb one', 16, 'bk');
    await said(id.c1, ws.a, brand.a1, 'assistant', 'bb one answer', 17, null);
    await said(id.c2, ws.a, brand.a1, 'user', 'bb two', 23, 'bk');
    await said(id.c2, ws.a, brand.a1, 'ASSISTANT', null, 24, null, {
      purged: true,
      insufficient: true,
    });
    await said(id.c3, ws.a, brand.a2, 'user', 'a2 only', 18, null);
    await said(id.c4, ws.b, brand.b1, 'user', 'b1 brand question', 19, null);
    await said(id.c5, ws.a, brand.a2, 'user', 'orphan', 30, null);

    // Applied once, as `prisma migrate deploy` would.
    applyMigration(migratorUrl, MIGRATION);
  }, 300_000);

  afterAll(async () => {
    await platform?.end();
    if (admin) {
      await dropThrowawayDatabase(admin, database);
      await admin.end();
    }
  });

  it('leaves exactly one ACTIVE session per (workspace, person, brand); the others archived', async () => {
    const { sessions } = await snapshot();
    const key = (s: { workspaceId: string; userId: string; brandId: string | null }) =>
      `${s.workspaceId}|${s.userId}|${s.brandId ?? '-'}`;
    const active = sessions.filter((s) => s.archivedAt === null);
    expect(active.map((s) => s.id).sort()).toEqual([id.s1, id.sn1, id.s3, id.s4, id.c3].sort());
    expect(new Set(active.map(key)).size).toBe(active.length);
    // The continuous conversation has no session expiry; messages keep theirs.
    expect(active.every((s) => s.expiresAt === null)).toBe(true);
    // Merged-away sessions are archived, not deleted: their plans stay whole.
    const archived = sessions.filter((s) => s.archivedAt !== null).map((s) => s.id);
    expect(archived.sort()).toEqual([id.s2, id.sn2].sort());
    const created = sessions.find((s) => s.id === id.c3);
    expect(created).toMatchObject({ workspaceId: ws.a, userId: user.u1, brandId: brand.a2 });
  });

  it('merges every turn into its person and brand, in time order, nothing lost', async () => {
    const { messages } = await snapshot();
    const bodies = (sid: string) =>
      messages
        .filter((m) => m.sessionId === sid)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map((m) => m.body);
    expect(bodies(id.s1)).toEqual([
      's1 question',
      's1 answer',
      'bb one',
      'bb one answer',
      's2 question',
      's2 answer',
      'bb two',
      null,
    ]);
    expect(bodies(id.sn1)).toEqual(['general one', 'general two']);
    expect(bodies(id.s3)).toEqual(['u2 question']);
    expect(bodies(id.s4)).toEqual(['u3 copilot', 'b1 brand question']);
    expect(bodies(id.c3)).toEqual(['a2 only']);
    // The conversation with no starter has no owner and is not merged.
    expect(messages.some((m) => m.body === 'orphan')).toBe(false);
    // Grounding, purge state and kind carried over.
    const purged = messages.find((m) => m.sessionId === id.s1 && m.body === null);
    expect(purged).toMatchObject({
      role: 'ASSISTANT',
      insufficientKnowledge: true,
      kind: 'message',
      status: 'complete',
    });
    expect(messages.every((m) => m.kind === 'message' && m.status === 'complete')).toBe(true);
  });

  it('keeps every idempotency key unique, and confirmed plans untouched where they were made', async () => {
    const { messages, plans, toolCalls } = await snapshot();
    const keys = messages
      .filter((m) => m.sessionId === id.s1 && m.idempotencyKey)
      .map((m) => m.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('k1');
    expect(keys).toContain(`m:${id.s2}:k1`);
    expect(keys).toContain(`bb:${id.c1}:bk`);
    expect(keys).toContain(`bb:${id.c2}:bk`);
    // `copilot_plan_frozen_once_confirmed` forbids re-versioning a confirmed
    // plan, so plans and their tool calls stay on their own (archived) session.
    expect(plans.map((p) => [p.id, p.sessionId, p.planVersion, p.idempotencyKey])).toEqual(
      expect.arrayContaining([
        [id.p1, id.s1, 1, 'plan-k'],
        [id.p2, id.s2, 1, 'plan-k'],
      ]),
    );
    expect(toolCalls.map((t) => t.sessionId).sort()).toEqual([id.s1, id.s2].sort());
  });

  it('enforces one active session per person and brand from now on, a brand-less one included', async () => {
    await expect(
      platform.query(
        `INSERT INTO "copilot_session" ("id","workspaceId","userId","brandId","updatedAt") VALUES ($1,$2,$3,$4,now())`,
        [randomUUID(), ws.a, user.u1, brand.a1],
      ),
    ).rejects.toThrow(/copilot_session_one_per_person_brand/);
    await expect(
      platform.query(
        `INSERT INTO "copilot_session" ("id","workspaceId","userId","brandId","updatedAt") VALUES ($1,$2,$3,NULL,now())`,
        [randomUUID(), ws.a, user.u1],
      ),
    ).rejects.toThrow(/copilot_session_one_per_person_brand/);
  });

  it('a "New topic" divider is a topic_break message with no body: written and read back', async () => {
    const divider = randomUUID();
    await platform.query(
      `INSERT INTO "copilot_message" ("id","workspaceId","sessionId","role","body","kind","correlationId","createdAt")
       VALUES ($1,$2,$3,'USER',NULL,'topic_break',$4,$5)`,
      [divider, ws.a, id.s1, randomUUID(), at(58)],
    );
    const { rows } = await platform.query(
      `SELECT "kind","body","status","sessionId" FROM "copilot_message" WHERE "id" = $1`,
      [divider],
    );
    expect(rows).toEqual([
      { kind: 'topic_break', body: null, status: 'complete', sessionId: id.s1 },
    ]);
    // A divider carries no words, and only the two kinds exist.
    await expect(
      platform.query(
        `INSERT INTO "copilot_message" ("id","workspaceId","sessionId","role","body","kind","correlationId")
         VALUES ($1,$2,$3,'USER','words','topic_break',$4)`,
        [randomUUID(), ws.a, id.s1, randomUUID()],
      ),
    ).rejects.toThrow(/copilot_message_topic_break_is_empty/);
    await expect(
      platform.query(
        `INSERT INTO "copilot_message" ("id","workspaceId","sessionId","role","body","kind","correlationId")
         VALUES ($1,$2,$3,'USER',NULL,'other',$4)`,
        [randomUUID(), ws.a, id.s1, randomUUID()],
      ),
    ).rejects.toThrow(/copilot_message_kind_check/);
    // Removed again, so the idempotence snapshot below compares migration output only.
    await platform.query(`DELETE FROM "copilot_message" WHERE "id" = $1`, [divider]);
  });

  it('restores FORCE ROW LEVEL SECURITY on every table it lifted', async () => {
    const { rows } = await platform.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE relname IN ('copilot_session','copilot_message','brand_brain_conversation','brand_brain_message')`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.relforcerowsecurity === true)).toBe(true);
  });

  it('running it a second time changes nothing', async () => {
    const before = await snapshot();
    applyMigration(urlFor('migrator', database), MIGRATION);
    const after = await snapshot();
    expect(after).toEqual(before);
    // The counts, printed for the report.
    console.log(
      `PR B migration: sessions ${after.sessions.length}, messages ${after.messages.length}, plans ${after.plans.length}, tool calls ${after.toolCalls.length} (seeded: 6 sessions + 5 conversations, 8 + 7 messages)`,
    );
  });
});
