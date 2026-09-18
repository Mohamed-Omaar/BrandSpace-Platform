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

/**
 * The ONLY single-column tenant-parent keys that may exist, named EXACTLY.
 *
 * PARENT-WIDE EXCEPTIONS ARE HOW A GATE ROTS. Excluding "anything pointing at
 * `role`" would let Phase 6 add a brand-new tenant-owned table with its own
 * plain `roleId` and sail straight past a gate whose entire purpose is to catch
 * that. Each exemption is a specific `child.constraint -> parent`, so a NEW
 * relationship to the same parent fails until somebody reviews it and gives it
 * its own protection.
 *
 * `workspace` stays parent-wide, and that one is genuinely structural: a key TO
 * the workspace table is the tenant ANCHOR — `workspaceId` IS the tenant key,
 * so there is nothing left to scope it by.
 */
const EXEMPT_RELATIONSHIPS: Record<string, string> = {
  'membership.membership_roleId_fkey -> role':
    'nullable tenant key (system roles are shared); guarded by app.role_reference_is_workspace_scoped(), D-131',
  'invitation.invitation_roleId_fkey -> role':
    'nullable tenant key (system roles are shared); guarded by app.role_reference_is_workspace_scoped(), D-131',
};

/** The one parent a single-column key may always point at. */
const TENANT_ANCHOR = 'workspace';

/**
 * The one SHAPE a single-column key may always have, whatever it points at.
 *
 * `workspaceId -> workspaceId` IS THE TENANT KEY ON BOTH SIDES, so it is safe
 * for exactly the reason the anchor above is, and the reasoning is worth
 * spelling out because it is the only structural widening this gate has:
 *
 *   The child's `workspaceId` is constrained by RLS to the caller's own
 *   workspace on every write. The key then asks whether a parent row exists
 *   with THAT SAME workspace id. So the only fact it can reveal is one about
 *   the caller's own workspace — "do I have a billing profile yet" — which the
 *   caller may read directly anyway. There is no id here an attacker can vary:
 *   substituting somebody else's workspace id is refused by the policy long
 *   before the key is consulted.
 *
 *   Contrast `membership.roleId -> role`, which is exempted BY NAME above: a
 *   role id is arbitrary and attacker-chosen, so the key really does resolve a
 *   row belonging to somebody else and really is an existence oracle.
 *
 * The distinction is whether the child column is the TENANT KEY or an ordinary
 * reference. Only the former is general; everything else still needs a named,
 * reviewed exemption.
 */
const TENANT_KEY_COLUMN = 'workspaceId';

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

    const found = await app.$queryRawUnsafe<
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
          AND parent.relname <> $2
          -- The tenant key on both sides. See TENANT_KEY_COLUMN above.
          AND NOT (
            (SELECT ca.attname FROM pg_attribute ca
              WHERE ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]) = $3
            AND
            (SELECT pa.attname FROM pg_attribute pa
              WHERE pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]) = $3
          )
        ORDER BY 1, 2`,
      tables,
      TENANT_ANCHOR,
      TENANT_KEY_COLUMN,
    );

    const keyOf = (o: { child: string; constraint: string; parent: string }) =>
      `${o.child}.${o.constraint} -> ${o.parent}`;

    expect(
      found.map(keyOf).filter((key) => !(key in EXEMPT_RELATIONSHIPS)),
      'each of these must become composite on workspaceId, or be named in EXEMPT_RELATIONSHIPS with its own reviewed protection',
    ).toEqual([]);

    // The exemptions must be REAL. A stale entry naming a key that no longer
    // exists would quietly pre-authorise the next relationship that happens to
    // be spelled the same way.
    const present = new Set(found.map(keyOf));
    for (const key of Object.keys(EXEMPT_RELATIONSHIPS)) {
      expect(present.has(key), `${key} is exempted but no longer exists`).toBe(true);
    }
  });

  it('every composite tenant key maps workspaceId TO workspaceId on the parent', async () => {
    /*
     * The complement, and it is not satisfied by column NAMES alone.
     *
     * A two-column key between tenant-owned tables that does not carry
     * `workspaceId` at all would pass the rule above while scoping nothing. But
     * so would a key that lists the child's `workspaceId` and then maps it to
     * some OTHER parent column — `("workspaceId", "brandId") REFERENCES brand
     * ("organisationId", "id")` contains a column called workspaceId and scopes
     * precisely nothing, because the parent row is still reachable from any
     * workspace. Presence is not scoping; the MAPPING is what constrains.
     *
     * So this pairs `conkey` with `confkey` BY ORDINAL — PostgreSQL stores the
     * two arrays positionally, column i of the child maps to column i of the
     * parent — and demands a `workspaceId -> workspaceId` pair.
     */
    const tables = tenantTables();
    const rows = await app.$queryRawUnsafe<
      { child: string; constraint: string; parent: string; mapping: string }[]
    >(
      `SELECT child.relname  AS child,
              c.conname      AS constraint,
              parent.relname AS parent,
              (SELECT string_agg(ca.attname || '->' || pa.attname, ',' ORDER BY k.ord)
                 FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN unnest(c.confkey) WITH ORDINALITY AS f(attnum, ord)
                   ON f.ord = k.ord
                 JOIN pg_attribute ca
                   ON ca.attrelid = c.conrelid  AND ca.attnum = k.attnum
                 JOIN pg_attribute pa
                   ON pa.attrelid = c.confrelid AND pa.attnum = f.attnum) AS mapping
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

    const unscoped = rows.filter((r) => !r.mapping.split(',').includes('workspaceId->workspaceId'));
    expect(
      unscoped.map((r) => `${r.child}.${r.constraint} -> ${r.parent} (${r.mapping})`),
      'a composite key between tenant-owned tables must map the child workspaceId to the PARENT workspaceId',
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
