import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_ACTIONS } from '@brandspace/automation';

/**
 * PHASE 2B-3 PR 5 — THE GATES FOLLOW THE ACTION.
 *
 * A request is told to, and decided by, holders of its action's ONE permission:
 * the engine hands `permissions.allOf[0]` to the notification port, so an
 * asks-first action with two keys (or an "any of") would tell people who
 * cannot decide it. The confirm route's own gate is the floor every approver
 * holds — `automation.read` — and the engine checks the action's permission.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('asks-first actions', () => {
  const asksFirst = AUTOMATION_ACTIONS.filter((action) => action.asksFirst);

  it('are the publish, the retry and the pause', () => {
    expect(asksFirst.map((action) => action.type).sort()).toEqual([
      'PAUSE_CAMPAIGN',
      'PROPOSE_PUBLISH',
      'RETRY_PUBLISH',
    ]);
  });

  it('each require exactly one permission, all of it, and no "any of"', () => {
    for (const action of asksFirst) {
      expect(action.permissions.allOf, action.type).toHaveLength(1);
      expect(action.permissions.anyOf, action.type).toEqual([]);
    }
  });

  it('a pause is put to campaign managers; a publish or a retry, to publishers', () => {
    const permission = (type: string) =>
      asksFirst.find((action) => action.type === type)?.permissions.allOf[0];
    expect(permission('PAUSE_CAMPAIGN')).toBe('campaigns.manage');
    expect(permission('RETRY_PUBLISH')).toBe('publishing.manage');
    expect(permission('PROPOSE_PUBLISH')).toBe('publishing.manage');
  });
});

describe('the wiring', () => {
  it('the engine names the action’s permission on the request it notifies about', () => {
    expect(source('packages/automation/src/engine.ts')).toMatch(
      /recipientPermission: findAction\(rule\.actionType\)\?\.permissions\.allOf\[0\]/,
    );
  });

  it('the worker resolves recipients by it, publishers only when none is named', () => {
    expect(source('apps/worker/src/processors/automation.ts')).toContain(
      "permissionKey: input.recipientPermission ?? 'publishing.manage'",
    );
  });

  it('the confirm route’s floor is automation.read; the engine decides the rest', () => {
    expect(source('apps/api/src/routes/automation.ts')).toContain(
      "const CONFIRM_PERMISSION = 'automation.read';",
    );
  });
});
