#!/usr/bin/env tsx
/**
 * Schema-driven isolation gate — D-29.
 *
 * "CI must fail when a tenant-owned model does not have tenant-isolation coverage."
 *
 * This is what turns the isolation guarantee from a code-review habit into a build
 * failure. It reads three sources that must agree with each other:
 *
 *   - prisma/schema.prisma          — what models exist, and which carry a tenant key
 *   - packages/database/src/tenant-models.ts — how each model is classified
 *   - prisma/migrations/*.sql       — what the database actually enforces
 *   - tests/isolation/*.ts          — what is actually proven
 *
 * and it enforces:
 *
 *   1. EVERY model is classified in the registry. A model nobody classified is a
 *      build failure, not a silent default — "no workspaceId" means either a
 *      harmless catalogue or the most sensitive table in the database, and only a
 *      human can tell which.
 *   2. The registry agrees with the schema: a model with `workspaceId` is declared
 *      tenant-owned, and a model declared tenant-owned has `workspaceId`.
 *   3. Tenant-owned models: RLS enabled AND forced, a policy exists, and the
 *      isolation suite exercises them.
 *   4. Platform-owned models (Phase 2A): RLS enabled AND forced, a policy scoped
 *      to `brandspace_platform`, every privilege revoked from `brandspace_app`,
 *      and the isolation suite exercises them.
 *
 * Adding a model without protection or tests therefore breaks the build, which is
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

const TENANT_ROLE = 'brandspace_app';
const PLATFORM_ROLE = 'brandspace_platform';

type Classification = 'tenant' | 'platform' | 'identity' | 'global' | 'unclassified';

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

/**
 * Read one `export const NAME = [...] as const;` array out of the registry.
 * Parsed from source rather than imported so the gate stays a plain script with
 * no build step and no import of generated Prisma types.
 */
