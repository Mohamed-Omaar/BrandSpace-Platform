#!/usr/bin/env tsx
/**
 * Schema-driven tenant-isolation gate — D-29.
 *
 * "CI must fail when a tenant-owned model does not have tenant-isolation coverage."
 *
 * This is what turns the isolation guarantee from a code-review habit into a build
 * failure. It derives the set of tenant-owned models from the Prisma schema itself
 * — a model is tenant-owned if it declares a `workspaceId` field — and then proves
 * four things for every one of them:
 *
 *   1. it is declared in the tenancy registry (packages/database/src/tenant-models.ts)
 *   2. a migration enables AND forces row-level security on its table
 *   3. a migration creates a policy for its table
 *   4. the isolation test suite actually references it
 *
 * Adding a tenant-owned model without tests therefore breaks the build, which is
 * the only way this survives contact with a growing codebase.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const SCHEMA_PATH = path.join(repoRoot, 'packages/database/prisma/schema.prisma');
const MIGRATIONS_DIR = path.join(repoRoot, 'packages/database/prisma/migrations');
const REGISTRY_PATH = path.join(repoRoot, 'packages/database/src/tenant-models.ts');
const ISOLATION_TESTS_DIR = path.join(repoRoot, 'tests/isolation');

interface ParsedModel {
  readonly name: string;
  readonly tableName: string;
  readonly hasWorkspaceId: boolean;
  readonly workspaceIdNullable: boolean;
}

/** Parse model blocks out of the Prisma schema. */
function parseSchema(source: string): ParsedModel[] {
  const models: ParsedModel[] = [];
  const modelBlock = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  let match: RegExpExecArray | null;
  while ((match = modelBlock.exec(source)) !== null) {
    const name = match[1];
    const body = match[2];
    if (!name || !body) continue;

    const workspaceField = /^\s*workspaceId\s+String(\?)?/m.exec(body);
    const mapMatch = /@@map\("([^"]+)"\)/.exec(body);

    models.push({
      name,
      tableName: mapMatch?.[1] ?? name,
      hasWorkspaceId: workspaceField !== null,
      workspaceIdNullable: workspaceField?.[1] === '?',
    });
  }
  return models;
}

/** Concatenate every migration SQL file. */
function readAllMigrationSql(): string {
  let combined = '';
  let entries: string[];
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch {
    return '';
  }
  for (const entry of entries) {
    const full = path.join(MIGRATIONS_DIR, entry);
    if (!statSync(full).isDirectory()) continue;
    const sqlFile = path.join(full, 'migration.sql');
    try {
      combined += readFileSync(sqlFile, 'utf8') + '\n';
    } catch {
      // A migration directory with no SQL file is not this gate's concern.
    }
  }
  return combined;
}

