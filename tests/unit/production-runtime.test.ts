import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two long-running services must still START after a production install.
 *
 * WHY THIS TEST EXISTS. `apps/api` and `apps/worker` are not compiled to
 * JavaScript before they run — their `start` scripts hand the TypeScript entry
 * point to `tsx`. That makes `tsx` part of the RUNTIME, not part of the
 * toolchain, and it was declared as a devDependency. Every command in this
 * repository installs dev dependencies, so nothing local ever noticed; a
 * production install (`--prod`, `NODE_ENV=production`, `pnpm deploy --prod`,
 * or a platform build that prunes dev dependencies) omits them, and the
 * service exits with "tsx: not found" on its first boot — after the image is
 * built, after the deploy is accepted, at the moment traffic arrives.
 *
 * WHAT IT ASSERTS. That every executable a production `start` command invokes
 * is reachable from the PRODUCTION dependency graph: declared in
 * `dependencies`, absent from `devDependencies`, and recorded as such in the
 * lockfile that the deployment installs from. The manifest and the lockfile are
 * checked separately on purpose — an edit to one without the other is exactly
 * the state a `--frozen-lockfile` install refuses and a human reviewer misses.
 *
 * This is a packaging property, so it is proven by reading the packaging.
 * Booting the services here would prove that THIS checkout runs, which is the
 * thing that was never in doubt.
 */

const ROOT = join(import.meta.dirname, '..', '..');

interface Manifest {
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function manifestOf(app: string): Manifest {
  return JSON.parse(readFileSync(join(ROOT, app, 'package.json'), 'utf8')) as Manifest;
}

/**
 * The lockfile section for one workspace package.
 *
 * Read as text rather than parsed as YAML because the repository has no YAML
 * parser in its dependency tree, and adding one to assert a property of the
 * lockfile would be its own small irony. The shape being matched is pnpm's and
 * is stable: an importer, then `dependencies:`/`devDependencies:` blocks at a
 * fixed indentation.
 */
function lockSection(importer: string): { production: string; development: string } {
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  const start = lock.indexOf(`\n  ${importer}:\n`);
  expect(start, `${importer} is missing from pnpm-lock.yaml`).toBeGreaterThan(-1);
  const rest = lock.slice(start + 1);
  const nextImporter = rest.slice(1).search(/\n {2}\S[^\n]*:\n/);
  const section = nextImporter === -1 ? rest : rest.slice(0, nextImporter + 1);

  const devAt = section.indexOf('\n    devDependencies:');
  return {
    production: devAt === -1 ? section : section.slice(0, devAt),
    development: devAt === -1 ? '' : section.slice(devAt),
  };
}

/** The bare command a script runs, e.g. `tsx src/server.ts` -> `tsx`. */
function executableOf(script: string): string {
  return script.trim().split(/\s+/)[0] ?? '';
}

/**
 * Packages whose RUNTIME imports must not come from a dev dependency.
 *
 * Same failure mode as `tsx`, one level down: `packages/storage` imports the
 * AWS SDK at module scope, so a production install that pruned it would break
 * every upload — and, because the services import `.ts` source directly, it
 * would break them at the first request rather than at install time.
 */
const RUNTIME_PACKAGE_DEPENDENCIES = [
  { importer: 'packages/storage', dependency: '@aws-sdk/client-s3' },
] as const;

const SERVICES = [
  { importer: 'apps/api', entry: 'src/server.ts' },
  { importer: 'apps/worker', entry: 'src/main.ts' },
] as const;

describe('the production start commands resolve without dev dependencies', () => {
  for (const service of SERVICES) {
    describe(service.importer, () => {
      it('starts by handing its TypeScript entry point to a runner', () => {
        const start = manifestOf(service.importer).scripts?.['start'];
        expect(start, 'a deployable service needs a start script').toBeTruthy();
        expect(start).toContain(service.entry);
        /*
         * If this ever becomes `node dist/server.js`, the service is compiled
         * and the rest of this file is obsolete rather than wrong — delete it
         * along with the runtime dependency it protects.
         */
        expect(executableOf(start ?? '')).toBe('tsx');
      });

      it('declares that runner as a runtime dependency, not a dev one', () => {
        const manifest = manifestOf(service.importer);
        const runner = executableOf(manifest.scripts?.['start'] ?? '');

        expect(manifest.dependencies ?? {}).toHaveProperty(runner);
        expect(Object.keys(manifest.devDependencies ?? {})).not.toContain(runner);
      });

      it('records it under dependencies in the lockfile the deployment installs from', () => {
        const manifest = manifestOf(service.importer);
        const runner = executableOf(manifest.scripts?.['start'] ?? '');
        const { production, development } = lockSection(service.importer);

        /*
         * A production install reads the lockfile, not the manifest. The two
         * agreeing is what `--frozen-lockfile` enforces; this asserts the half
         * that actually decides what lands in the deployed node_modules.
         */
        expect(production).toContain(`\n      ${runner}:`);
        expect(development).not.toContain(`\n      ${runner}:`);
      });

      it('needs nothing else from devDependencies to boot', () => {
        /*
         * `typescript` is the only dev dependency these services keep, and it
         * belongs there: `tsx` strips types rather than checking them, so the
         * compiler is a toolchain requirement and never a runtime one. Anything
         * NEW appearing here is a fresh chance to repeat the mistake above, so
         * the list is pinned rather than merely bounded.
         */
        const dev = Object.keys(manifestOf(service.importer).devDependencies ?? {});
        expect(dev.sort()).toEqual(['typescript']);
      });
    });
  }
});

describe('runtime imports come from runtime dependencies', () => {
  for (const entry of RUNTIME_PACKAGE_DEPENDENCIES) {
    it(`${entry.importer} declares ${entry.dependency} as a dependency`, () => {
      const manifest = manifestOf(entry.importer);
      expect(manifest.dependencies ?? {}).toHaveProperty(entry.dependency);
      expect(Object.keys(manifest.devDependencies ?? {})).not.toContain(entry.dependency);

      const { production, development } = lockSection(entry.importer);
      expect(production).toContain(`\n      '${entry.dependency}':`);
      expect(development).not.toContain(`\n      '${entry.dependency}':`);
    });
  }
});
