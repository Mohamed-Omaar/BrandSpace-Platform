import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { READ_ONLY_CONTENT_STATUSES } from '../../packages/content/src/library';

/**
 * Prototype v76 alignment, Phase 1 (docs/PROTOTYPE-V76-ALIGNMENT.md §1) — the
 * screen halves of the bug fixes. The server halves are proven against
 * PostgreSQL in tests/isolation; these pin that the screen offers exactly what
 * the server will accept, in both languages.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const both = (key: string) => {
  const en = (messages.en as Record<string, string>)[key];
  const ar = (messages.ar as Record<string, string>)[key];
  expect(en, `en:${key}`).toBeTruthy();
  expect(ar, `ar:${key}`).toBeTruthy();
  expect(ar).not.toBe(en);
};

describe('B-2 · a published post opens read-only, with Duplicate', () => {
  const page = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');
  const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');

  it('treats publishing and published as read-only, and nothing else', () => {
    expect([...READ_ONLY_CONTENT_STATUSES].sort()).toEqual([
      'PARTIALLY_PUBLISHED',
      'PUBLISHED',
      'PUBLISHING',
    ]);
  });

  it('switches editing, uploading and media generation off for such a post', () => {
    expect(page).toContain('readOnly: READ_ONLY_CONTENT_STATUSES.includes(draft.status)');
    expect(page).toMatch(
      /edit: workspace\.permissionKeys\.includes\('content\.edit'\) && !composerDraft\?\.readOnly/,
    );
    expect(page).toMatch(
      /uploadMedia:\s*workspace\.permissionKeys\.includes\('assets\.upload'\) && !composerDraft\?\.readOnly/,
    );
    expect(page).toMatch(/generateMedia:[\s\S]*?!composerDraft\?\.readOnly/);
  });

  it('says why and offers Duplicate to a member who may create posts', () => {
    expect(editor).toContain('data-testid="editor-published-readonly"');
    expect(editor).toMatch(/can\.create && actions\.duplicate \?/);
    expect(editor).toContain('data-testid="editor-duplicate"');
    expect(page).toContain('duplicate: duplicateContentAction');
    both('editor.published.readOnly');
    both('content.action.duplicate');
  });
});

describe('B-3 · the composer warns before an edit withdraws a review', () => {
  const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
  const page = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');

  it('shows the warning on a post in review, to a member who may edit', () => {
    expect(editor).toMatch(/draft\.status === 'IN_REVIEW' && can\.edit \?/);
    expect(editor).toContain('data-testid="editor-in-review-warning"');
    expect(page).toContain("'editor.inReviewWarning',");
    both('editor.inReviewWarning');
  });

  it('the reviewers are told in both languages', () => {
    both('notifications.template.approval.withdrawn_after_edit');
  });
});

describe('B-4 · the calendar only offers to move a plan that can move', () => {
  const view = read('apps/dashboard/src/app/[locale]/calendar/calendar-view.tsx');
  const page = read('apps/dashboard/src/app/[locale]/calendar/page.tsx');

  it('marks each slot and hides the reschedule form for the rest', () => {
    expect(page).toContain('reschedulable: RESCHEDULABLE_SLOT_STATUSES.includes(view.slot.status)');
    expect(view).toContain('canSchedule && openSlot.reschedulable !== false ? (');
  });
});

describe('B-5 · the team screen offers no change to your own authority', () => {
  const page = read('apps/dashboard/src/app/[locale]/members/page.tsx');

  it('hides role and brand-access controls on the reader’s own row, desktop and phone', () => {
    expect(page).toContain('const isSelf = (member: { userId: string }) =>');
    expect(
      page.match(/may\('member\.assign_role'\) && !isSelf\(m\) && assignableRoles/g),
    ).toHaveLength(2);
    expect(page.match(/!isSelf\(m\) &&\s*!m\.isWorkspaceOwner/g)).toHaveLength(2);
  });
});

describe('B-6 · the library offers Schedule only to members who may schedule', () => {
  const library = read('apps/dashboard/src/app/[locale]/content/content-library.tsx');
  const page = read('apps/dashboard/src/app/[locale]/content/page.tsx');
  const calendarActions = read('apps/dashboard/src/app/[locale]/calendar/actions.ts');

  it('gates the link on the same permission the calendar enforces', () => {
    expect(library).toMatch(
      /can\.schedule && \(card\.status === 'APPROVED' \|\| card\.status === 'DRAFT'\) \?/,
    );
    expect(page).toContain("schedule: may('content.schedule')");
    // The server half the link leads to, so the two cannot drift apart.
    expect(calendarActions).toContain("requireWorkspace(locale, 'content.schedule')");
  });
});

describe('B-7 · Restore is offered with the permission the server asks for', () => {
  const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
  const actions = read('apps/dashboard/src/app/[locale]/content/actions.ts');

  it('gates Restore on can.archive, and hands the service the real permissions', () => {
    expect(editor).toContain("can.archive && draft.status === 'ARCHIVED' ? (");
    expect(editor).not.toContain("can.submit && draft.status === 'ARCHIVED'");
    expect(actions).toContain('actorPermissionKeys: session.workspace.permissionKeys');
  });
});

describe('B-9 · disconnecting an account takes two deliberate steps', () => {
  const view = read('apps/dashboard/src/app/[locale]/integrations/integrations-view.tsx');
  const actions = read('apps/dashboard/src/app/[locale]/integrations/actions.ts');

  it('the first click only opens the explanation; the second, separate button submits', () => {
    const block = view.slice(view.indexOf('{mayManage ? (\n                    <details'));
    expect(block).toContain('<summary');
    expect(block).toContain('data-testid={`disconnect-${row.id}`}');
    // The submit lives INSIDE the disclosure, after the explanation.
    const summaryEnd = block.indexOf('</summary>');
    const form = block.indexOf('<form action={actions.disconnect}');
    expect(form).toBeGreaterThan(summaryEnd);
    expect(block.indexOf("t('integrations.disconnectConfirmBody')")).toBeGreaterThan(form);
    expect(block).toContain('name="intent" value="DISCONNECT"');
    expect(block).toContain('data-testid={`disconnect-confirm-${row.id}`}');
    expect(block).toContain("buttonStyle('danger')");
  });

  it('the server refuses a disconnect that did not come through the confirmation', () => {
    const action = actions.slice(actions.indexOf('export async function disconnectAccountAction'));
    const guard = action.indexOf("formData.get('intent') !== 'DISCONNECT'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(action.indexOf('callSocialApi('));
  });

  it('says what disconnecting does, in both languages', () => {
    both('integrations.disconnectConfirmBody');
    both('integrations.disconnectConfirmSubmit');
  });
});