function readIsolationTestSources(): string {
  let combined = '';
  for (const entry of readdirSync(ISOLATION_TESTS_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    combined += readFileSync(path.join(ISOLATION_TESTS_DIR, entry), 'utf8') + '\n';
  }
  return combined;
}

function hasRlsEnabled(sql: string, table: string): boolean {
  return new RegExp(
    `ALTER\\s+TABLE\\s+"?${table}"?\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
    'i',
  ).test(sql);
}

function hasRlsForced(sql: string, table: string): boolean {
  return new RegExp(
    `ALTER\\s+TABLE\\s+"?${table}"?\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
    'i',
  ).test(sql);
}

function hasPolicy(sql: string, table: string): boolean {
  return new RegExp(`CREATE\\s+POLICY\\s+\\w+\\s+ON\\s+"?${table}"?`, 'i').test(sql);
}

function isInRegistry(registry: string, model: string): boolean {
  return new RegExp(`'${model}'`).test(registry);
}

function isCoveredByTests(tests: string, model: string, table: string): boolean {
  // Prisma delegate name: Workspace -> workspace, AuditEvent -> auditEvent
  const delegate = model.charAt(0).toLowerCase() + model.slice(1);
  return (
    new RegExp(`\\bdb\\.${delegate}\\b`).test(tests) ||
    new RegExp(`'${table}'`).test(tests) ||
    new RegExp(`"${table}"`).test(tests)
  );
}

interface Violation {
  readonly model: string;
  readonly table: string;
  readonly problem: string;
  readonly remedy: string;
}

function main(): void {
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  const registry = readFileSync(REGISTRY_PATH, 'utf8');
  const migrations = readAllMigrationSql();
  const tests = readIsolationTestSources();

  const models = parseSchema(schema);
  const tenantOwned = models.filter((m) => m.hasWorkspaceId);
  const violations: Violation[] = [];

  for (const model of tenantOwned) {
    const { name, tableName } = model;

    if (!isInRegistry(registry, name)) {
      violations.push({
        model: name,
        table: tableName,
        problem: 'is tenant-owned but is not declared in the tenancy registry',
        remedy: `Add '${name}' to STRICT_TENANT_MODELS or NULLABLE_TENANT_MODELS in packages/database/src/tenant-models.ts`,
      });
    }

    if (!hasRlsEnabled(migrations, tableName)) {
      violations.push({
        model: name,
        table: tableName,
        problem: 'is tenant-owned but no migration enables row-level security on its table',
        remedy: `Add: ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY;`,
      });
    }

    if (!hasRlsForced(migrations, tableName)) {
      violations.push({
        model: name,
        table: tableName,
        problem: 'has RLS enabled but not FORCED (the table owner would silently bypass it)',
        remedy: `Add: ALTER TABLE "${tableName}" FORCE ROW LEVEL SECURITY;`,
      });
    }

    if (!hasPolicy(migrations, tableName)) {
      violations.push({
        model: name,
        table: tableName,
        problem: 'has RLS enabled but no policy, so it denies everything (or nothing)',
        remedy: `Add: CREATE POLICY tenant_isolation ON "${tableName}" USING (...) WITH CHECK (...);`,
      });
    }

    if (!isCoveredByTests(tests, name, tableName)) {
      violations.push({
        model: name,
        table: tableName,
        problem: 'is tenant-owned but the isolation suite never exercises it',
        remedy:
          `Add assertions for '${name}' in tests/isolation/ — at minimum: cross-tenant read ` +
          `returns null, listing excludes the other tenant, and a cross-tenant write is refused.`,
      });
    }
  }

  // Report ------------------------------------------------------------------
  console.log('BrandSpace tenant-isolation gate (D-29)\n');
  console.log(`  schema      : ${path.relative(repoRoot, SCHEMA_PATH)}`);
  console.log(`  models      : ${models.length} total, ${tenantOwned.length} tenant-owned\n`);

  const width = Math.max(...tenantOwned.map((m) => m.name.length), 12);
  for (const model of tenantOwned) {
    const failed = violations.filter((v) => v.model === model.name);
    const mark = failed.length === 0 ? 'PASS' : 'FAIL';
    const nullable = model.workspaceIdNullable ? ' (nullable tenant key)' : '';
    console.log(`  [${mark}] ${model.name.padEnd(width)}  -> ${model.tableName}${nullable}`);
  }

  if (violations.length > 0) {
    console.error(`\n✖ ${violations.length} isolation-coverage violation(s):\n`);
    for (const v of violations) {
      console.error(`  ${v.model} (${v.table})`);
      console.error(`    problem : ${v.problem}`);
      console.error(`    remedy  : ${v.remedy}\n`);
    }
    console.error(
      'A tenant-owned model without isolation coverage is a data-leak waiting to happen.\n' +
        'See CLAUDE.md §2.1 and docs/SECURITY.md §2.\n',
    );
    process.exit(1);
  }

  console.log(`\n✔ all ${tenantOwned.length} tenant-owned models have RLS and isolation coverage`);
}

main();
