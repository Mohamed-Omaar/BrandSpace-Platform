import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import { BrandKnowledgeService } from '@brandspace/brand-brain';
import {
  appRoleClient,
  createIsolationFixtures,
  migrationRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * PHASE 2B-1 REVIEW, ITEM 5 — THE SETUP ROLLBACK RUNBOOK IS TRUE.
 *
 * `docs/OPERATIONS.md` §6.2 documents the forward corrective migration that
 * must run before a release predating SETUP may serve traffic again. This
 * suite executes THAT EXACT SQL, taken from the document, on the migrator role
 * against the throwaway test database — inside a transaction that is always
 * rolled back — and proves it leaves no SETUP row in either table and puts the
 * append-only trigger back. It also pins that the migration is NOT in the
 * chain and that the enum migration's header no longer overstates rollback.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const MIGRATIONS = 'packages/database/prisma/migrations';

/**
 * The statements of the documented corrective migration, BEGIN/COMMIT removed.
 * Split on `;` at the top level only — a `DO $$ … $$` block keeps its own.
 */
function documentedStatements(): string[] {
  const doc = read('docs/OPERATIONS.md');
  const section = doc.slice(doc.indexOf('### 6.2'));
  const block = /```sql\n([\s\S]*?)```/.exec(section)?.[1] ?? '';
  const sql = block
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  const statements: string[] = [];
  let current = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i += 1) {
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (sql[i] === ';' && !inDollar) {
      statements.push(current.trim());
      current = '';
      continue;
    }
    current += sql[i];
  }
  if (current.trim() !== '') statements.push(current.trim());
  return statements.filter((statement) => statement !== '' && !/^(BEGIN|COMMIT)$/i.test(statement));
}

let app: PrismaClient;
let migrator: PrismaClient;
let fixtures: IsolationFixtures;

beforeAll(async () => {
  app = appRoleClient();
  migrator = migrationRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app?.$disconnect();
  await migrator?.$disconnect();
});

describe('Review item 5 · the runbook and the migration header', () => {
  it('OPERATIONS §6.2 states the order: no old release until the corrective migration has run', () => {
    const doc = read('docs/OPERATIONS.md');
    const section = doc.slice(doc.indexOf('### 6.2'), doc.indexOf('## 7.'));
    expect(section).toContain('PostgreSQL cannot remove an enum value in place');
    expect(section).toMatch(/Only then\*\* may the previous application release serve traffic/);
    expect(section).toContain('deliberately **not**\nadded to the migration chain');
    expect(documentedStatements()).toHaveLength(9);
    // FORCE RLS binds the migrator too: without lifting it the rewrite changes nothing.
    expect(section).toContain('ALTER TABLE "brand_knowledge_item" NO FORCE ROW LEVEL SECURITY;');
    expect(section).toContain('ALTER TABLE "brand_knowledge_item" FORCE ROW LEVEL SECURITY;');
  });

  it('the corrective migration is not in the chain, and nothing else rewrites SETUP', () => {
    for (const dir of readdirSync(path.join(root, MIGRATIONS))) {
      if (!dir.match(/^\d{14}_/)) continue;
      const sql = read(`${MIGRATIONS}/${dir}/migration.sql`);
      expect(sql, dir).not.toMatch(/SET\s+"origin"\s*=\s*'DOCUMENT'/);
      expect(sql, dir).not.toMatch(/DISABLE TRIGGER brand_knowledge_version_append_only/);
    }
  });

  it('the enum migration says a rollback is not compatible and points at the runbook', () => {
    const header = read(`${MIGRATIONS}/20261003090000_setup_origin_and_goal_key/migration.sql`);
    expect(header).toContain(
      'ROLLBACK OF THE APPLICATION IS NOT COMPATIBLE ONCE A SETUP ROW EXISTS',
    );
    expect(header).toContain('docs/OPERATIONS.md §6.2');
    expect(header).not.toMatch(/is the one case the previous release would meet/);
  });
});

describe('Review item 5 · the documented SQL does what the runbook says (always rolled back)', () => {
  it('leaves no SETUP item or version, changes nothing else, and restores the append-only trigger', async () => {
    const itemId = await withWorkspace(
      fixtures.a.workspaceId,
      async (db) => {
        const knowledge = new BrandKnowledgeService({ db, workspaceId: fixtures.a.workspaceId });
        const item = await knowledge.createItem({
          brandId: fixtures.a.brandId,
          area: 'STRATEGY',
          itemKey: `rollback.${Date.now()}`,
          title: { en: 'Setup fact' },
          body: { en: 'Written by setup' },
          actor: { userId: fixtures.a.userId, permissionKeys: [], brandScope: [] },
          policy: { reviewIntervalDays: 90 },
          origin: 'SETUP',
        });
        return item.id;
      },
      { prisma: app },
    );

    const ROLLBACK = new Error('always roll back');
    let observed: {
      items: number;
      versions: number;
      item: unknown;
      trigger: string;
      forced: number;
    } | null = null;
    await expect(
      migrator.$transaction(async (tx) => {
        for (const statement of documentedStatements()) await tx.$executeRawUnsafe(statement);
        // The script's own end state first: FORCE back on both tables, trigger enabled.
        const [force] = await tx.$queryRaw<{ forced: number }[]>`
          SELECT count(*)::int AS forced FROM pg_class
           WHERE oid IN ('"brand_knowledge_item"'::regclass, '"brand_knowledge_version"'::regclass)
             AND relrowsecurity AND relforcerowsecurity`;
        const [trigger] = await tx.$queryRaw<{ tgenabled: string }[]>`
          SELECT tgenabled::text AS tgenabled FROM pg_trigger
           WHERE tgname = 'brand_knowledge_version_append_only'`;
        // Then, TEST-ONLY and rolled back with the rest, lift FORCE so the
        // migrator can see every tenant's rows and count what is left.
        await tx.$executeRawUnsafe(
          'ALTER TABLE "brand_knowledge_item" NO FORCE ROW LEVEL SECURITY',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "brand_knowledge_version" NO FORCE ROW LEVEL SECURITY',
        );
        const [items] = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "brand_knowledge_item" WHERE "origin" = 'SETUP'`;
        const [versions] = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "brand_knowledge_version" WHERE "origin" = 'SETUP'`;
        const [item] = await tx.$queryRaw<{ origin: string; version: number; title: unknown }[]>`
          SELECT "origin"::text AS origin, "version", "title"
            FROM "brand_knowledge_item" WHERE "id" = ${itemId}::uuid`;
        observed = {
          items: Number(items?.n ?? -1),
          versions: Number(versions?.n ?? -1),
          item,
          trigger: trigger?.tgenabled ?? '',
          forced: force?.forced ?? 0,
        };
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);

    expect(observed).toEqual({
      items: 0,
      versions: 0,
      item: { origin: 'DOCUMENT', version: 1, title: { en: 'Setup fact' } },
      // 'O' = enabled (origin): the trigger is back on inside the same transaction.
      trigger: 'O',
      // FORCE row-level security is back on both tables.
      forced: 2,
    });
    // Rolled back: the real row is untouched.
    const after = await app.$transaction(async () =>
      withWorkspace(
        fixtures.a.workspaceId,
        (db) => db.brandKnowledgeItem.findUniqueOrThrow({ where: { id: itemId } }),
        { prisma: app },
      ),
    );
    expect(after.origin).toBe('SETUP');
  });
});
