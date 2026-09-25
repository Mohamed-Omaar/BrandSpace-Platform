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
