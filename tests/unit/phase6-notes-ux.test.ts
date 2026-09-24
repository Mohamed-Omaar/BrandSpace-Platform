import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { mentionMatches, mentionQuery } from '../../apps/dashboard/src/components/mention-match';
import { noteThreadHref } from '../../apps/dashboard/src/server/note-links';

/**
 * PHASE 6 FINAL · D-277 §28, D-281 — NOTES THAT READ AS CONVERSATIONS.
 *
 * Real @-mention typeahead, asset conversations, due dates, an Important flag,
 * and deep links that open the exact subject with the thread highlighted.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => readFileSync(path.join(ROOT, relative), 'utf8');
const ID = '0b8a2f5e-4d2c-4c1b-9e0a-2d7f6c5b4a31';
const T = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('D-277 §28 · @-mention typeahead', () => {
  const members = [
    { userId: '1', name: 'Sara Ahmed' },
    { userId: '2', name: 'Samir Khan' },
    { userId: '3', name: 'Mona Sadiq' },
    { userId: '4', name: 'سارة علي' },
  ];

  it('finds the @query the caret is at the end of', () => {
    expect(mentionQuery('Hello @Sa')).toBe('Sa');
    expect(mentionQuery('@')).toBe('');
    expect(mentionQuery('email me@example')).toBeNull();
    expect(mentionQuery('done @Sara ')).toBeNull();
  });

  it('@Sa offers Sara and Samir — and any word starting with it — not everyone', () => {
    expect(mentionMatches(members, 'Sa').map((m) => m.name)).toEqual([
      'Sara Ahmed',
      'Samir Khan',
      'Mona Sadiq',
    ]);
    expect(mentionMatches(members, 'sar').map((m) => m.name)).toEqual(['Sara Ahmed']);
    expect(mentionMatches(members, 'سا').map((m) => m.name)).toEqual(['سارة علي']);
    expect(mentionMatches(members, 'zz')).toEqual([]);
  });

  it('the panel uses it, and keeps the native picker for no-script', () => {
    const panel = read('apps/dashboard/src/components/notes-panel.tsx');
    expect(panel).toMatch(/<MentionField/);
    expect(panel).toMatch(/<noscript>\s*<MentionPicker/);
  });
});

describe('D-281 · deep links open the exact subject, with the thread highlighted', () => {
  const base = { threadId: T, brandId: ID, contentItemId: null, campaignId: null, assetId: null };

  it('a post, a campaign, an asset and a brand', () => {
    expect(noteThreadHref('en', { ...base, subjectType: 'CONTENT_ITEM', contentItemId: ID })).toBe(
      `/en/content/compose?item=${ID}&thread=${T}#thread-${T}`,
    );
    expect(noteThreadHref('ar', { ...base, subjectType: 'CAMPAIGN', campaignId: ID })).toBe(
      `/ar/campaigns/${ID}?thread=${T}#thread-${T}`,
    );
    expect(noteThreadHref('en', { ...base, subjectType: 'ASSET', assetId: ID })).toBe(
      `/en/assets?asset=${ID}&thread=${T}#thread-${T}`,
    );
    expect(noteThreadHref('en', { ...base, subjectType: 'BRAND' })).toBe(
      `/en/brand-brain?brand=${ID}&thread=${T}#thread-${T}`,
    );
  });

  it('Home and the Notes inbox both link through it, and every panel highlights', () => {
    for (const file of [
      'apps/dashboard/src/app/[locale]/overview/page.tsx',
      'apps/dashboard/src/app/[locale]/notes/page.tsx',
    ]) {
      expect(read(file)).toMatch(/noteThreadHref\(locale, entry\)/);
    }
    for (const file of [
      'apps/dashboard/src/app/[locale]/content/compose/page.tsx',
      'apps/dashboard/src/app/[locale]/campaigns/[campaignId]/page.tsx',
      'apps/dashboard/src/app/[locale]/brand-brain/page.tsx',
      'apps/dashboard/src/app/[locale]/assets/page.tsx',
    ]) {
      expect(read(file), file).toMatch(/highlightThreadId=/);
    }
    expect(read('apps/dashboard/src/components/notes-panel.tsx')).toMatch(
      /id=\{`thread-\$\{threadId\}`\}/,
    );
  });

  it('a "changes requested" verdict opens the post in the composer, where its note is', () => {
    expect(read('apps/dashboard/src/server/approvals-context.ts')).toMatch(
      /linkPath: `\/content\/compose\?item=\$\{event\.itemId\}`/,
    );
  });
});

describe('D-281 · the data model', () => {
  const migration = read(
    'packages/database/prisma/migrations/20260924130000_phase_6_notes_asset_due_importance/migration.sql',
  );

  it('an asset subject is exactly-one, composite-keyed and brand-checked by a trigger', () => {
    expect(migration).toMatch(/"subjectType"::text = 'ASSET' AND "assetId" IS NOT NULL/);
    expect(migration).toMatch(/FOREIGN KEY \("workspaceId", "assetId"\) REFERENCES "asset"/);
    expect(migration).toMatch(/CREATE TRIGGER note_thread_asset_scope/);
    // Runs as the caller, so RLS applies to the trigger's own lookup.
    expect(migration).toMatch(/\$\$ LANGUAGE plpgsql;/);
    expect(migration).not.toMatch(/plpgsql\s+SECURITY DEFINER/);
  });

  it('importance is two values, nothing finer; due is an optional date', () => {
    expect(migration).toMatch(/CREATE TYPE "NoteImportance" AS ENUM \('NORMAL', 'IMPORTANT'\)/);
    expect(migration).toMatch(/ADD COLUMN "dueAt" TIMESTAMPTZ\(6\);/);
  });

  it('every new label exists in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      for (const key of [
        'notes.important',
        'notes.due',
        'notes.overdue',
        'notes.waitingOn',
        'notes.markImportant',
        'notes.markNormal',
        'notesInbox.subject.ASSET',
        'home.notes.open.ASSET',
        'activity.action.customer.note.due_set',
        'activity.action.customer.note.importance_set',
      ]) {
        expect(dictionary[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });
});
