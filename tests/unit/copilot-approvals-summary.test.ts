import { describe, expect, it } from 'vitest';
import { COPILOT_TOOLS, TOOL_EXECUTORS, availableTools } from '@brandspace/copilot';
import { ROLE_DEFINITIONS } from '@brandspace/shared';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * B14 (Phase 2B-2b) — `approvals.summary`, declared exactly as the owner set it:
 * `content.read`, brand scope required, READ_ONLY, spends no credits, no new
 * permission. The database half is `tests/isolation/copilot-approvals-summary`.
 */
describe('approvals.summary', () => {
  const tool = COPILOT_TOOLS.find((candidate) => candidate.key === 'approvals.summary');

  it('is declared read-only, brand-scoped, on content.read, and spends nothing', () => {
    expect(tool).toMatchObject({
      permission: 'content.read',
      brandScope: 'required',
      actionClass: 'READ_ONLY',
      spendsCredits: false,
      undoable: false,
    });
    expect(tool && 'entitlementKey' in tool).toBe(false);
    expect(TOOL_EXECUTORS['approvals.summary']).toBeTypeOf('function');
  });

  it('takes a brand and nothing else', () => {
    const brandId = '00000000-0000-4000-8000-000000000001';
    expect(tool?.input.parse({ brandId })).toEqual({ brandId });
    expect(() => tool?.input.parse({})).toThrow();
  });

  it('is offered to a member who may read content and use the Copilot — and to no Viewer', () => {
    expect(availableTools(['copilot.use', 'content.read']).map((t) => t.key)).toContain(
      'approvals.summary',
    );
    expect(availableTools(['content.read'])).toHaveLength(0);
    const viewer = ROLE_DEFINITIONS.find((role) => role.key === 'client_viewer');
    expect(availableTools(viewer?.permissionKeys ?? [])).toHaveLength(0);
  });

  it('has its words in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const catalogue = messages[locale] as Record<string, string>;
      expect(catalogue['copilot.tool.approvalsSummary'], locale).toBeTruthy();
      expect(catalogue['copilot.inspection.approvals'], locale).toContain('{pending}');
    }
  });
});
