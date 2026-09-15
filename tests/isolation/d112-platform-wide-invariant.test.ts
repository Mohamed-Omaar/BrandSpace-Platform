import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MODEL_TABLE_NAMES,
  NULLABLE_TENANT_MODELS,
  STRICT_TENANT_MODELS,
} from '@brandspace/database';
import { appRoleClient } from './fixtures';

/**
 * D-112 AS A PLATFORM-WIDE INVARIANT, ENFORCED BY THE CATALOGUE.
 *
 * WHY THIS EXISTS, and why the existing guard was not enough. F-80 shipped a
 * whole-module assertion — "no plain foreign key of this class survives
 * anywhere in Brand Brain" — and it was excellent within its module and scoped
 * to it by `relname LIKE 'brand%'`. D-112 then declared the rule PLATFORM-WIDE.
 * The guard did not follow, and that is precisely how five keys in Phase 3 and
 * Phase 4 survived a rule that already forbade them: nothing was looking
 * outside `brand%`.
 *
 * A SUITE THAT NAMES THE KEYS IT FIXED CANNOT CATCH THE NEXT ONE. So this does
 * not maintain a list. It asks the AUTHORITATIVE tenant-owned model set — the
 * same registry the D-29 gate uses — which tables are tenant-owned, then asks
 * PostgreSQL for every single-column foreign key between two of them. Phase 6
 * adding a `publish_job."contentItemId"` fails here on the day it is written.
 *
 * TWO EXCLUSIONS, BOTH STRUCTURAL AND BOTH DOCUMENTED:
 *
 *   1. A key TO `workspace` is the tenant ANCHOR, not a reference that needs
 *      scoping — `workspaceId` IS the tenant key.
 *   2. `role` has a NULLABLE tenant key, because a system role is shared by
 *      every workspace. A child whose `workspaceId` is NOT NULL can never match
 *      a parent row whose `workspaceId` IS NULL, so the composite key is
 *      impossible BY CONSTRUCTION rather than merely absent. `membership` and
 *      `invitation` are protected by `app.role_reference_is_workspace_scoped()`
 *      instead (D-131), and the test below asserts that trigger is installed —
 *      an exclusion with nothing behind it is just a hole with a comment.
 */

let app: PrismaClient;

beforeAll(() => {
  app = appRoleClient();
});

afterAll(async () => {
  await app?.$disconnect();
});

/** Every tenant-owned table, from the registry the D-29 gate reads. */
function tenantTables(): string[] {
  const models = [...STRICT_TENANT_MODELS, ...NULLABLE_TENANT_MODELS] as readonly string[];
  return models.map((model) => {
    const table = MODEL_TABLE_NAMES[model];
    if (!table) throw new Error(`no table mapping for tenant-owned model ${model}`);
    return table;
  });
}

/** Parents a single-column key may still point at, with the reason. */
const STRUCTURAL_EXCEPTIONS: Record<string, string> = {
  workspace: 'the tenant anchor: workspaceId IS the tenant key',
  role: 'nullable tenant key (system roles are shared); guarded by a trigger, D-131',
};

describe('D-112 holds across every tenant-owned table, not just Brand Brain', () => {
  it('the registry and the database agree on which tables exist', async () => {
    const tables = tenantTables();
    const rows = await app.$queryRawUnsafe<{ relname: string }[]>(
      `SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r'`,
      tables,
    );
    expect(new Set(rows.map((r) => r.relname))).toEqual(new Set(tables));
  });

  it('NO plain single-column foreign key joins two tenant-owned tables', async () => {
    /*
     * THE INVARIANT. Any single-column foreign key whose child AND parent are
     * both tenant-owned is a cross-workspace existence oracle, because
     * PostgreSQL evaluates referential integrity as the table owner with RLS
     * bypassed — the parent row resolves whoever it belongs to.
     */
    const tables = tenantTables();
    const exceptions = Object.keys(STRUCTURAL_EXCEPTIONS);

    const offenders = await app.$queryRawUnsafe<
      { child: string; constraint: string; parent: string }[]
    >(
      `SELECT child.relname   AS child,
              c.conname       AS constraint,
              parent.relname  AS parent
         FROM pg_constraint c
         JOIN pg_class child  ON child.oid  = c.conrelid
         JOIN pg_class parent ON parent.oid = c.confrelid
        WHERE c.contype = 'f'
          AND cardinality(c.conkey) = 1
          AND child.relname  = ANY($1::text[])
          AND parent.relname = ANY($1::text[])
          AND parent.relname <> ALL($2::text[])
        ORDER BY 1, 2`,
      tables,
      exceptions,
    );

    expect(
      offenders.map((o) => `${o.child}.${o.constraint} -> ${o.parent}`),
      'each of these must become composite on workspaceId, or be added to STRUCTURAL_EXCEPTIONS with a reason',
    ).toEqual([]);
  });

  it('every composite tenant key is scoped on workspaceId, not some other pair', async () => {
    /*
     * The complement: a two-column key between tenant-owned tables that does
     * NOT carry `workspaceId` would satisfy the rule above while scoping
     * nothing.
     */
    const tables = tenantTables();
    const rows = await app.$queryRawUnsafe<
      { child: string; constraint: string; columns: string }[]
    >(
      `SELECT child.relname AS child,
              c.conname     AS constraint,
              (SELECT string_agg(att.attname, ',' ORDER BY att.attnum)
                 FROM unnest(c.conkey) AS k(attnum)
                 JOIN pg_attribute att
                   ON att.attrelid = c.conrelid AND att.attnum = k.attnum) AS columns
         FROM pg_constraint c
         JOIN pg_class child  ON child.oid  = c.conrelid
         JOIN pg_class parent ON parent.oid = c.confrelid
        WHERE c.contype = 'f'
          AND cardinality(c.conkey) > 1
          AND child.relname  = ANY($1::text[])
          AND parent.relname = ANY($1::text[])
        ORDER BY 1, 2`,
      tables,
    );

    const unscoped = rows.filter((r) => !r.columns.split(',').includes('workspaceId'));
    expect(
      unscoped.map((r) => `${r.child}.${r.constraint} (${r.columns})`),
      'a composite key between tenant-owned tables must include workspaceId',
    ).toEqual([]);
    // And the rule is not vacuous: there really are composite keys to check.
    expect(rows.length).toBeGreaterThan(5);
  });

  it('the `role` exclusion is backed by the trigger that replaces the key', async () => {
    const rows = await app.$queryRawUnsafe<{ tgname: string }[]>(
      `SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE '%role_is_workspace_scoped'
        ORDER BY tgname`,
    );
    expect(rows.map((r) => r.tgname)).toEqual([
      'invitation_role_is_workspace_scoped',
      'membership_role_is_workspace_scoped',
    ]);
  });
});
