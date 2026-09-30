import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PHASE 2B-3, PR 2 — SOURCE GATES.
 *
 * An executor acts on what the EVENT names and the action's own settings, and
 * never on the rule's conditions: a condition is a question about the event,
 * already answered before the action runs. An executor that read
 * `rule.conditions` would be treating a filter as an instruction.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const engine = readFileSync(path.join(root, 'packages/automation/src/engine.ts'), 'utf8');

function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  // The body ends at the first line that closes a class member.
  const end = source.indexOf('\n  }\n', start);
  expect(end, signature).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('no executor reads the rule’s conditions', () => {
  it('#performInternal', () => {
    expect(methodBody(engine, 'async #performInternal(')).not.toMatch(/conditions/);
  });
});