function readRegistryList(registry: string, constName: string): string[] {
  const block = new RegExp(`export const ${constName}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(registry);
  if (!block?.[1]) {
    throw new Error(
      `${path.relative(repoRoot, REGISTRY_PATH)} no longer exports ${constName}. ` +
        'The isolation gate reads that list; update the gate deliberately, not by deleting it.',
    );
  }
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
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
  for (const entry of entries.sort()) {
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

/** Does every policy on this table name a role, and only the platform role? */
function policiesArePlatformScoped(sql: string, table: string): boolean {
  const statements = [
    ...sql.matchAll(
      new RegExp(`CREATE\\s+POLICY\\s+\\w+\\s+ON\\s+"?${table}"?([\\s\\S]*?);`, 'gi'),
    ),
  ].map((m) => m[1] ?? '');

  if (statements.length === 0) return false;

  return statements.every((body) => {
    const to = /\bTO\s+([a-z_,\s]+?)\s+(?:USING|WITH\s+CHECK)\b/i.exec(body);
    if (!to?.[1]) return false; // no TO clause means the policy applies to PUBLIC
    const roles = to[1]
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    return roles.length > 0 && roles.every((r) => r === PLATFORM_ROLE);
  });
}

function revokesAllFromTenantRole(sql: string, table: string): boolean {
  return new RegExp(`REVOKE\\s+ALL\\s+ON\\s+"?${table}"?\\s+FROM\\s+${TENANT_ROLE}\\b`, 'i').test(
    sql,
  );
}

function isCoveredByTests(tests: string, model: string, table: string): boolean {
  // Prisma delegate name: Workspace -> workspace, AuditEvent -> auditEvent
  const delegate = model.charAt(0).toLowerCase() + model.slice(1);
  return (
    new RegExp(`\\b\\w+\\.${delegate}\\b`).test(tests) ||
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

  const strict = readRegistryList(registry, 'STRICT_TENANT_MODELS');
  const nullable = readRegistryList(registry, 'NULLABLE_TENANT_MODELS');
  const identity = readRegistryList(registry, 'IDENTITY_MODELS_WITH_POLICY');
  const platform = readRegistryList(registry, 'PLATFORM_OWNED_MODELS');
  const global = readRegistryList(registry, 'GLOBAL_MODELS');

  function classify(model: string): Classification {
    if (strict.includes(model) || nullable.includes(model)) return 'tenant';
    if (platform.includes(model)) return 'platform';
    if (identity.includes(model)) return 'identity';
    if (global.includes(model)) return 'global';
    return 'unclassified';
  }

  const models = parseSchema(schema);
  const violations: Violation[] = [];

  const registryPath = path.relative(repoRoot, REGISTRY_PATH);

  for (const model of models) {
    const { name, tableName, hasWorkspaceId } = model;
    const kind = classify(name);

    // (1) Everything must be classified. -------------------------------------
    if (kind === 'unclassified') {
      violations.push({
        model: name,
        table: tableName,
        problem: 'is not classified in the tenancy registry',
        remedy:
          `Add '${name}' to exactly one list in ${registryPath}: ` +
          'STRICT_TENANT_MODELS / NULLABLE_TENANT_MODELS (customer data), ' +
          'PLATFORM_OWNED_MODELS (BrandSpace-owned: admin identity, configuration, secrets), ' +
          'IDENTITY_MODELS_WITH_POLICY, or GLOBAL_MODELS (a catalogue with no ' +
          'customer data and no platform credentials).',
      });
      continue;
    }

    const listedIn = [
      strict.includes(name) || nullable.includes(name),
      platform.includes(name),
      identity.includes(name),
      global.includes(name),
    ].filter(Boolean).length;
    if (listedIn > 1) {
      violations.push({
        model: name,
        table: tableName,
        problem: 'is classified in more than one registry list',
        remedy: `Leave '${name}' in exactly one list in ${registryPath}.`,
      });
    }

    // (2) The registry must agree with the schema. ---------------------------
    if (hasWorkspaceId && kind !== 'tenant') {
      violations.push({
        model: name,
        table: tableName,
        problem: `carries workspaceId but is classified as '${kind}', not tenant-owned`,
        remedy: `Move '${name}' into STRICT_TENANT_MODELS or NULLABLE_TENANT_MODELS in ${registryPath}.`,
      });
    }
    if (!hasWorkspaceId && kind === 'tenant') {
      violations.push({
        model: name,
        table: tableName,
        problem: 'is declared tenant-owned but has no workspaceId field',
        remedy: `Either add a workspaceId to model ${name} in the schema, or reclassify it in ${registryPath}.`,
      });
    }

    // (3) Tenant-owned and identity models: RLS + policy + coverage. ---------
    if (kind === 'tenant' || kind === 'identity') {
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

    // (4) Platform-owned models: no tenant access at all. --------------------
    if (kind === 'platform') {
      if (!hasRlsEnabled(migrations, tableName) || !hasRlsForced(migrations, tableName)) {
        violations.push({
          model: name,
          table: tableName,
          problem: 'is platform-owned but its table does not have RLS enabled and forced',
          remedy:
            `Add: ALTER TABLE "${tableName}" ENABLE ROW LEVEL SECURITY; ` +
            `ALTER TABLE "${tableName}" FORCE ROW LEVEL SECURITY;`,
        });
      }
      if (!policiesArePlatformScoped(migrations, tableName)) {
        violations.push({
          model: name,
          table: tableName,
          problem:
            `is platform-owned but its policies are missing, apply to PUBLIC, or name a role ` +
            `other than ${PLATFORM_ROLE}`,
          remedy:
            `Add: CREATE POLICY platform_only ON "${tableName}" TO ${PLATFORM_ROLE} ` +
            'USING (true) WITH CHECK (true); and remove any policy on this table that has no TO clause.',
        });
      }
      if (!revokesAllFromTenantRole(migrations, tableName)) {
        violations.push({
          model: name,
          table: tableName,
          problem: `is platform-owned but privileges were never revoked from ${TENANT_ROLE}`,
          remedy: `Add: REVOKE ALL ON "${tableName}" FROM ${TENANT_ROLE};`,
        });
      }
      if (!isCoveredByTests(tests, name, tableName)) {
        violations.push({
          model: name,
          table: tableName,
          problem: 'is platform-owned but the isolation suite never exercises it',
          remedy:
            `Add assertions for '${name}' in tests/isolation/ — at minimum: the tenant role is ` +
            'refused with a permission error, and the platform role can read it.',
        });
      }
    }
  }

  // Registry entries that no longer exist in the schema. ---------------------
  const schemaNames = new Set(models.map((m) => m.name));
  for (const [listName, entries] of [
    ['STRICT_TENANT_MODELS', strict],
    ['NULLABLE_TENANT_MODELS', nullable],
    ['IDENTITY_MODELS_WITH_POLICY', identity],
    ['PLATFORM_OWNED_MODELS', platform],
    ['GLOBAL_MODELS', global],
  ] as const) {
    for (const entry of entries) {
      if (!schemaNames.has(entry)) {
        violations.push({
          model: entry,
          table: '-',
          problem: `is listed in ${listName} but no such model exists in the schema`,
          remedy: `Remove '${entry}' from ${listName} in ${registryPath}, or restore the model.`,
        });
      }
    }
  }

  // Report ------------------------------------------------------------------
  const tenantOwned = models.filter((m) => classify(m.name) === 'tenant');
  const platformOwned = models.filter((m) => classify(m.name) === 'platform');

  console.log('BrandSpace isolation gate (D-29)\n');
  console.log(`  schema      : ${path.relative(repoRoot, SCHEMA_PATH)}`);
  console.log(
    `  models      : ${models.length} total, ${tenantOwned.length} tenant-owned, ` +
      `${platformOwned.length} platform-owned\n`,
  );

  const width = Math.max(...models.map((m) => m.name.length), 12);
  for (const model of models) {
    const kind = classify(model.name);
    if (kind === 'global') continue;
    const failed = violations.filter((v) => v.model === model.name);
    const mark = failed.length === 0 ? 'PASS' : 'FAIL';
    const nullable = model.workspaceIdNullable ? ' (nullable tenant key)' : '';
    console.log(
      `  [${mark}] ${kind.padEnd(8)} ${model.name.padEnd(width)}  -> ${model.tableName}${nullable}`,
    );
  }

  if (violations.length > 0) {
    console.error(`\n✖ ${violations.length} isolation-coverage violation(s):\n`);
    for (const v of violations) {
      console.error(`  ${v.model} (${v.table})`);
      console.error(`    problem : ${v.problem}`);
      console.error(`    remedy  : ${v.remedy}\n`);
    }
    console.error(
      'A tenant-owned model without isolation coverage is a data-leak waiting to happen,\n' +
        'and a platform-owned table the tenant role can read is a privilege-escalation path.\n' +
        'See CLAUDE.md §2.1 and docs/SECURITY.md §2.\n',
    );
    process.exit(1);
  }

  console.log(
    `\n✔ all ${tenantOwned.length} tenant-owned and ${platformOwned.length} platform-owned ` +
      'models have RLS and isolation coverage',
  );
}

main();
