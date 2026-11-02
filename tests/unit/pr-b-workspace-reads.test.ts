import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COPILOT_TOOLS, WORKSPACE_READ_KEYS, availableTools } from '@brandspace/copilot';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PR B (D-591) — THE COPILOT'S WORKSPACE READS.
 *
 * Team, credits, plan, channels and notifications are answered from tools that
 * ask the SAME permission as their screens. A member without one is refused in
 * that screen's words (`copilotDenials`, E6), so the dashboard's list of those
 * permissions is held equal to the registry's here.
 */
const read = (path: string) => readFileSync(path, 'utf8');

describe('PR B — workspace reads', () => {
  const reads = COPILOT_TOOLS.filter((tool) => WORKSPACE_READ_KEYS.has(tool.key));

  it('five reads, each READ_ONLY, naming no brand and spending nothing', () => {
    expect(reads.map((tool) => tool.key).sort()).toEqual([
      'channels.list',
      'credits.balance',
      'notifications.recent',
      'plan.summary',
      'team.list',
    ]);
    for (const tool of reads) {
      expect(tool, tool.key).toMatchObject({
        actionClass: 'READ_ONLY',
        brandScope: 'none',
        spendsCredits: false,
      });
    }
  });

  it('each asks the permission its screen asks', () => {
    expect(Object.fromEntries(reads.map((tool) => [tool.key, tool.permission]))).toEqual({
      'team.list': 'member.read',
      'credits.balance': 'credits.read',
      'plan.summary': 'billing.read',
      'channels.list': 'integrations.read',
      'notifications.recent': 'workspace.read',
    });
  });

  it('the dashboard words a refusal for exactly those permissions', () => {
    const source = read('apps/dashboard/src/server/copilot-denials.ts');
    for (const tool of reads) expect(source).toContain(`'${tool.permission}'`);
    expect(source).toContain('denialText(locale, { permissionKey, memberName, ownerName }).body');
  });

  it('a member without billing.read is not offered the plan read', () => {
    const keys = availableTools(['copilot.use', 'member.read', 'credits.read'], {
      brandBound: true,
    }).map((tool) => tool.key);
    expect(keys).toContain('team.list');
    expect(keys).toContain('credits.balance');
    expect(keys).not.toContain('plan.summary');
    // Without the Copilot, nothing at all.
    expect(availableTools(['member.read', 'billing.read'])).toEqual([]);
  });

  it('a general (brandless) conversation can still read the workspace', () => {
    const keys = availableTools(['copilot.use', 'member.read'], { brandBound: false }).map(
      (tool) => tool.key,
    );
    expect(keys).toEqual(['team.list']);
  });

  it('the refusal, the tool names, the sources and the lines exist in en and ar', () => {
    for (const locale of ['en', 'ar'] as const) {
      const words = messages[locale] as Record<string, string>;
      for (const tool of reads)
        expect(words[`copilot.tool.${tool.messageKey}`], tool.key).toBeTruthy();
      for (const key of [
        'copilot.notice.permissionDenied',
        'copilot.source.team',
        'copilot.source.credit_ledger',
        'copilot.source.subscription',
        'copilot.source.channels',
        'copilot.source.notifications',
        'copilot.inspection.sourcePeriod',
        'copilot.inspection.sourceAsOf',
      ]) {
        expect(words[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });

  it('the conversation shows the screen’s refusal, and every read with its source', () => {
    const view = read('apps/dashboard/src/app/[locale]/copilot/copilot-view.tsx');
    expect(view).toContain("result.notice === 'permission_denied'");
    expect(view).toContain('.map((key) => denials[key])');
    expect(view).toContain("t('copilot.inspection.sourcePeriod', '')");
    const route = read('apps/api/src/routes/copilot.ts');
    expect(route).toContain('deniedPermissions: result.turn.deniedToolKeys.flatMap');
  });

  it('the fake provider proposes the read the question asks for, as a model would', () => {
    const mock = read('packages/ai-gateway/src/adapters/mock.ts');
    expect(mock).toContain("{ key: 'credits.balance', words:");
    expect(mock).toContain("{ key: 'team.list', words:");
    expect(mock).toContain('MAY NOT USE');
  });
});
