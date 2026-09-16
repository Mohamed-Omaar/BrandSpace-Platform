import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * D-132 AS A MACHINE-ENFORCED RULE, NOT A HAND-KEPT LIST.
 *
 * BrandScope decides which of a tenant's OWN brands a member may act on. RLS
 * cannot express it — every row involved is legitimately the tenant's — so it
 * is enforced in the services, and D-132 says WHERE: in the query predicate.
 *
 * THE DEFECT THIS CATCHES, in the exact form it kept coming back in:
 *
 *     const item = await db.contentItem.findUnique({ where: { id } });
 *     if (!item) throw notFound();
 *     assertBrandInScope(actor.brandScope, item.brandId);   // <- too late
 *
 * The row has already been read on behalf of somebody not entitled to it. It
 * also LEAKS: measured on this codebase, the post-read form answered a real
 * out-of-scope content id with `NOT_FOUND: Brand not found` and a fabricated
 * one with `NOT_FOUND: Content not found.` — two different messages, which is
 * exactly the distinction CLAUDE.md §2.1 forbids. A member restricted to one
 * brand could enumerate which ids were real.
 *
 * Three separate review rounds found this pattern in code the previous round
 * had just corrected, each time somewhere new. A list of the sites fixed would
 * have caught none of them, so this asks the SOURCE instead.
 *
 * THE RULE. The brand handed to an assertion must be one the CALLER supplied —
 * `input.brandId`, or a `brandId` parameter — never a property read off a row
 * the service just fetched. A row-derived brand means the read happened first,
 * and that read is what belongs in the `where` via `brandIdQueryFilter` (or
 * `assetBrandScopeFilter`, which additionally keeps the workspace-level
 * NULL-brand rule).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packagesDir = path.resolve(here, '../../packages');

const ASSERTIONS = ['assertBrandInScope', 'assertAssetBrandInScope'] as const;

/** `X.brandId` where X is anything other than the caller's own input. */
const ROW_DERIVED =
  /\b(?:assertBrandInScope|assertAssetBrandInScope)\s*\(\s*[^,()]+,\s*([A-Za-z_$][\w$]*)\.([\w$]+)/g;

/** The only receiver a brand may legitimately be read from at a call site. */
const CALLER_SUPPLIED = new Set(['input']);

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') continue;
    let isDirectory: boolean;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      // Vanished between the listing and the stat. See `read()` below.
      continue;
    }
    if (isDirectory) sourceFiles(full, found);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

/**
 * Read a file, tolerating one that is no longer there.
 *
 * A SOURCE SCANNER MUST NOT FAIL BECAUSE A FILE WAS REMOVED MID-SCAN, and in
 * this repository that is not hypothetical: the module-boundary suite writes a
 * probe file into `packages/` and deletes it again to prove its own rule
 * catches a violation. Running alongside it, this gate listed the probe and
 * then tried to read a path that had already gone — a failure that says nothing
 * about the rule it is checking and everything about two tests sharing a
 * directory.
 *
 * Skipping a vanished file cannot hide a violation: a file that does not exist
 * contains no code.
 */
function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

describe('BrandScope is a query predicate everywhere (D-132)', () => {
  const files = sourceFiles(packagesDir);

  it('finds the services it is supposed to be checking', () => {
    // A gate that silently matches nothing passes for ever. This asserts the
    // scan really does reach the code that uses these assertions.
    const users = files.filter((file) => {
      const text = read(file);
      return text !== null && ASSERTIONS.some((name) => text.includes(`${name}(`));
    });
    expect(users.length).toBeGreaterThan(4);
  });

  it('no brand assertion takes its brand from a row that was just read', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = read(file);
      if (text === null) continue;
      for (const match of text.matchAll(ROW_DERIVED)) {
        const [whole, receiver, property] = match;
        if (receiver === undefined || property === undefined) continue;
        if (CALLER_SUPPLIED.has(receiver)) continue;
        // The helper's own definition names its parameter, not a row.
        if (whole.includes('actor.brandScope, brandId')) continue;
        const line = text.slice(0, match.index).split('\n').length;
        offenders.push(`${path.relative(packagesDir, file)}:${line} — ${receiver}.${property}`);
      }
    }

    expect(
      offenders,
      'a brand read off a fetched row means the row was fetched first; ' +
        'put the scope in the WHERE with brandIdQueryFilter / assetBrandScopeFilter',
    ).toEqual([]);
  });
});
