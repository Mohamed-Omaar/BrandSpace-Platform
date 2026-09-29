import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { verifySocialPostJobKey } from '@brandspace/jobs';
import { publishIdempotencyKey } from '@brandspace/social-connectors';

/**
 * FIX PR 1 · F1 (D-410) — NO QUEUE ID CONTAINS A COLON.
 *
 * BullMQ refuses a custom job id containing `:`, and `enqueue` refuses it
 * first and reports `dispatched: false`. The stale-claim recovery was keyed
 * `verify:<key>`, so it never dispatched once. This suite reads every
 * `enqueue(` call in the apps and packages and fails on any `idempotencyKey`
 * expression that writes a colon, and pins the one dynamic part that is not a
 * uuid or a number — the publish job's own key — to lowercase hex.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Each `enqueue(` / `enqueueReplacingFinished(` call with its `idempotencyKey:` expression. */
function enqueueKeys(): { file: string; key: string }[] {
  const found: { file: string; key: string }[] = [];
  for (const base of ['apps', 'packages']) {
    for (const file of sources(path.join(root, base))) {
      const text = readFileSync(file, 'utf8');
      // `enqueueReplacingFinished` (D-413) dispatches through `enqueue` too.
      const calls = text.split(/\benqueue(?:ReplacingFinished)?\(/).slice(1);
      for (const call of calls) {
        const body = call.slice(0, call.indexOf('});') + 1);
        const match = /idempotencyKey:\s*([^\n]+)/.exec(body);
        if (match?.[1]) found.push({ file: path.relative(root, file), key: match[1].trim() });
      }
    }
  }
  return found;
}

describe('F1 · every queue id is one BullMQ accepts', () => {
  const keys = enqueueKeys();

  it('finds the dispatch sites it is meant to guard', () => {
    // The scheduler alone dispatches seven kinds; a scan that found none would
    // prove nothing.
    expect(keys.length).toBeGreaterThanOrEqual(12);
    expect(keys.some((k) => k.key.includes('verifySocialPostJobKey('))).toBe(true);
  });

  it.each(enqueueKeys().map((k) => [`${k.file}: ${k.key}`, k.key]))(
    'writes no colon: %s',
    (_label, key) => {
      // Template literals and string literals only; `${...}` parts are checked
      // below by what they can produce.
      const literal = String(key).replace(/\$\{[^}]*\}/g, '');
      expect(literal).not.toContain(':');
    },
  );

  it('the publish job key is lowercase hex, so the verification key built from it is colon-free', () => {
    const key = publishIdempotencyKey({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      calendarSlotId: '22222222-2222-4222-8222-222222222222',
      socialConnectionId: '33333333-3333-4333-8333-333333333333',
      contentVariantId: '44444444-4444-4444-8444-444444444444',
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const verify = verifySocialPostJobKey(key, new Date(Date.UTC(2026, 8, 29, 12)));
    expect(verify).not.toContain(':');
    expect(verify).toBe(`verify-${key}-${Date.UTC(2026, 8, 29, 12)}`);
  });

  it('a later stall of the same job gets a different id', () => {
    const key = 'f'.repeat(64);
    expect(verifySocialPostJobKey(key, new Date(1_000))).not.toBe(
      verifySocialPostJobKey(key, new Date(2_000)),
    );
  });

  it('the scheduler builds the verification key through the one helper', () => {
    const scheduler = readFileSync(path.join(root, 'apps/api/src/scheduler.ts'), 'utf8');
    expect(scheduler).toContain(
      'idempotencyKey: verifySocialPostJobKey(job.idempotencyKey, job.claimedAt)',
    );
    expect(scheduler).not.toMatch(/idempotencyKey:\s*`verify:/);
  });
});
