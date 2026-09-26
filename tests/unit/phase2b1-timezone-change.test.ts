import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { categoryOf } from '@brandspace/notifications';
import { optionalMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * G5 / Q22 (prototype v94 Phase 2B-1, D-334) — a time-zone change keeps every
 * planned post at its local time, from Settings AND from the Control Center.
 * The behaviour against PostgreSQL is `tests/isolation/phase2b1-timezone-change.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('G5 / Q22 · one rule, both ways in', () => {
  it('Settings → General hands a new zone to WorkspaceTimezoneService, in its transaction', () => {
    const rules = read('apps/dashboard/src/server/general-settings.ts');
    expect(rules).toMatch(
      /if \(before\.timezone !== input\.timezone && context\.changeTimezone\) \{\s*await context\.changeTimezone\(input\.timezone\);/,
    );
    const action = read('apps/dashboard/src/app/[locale]/settings/actions.ts');
    expect(action).toContain('await new WorkspaceTimezoneService({');
    expect(action).toContain("actor: { type: 'USER', id: session.customer.userId }");
  });

  it('the Control Center’s workspace edit uses the same service, inside the update’s transaction', () => {
    const admin = read('apps/admin/src/server/platform-context.ts');
    expect(admin).toMatch(
      /timezoneChange: async \(tx, input\) => \{[\s\S]*new WorkspaceTimezoneService\(/,
    );
    expect(admin).toContain("actor: { type: 'PLATFORM_USER', id: input.actorId }");
    const service = read('packages/auth/src/workspaces.ts');
    expect(service).toMatch(
      /await this\.#prisma\.\$transaction\(async \(tx\) => \{[\s\S]*await this\.#timezoneChange\(tx/,
    );
  });

  it('the warning before saving is asked of the server, behind workspace.update', () => {
    const route = read('apps/dashboard/src/app/api/settings/timezone-preview/route.ts');
    expect(route).toContain("await resolveApiWorkspace('workspace.update')");
    expect(route).toContain('timezoneChangeEffects(db, {');
    const fields = read('apps/dashboard/src/app/[locale]/settings/general-fields.tsx');
    expect(fields).toContain('/api/settings/timezone-preview?zone=');
    expect(fields).toContain('data-testid="settings-timezone-unplanned"');
  });

  it('a post sent back to planned tells its author, in a category they can mute', () => {
    expect(categoryOf('calendar.unplanned_by_timezone_change')).toBe('publishing');
    for (const key of [
      'notifications.template.calendar.unplanned_by_timezone_change',
      'settings.timezoneKept',
      'settings.timezoneUnplanned',
    ]) {
      expect(optionalMessage('en', key), key).toBeTruthy();
      expect(optionalMessage('ar', key), key).toMatch(/[؀-ۿ]/);
    }
  });

  it('a PLANNED post given a new time is scheduled again through the same rules', () => {
    const calendar = read('packages/content/src/calendar.ts');
    expect(calendar).toContain(
      "if (slot.status === 'PLANNED') return this.#replan(slot, input, instant);",
    );
    const replan = calendar.slice(calendar.indexOf('async #replan('));
    for (const rule of [
      'approvalRequiredBeforeScheduling()',
      'SCHEDULABLE_FROM.includes(item.status)',
      'this.#assertChannelsReachable(',
      'this.#quota.consume(usageIdempotencyKey)',
    ]) {
      expect(replan, rule).toContain(rule);
    }
  });
});
