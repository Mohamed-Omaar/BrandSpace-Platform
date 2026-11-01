import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * LAUNCH CHECK-UP 2026-10-28, C-1 AND H-1.
 *
 * The three Next apps ran 16.3.4 (unauthenticated RCE in the image optimiser,
 * GHSA-2464-fhr4-w9xw, fixed in 16.4.1) and the api ran Fastify 5.12.1
 * (authentication bypass via malformed URLs, GHSA-p68q-wchp-6fh7, and a DoS
 * fixed in 5.12.5). These tests keep the floor from sliding back, and keep the
 * image optimiser off: no screen renders through `next/image`, so
 * `/_next/image` is an unauthenticated endpoint that serves nobody.
 */

const root = path.join(__dirname, '../..');

function pinned(pkg: string, dep: string): string {
  const json = JSON.parse(readFileSync(path.join(root, pkg, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const version = json.dependencies?.[dep] ?? json.devDependencies?.[dep];
  if (!version) throw new Error(`${pkg} does not depend on ${dep}`);
  return version;
}

function atLeast(version: string, floor: [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`expected an exact version, got "${version}"`);
  const parts = match.slice(1).map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (parts[i]! !== floor[i]) return parts[i]! > floor[i]!;
  }
  return true;
}

describe('launch dependency floor (C-1, H-1)', () => {
  it.each(['apps/admin', 'apps/dashboard', 'apps/web', 'packages/ui'])(
    '%s pins next at or above 16.4.1',
    (pkg) => {
      expect(atLeast(pinned(pkg, 'next'), [16, 4, 1])).toBe(true);
    },
  );

  it('apps/api pins fastify at or above 5.12.5', () => {
    expect(atLeast(pinned('apps/api', 'fastify'), [5, 12, 5])).toBe(true);
  });

  it.each(['admin', 'dashboard', 'web'])('apps/%s turns the image optimiser off', async (app) => {
    const url = pathToFileURL(path.join(root, 'apps', app, 'next.config.mjs')).href;
    const config = (await import(url)) as { default: { images?: { unoptimized?: boolean } } };
    expect(config.default.images?.unoptimized).toBe(true);
  });
});
