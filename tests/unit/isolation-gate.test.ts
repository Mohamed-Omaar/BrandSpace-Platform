import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const SCHEMA = path.join(repoRoot, 'packages/database/prisma/schema.prisma');
const REGISTRY = path.join(repoRoot, 'packages/database/src/tenant-models.ts');
const SCHEMA_BACKUP = path.join(repoRoot, 'packages/database/prisma/.schema.gate-test.bak');
const REGISTRY_BACKUP = path.join(repoRoot, 'packages/database/src/.tenant-models.gate-test.bak');

/**
 * The isolation gate is a safety mechanism, and a safety mechanism that has never
 * been observed to fire is not known to work. These tests assert BOTH directions:
 * the gate passes on the real schema, and it fails on each way the schema, the
 * registry and the migrations can drift apart.
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

function patchSchema(extra: string): void {
  copyFileSync(SCHEMA, SCHEMA_BACKUP);
  writeFileSync(SCHEMA, readFileSync(SCHEMA, 'utf8') + extra);
}

function patchRegistry(edit: (source: string) => string): void {
  copyFileSync(REGISTRY, REGISTRY_BACKUP);
  writeFileSync(REGISTRY, edit(readFileSync(REGISTRY, 'utf8')));
}

afterEach(() => {
  for (const [backup, target] of [
    [SCHEMA_BACKUP, SCHEMA],
    [REGISTRY_BACKUP, REGISTRY],
  ] as const) {
    try {
      copyFileSync(backup, target);
      execFileSync('rm', ['-f', backup]);
    } catch {
      // No backup taken means the test never modified that file.
    }
  }
});

describe('isolation gate (D-29)', () => {
  it('passes on the current schema', () => {
    const { code, output } = runGate();
    expect(output).toContain('models have RLS and isolation coverage');
    expect(code).toBe(0);
  });

  it('reports both tenant-owned and platform-owned models', () => {
    const { output } = runGate();
    expect(output).toContain('tenant   Workspace');
    expect(output).toContain('platform SecretVersion');
    expect(output).toContain('platform PlatformUser');
  });

  it('FAILS when a tenant-owned model is added without RLS or coverage', () => {
    patchSchema(`
model GateProbeModel {
  id          String @id @default(uuid()) @db.Uuid
  workspaceId String @db.Uuid
  @@map("gate_probe_model")
}
`);

    const { code, output } = runGate();

    expect(code).toBe(1);
    expect(output).toContain('GateProbeModel');
    expect(output).toContain('is not classified in the tenancy registry');
  });

  it('FAILS when a model is added that nobody classified at all', () => {
    // No workspaceId: under the old gate this silently counted as "not tenant
    // data" and was never checked again. That is exactly how platform_user ended
    // up readable by the tenant role.
    patchSchema(`
model UnclassifiedProbe {
  id    String @id @default(uuid()) @db.Uuid
  value String
  @@map("unclassified_probe")
}
`);

    const { code, output } = runGate();

    expect(code).toBe(1);
    expect(output).toContain('UnclassifiedProbe');
    expect(output).toContain('is not classified in the tenancy registry');
    expect(output).toContain('PLATFORM_OWNED_MODELS');
  });

  it('FAILS when a platform-owned model has no protection against the tenant role', () => {
    patchSchema(`
model PlatformProbe {
  id    String @id @default(uuid()) @db.Uuid
  value String
  @@map("platform_probe")
}
`);
    patchRegistry((s) =>
      s.replace(
        'export const PLATFORM_OWNED_MODELS = [',
        "export const PLATFORM_OWNED_MODELS = [\n  'PlatformProbe',",
      ),
    );

    const { code, output } = runGate();

    expect(code).toBe(1);
    expect(output).toContain('PlatformProbe');
    expect(output).toContain('does not have RLS enabled and forced');
    expect(output).toContain('privileges were never revoked from brandspace_app');
    expect(output).toContain('REVOKE ALL ON "platform_probe" FROM brandspace_app');
  });

  it('FAILS when a tenant-owned model is misclassified as a global catalogue', () => {
    patchSchema(`
model MisclassifiedProbe {
  id          String @id @default(uuid()) @db.Uuid
  workspaceId String @db.Uuid
  @@map("misclassified_probe")
}
`);
    patchRegistry((s) =>
      s.replace(
        'export const GLOBAL_MODELS = [',
        "export const GLOBAL_MODELS = [\n  'MisclassifiedProbe',",
      ),
    );

    const { code, output } = runGate();

    expect(code).toBe(1);
    expect(output).toContain("carries workspaceId but is classified as 'global'");
  });

  it('FAILS when the registry names a model the schema no longer has', () => {
    patchRegistry((s) =>
      s.replace(
        'export const GLOBAL_MODELS = [',
        "export const GLOBAL_MODELS = [\n  'DeletedModel',",
      ),
    );

    const { code, output } = runGate();

    expect(code).toBe(1);
    expect(output).toContain('DeletedModel');
    expect(output).toContain('no such model exists in the schema');
  });

  it('names a concrete remedy for each violation', () => {
    patchSchema(`
model AnotherProbe {
  id          String @id @default(uuid()) @db.Uuid
  workspaceId String @db.Uuid
  @@map("another_probe")
}
`);
    patchRegistry((s) =>
      s.replace(
        'export const STRICT_TENANT_MODELS = [',
        "export const STRICT_TENANT_MODELS = [\n  'AnotherProbe',",
      ),
    );

    const { output } = runGate();
    expect(output).toContain('ALTER TABLE "another_probe" ENABLE ROW LEVEL SECURITY');
    expect(output).toContain('FORCE ROW LEVEL SECURITY');
    expect(output).toContain('CREATE POLICY tenant_isolation ON "another_probe"');
    expect(output).toContain('the isolation suite never exercises it');
  });
});
