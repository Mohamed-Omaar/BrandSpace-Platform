import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const SCHEMA = path.join(repoRoot, 'packages/database/prisma/schema.prisma');
const BACKUP = path.join(repoRoot, 'packages/database/prisma/.schema.gate-test.bak');

/**
 * The isolation gate is a safety mechanism, and a safety mechanism that has never
 * been observed to fire is not known to work. These tests assert BOTH directions:
 * the gate passes on the real schema, and it fails on a schema that adds a
 * tenant-owned model with no RLS and no coverage.
 */

function runGate(): { code: number; output: string } {
  try {
    const output = execFileSync('pnpm', ['tsx', 'scripts/isolation-gate.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

afterEach(() => {
  try {
    copyFileSync(BACKUP, SCHEMA);
    execFileSync('rm', ['-f', BACKUP]);
  } catch {
    // No backup taken means the test never modified the schema.
  }
});

describe('tenant-isolation gate (D-29)', () => {
  it('passes on the current schema', () => {
    const { code, output } = runGate();
    expect(output).toContain('tenant-owned models have RLS and isolation coverage');
    expect(code).toBe(0);
  });

  it('FAILS when a tenant-owned model is added without RLS or coverage', () => {
    copyFileSync(SCHEMA, BACKUP);
    const original = readFileSync(SCHEMA, 'utf8');
    writeFileSync(
      SCHEMA,
      original +
        `
model GateProbeModel {
  id          String @id @default(uuid()) @db.Uuid
  workspaceId String @db.Uuid
  @@map("gate_probe_model")
}
`,
    );

    const { code, output } = runGate();

    expect(code).toBe(1);
    expect(output).toContain('GateProbeModel');
    expect(output).toContain('not declared in the tenancy registry');
    expect(output).toContain('no migration enables row-level security');
    expect(output).toContain('the isolation suite never exercises it');
  });

  it('names a concrete remedy for each violation', () => {
    copyFileSync(SCHEMA, BACKUP);
    const original = readFileSync(SCHEMA, 'utf8');
    writeFileSync(
      SCHEMA,
      original +
        `
model AnotherProbe {
  id          String @id @default(uuid()) @db.Uuid
  workspaceId String @db.Uuid
  @@map("another_probe")
}
`,
    );

    const { output } = runGate();
    expect(output).toContain('ALTER TABLE "another_probe" ENABLE ROW LEVEL SECURITY');
    expect(output).toContain('FORCE ROW LEVEL SECURITY');
    expect(output).toContain('CREATE POLICY tenant_isolation ON "another_probe"');
  });
});
