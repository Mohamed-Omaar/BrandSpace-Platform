import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pickIncoming, type IncomingNotice } from '../../packages/ui/src/toast-bus';

/**
 * MO10 (Phase 2B-2b, owner option A, D-352) — incoming mentions, as rules. The
 * database half is `tests/isolation/notes-incoming-mentions.test.ts`; the
 * browser half is `tests/e2e/prototype-v90-phase2b2b-shell.spec.ts`.
 */

const read = (file: string) => readFileSync(file, 'utf8');
const notice = (id: string): IncomingNotice => ({
  id,
  initial: 'S',
  title: 'Sam mentioned you',
  context: 'Spring post',
  href: '/en/notes',
});

describe('once per mention per browser tab', () => {
  it('shows the newest mention this tab has not announced', () => {
    expect(pickIncoming([notice('b'), notice('a')], [])?.id).toBe('b');
    expect(pickIncoming([notice('b'), notice('a')], ['b'])?.id).toBe('a');
    expect(pickIncoming([notice('b'), notice('a')], ['a', 'b'])).toBeNull();
    expect(pickIncoming([], [])).toBeNull();
  });

  it('the tab remembers in sessionStorage, and shows nothing when it cannot', () => {
    const host = read('packages/ui/src/toast-host.tsx');
    const slot = host.slice(
      host.indexOf('function IncomingSlot'),
      host.indexOf('export function ToastHost'),
    );
    expect(slot).toContain('window.sessionStorage.getItem(INCOMING_SEEN_KEY)');
    expect(slot.match(/\} catch \{\s*return;\s*\}/g)).toHaveLength(2);
    // Above any toast, moving as a toast does.
    expect(host.indexOf('<IncomingSlot')).toBeLessThan(host.lastIndexOf('{shown ? ('));
    expect(slot).toContain('className="bs-toast-in"');
    expect(slot).toContain('usePresence(notice !== null, boxRef, toastExit)');
  });
});

describe('the sender is the mentioning note’s author, never yourself', () => {
  const notes = read('packages/collaboration/src/notes.ts');

  it('self-mentions are left out of the count, the inbox and the incoming list', () => {
    const count = notes.slice(
      notes.indexOf('async unreadMentionCount'),
      notes.indexOf('async inbox('),
    );
    expect(count).toContain('authorUserId: { not: actor.userId }');
    expect(notes).toContain(
      'const byOthers = thread.notes.filter((note) => note.authorUserId !== me);',
    );
    const incoming = notes.slice(
      notes.indexOf('async incomingMentions'),
      notes.indexOf('/** Mark this person'),
    );
    expect(incoming).toContain('authorUserId: { not: actor.userId }');
    expect(incoming).toContain('readAt: null');
    expect(incoming).toContain('...brandIdScopeFilter(actor.brandScope)');
    expect(incoming).not.toMatch(/\.(update|create|delete|upsert)(Many)?\(/);
  });

  it('the bell’s "who" and excerpt come from the note that mentioned you', () => {
    const feed = read('apps/dashboard/src/app/[locale]/notifications/feed.ts');
    expect(feed).toContain('entry.lastMention.authorUserId');
    expect(feed).toContain('excerpt: mention.body.slice(0, EXCERPT)');
    expect(feed).not.toContain('entry.lastNote.authorUserId');
  });

  it('no new delivery path: the shell reads the domain on the next page render', () => {
    const server = read('apps/dashboard/src/server/incoming-mentions.ts');
    expect(server).toContain('.incomingMentions({');
    expect(server).not.toMatch(/setInterval|EventSource|WebSocket|notificationService/);
    expect(read('apps/dashboard/src/components/workspace-shell.tsx')).toContain(
      'incoming={await incomingMentions(locale)}',
    );
  });

  it('its words exist in both languages', async () => {
    const { messages } = await import('../../apps/dashboard/src/i18n/messages');
    for (const locale of ['en', 'ar'] as const) {
      const catalogue = messages[locale] as Record<string, string>;
      expect(catalogue['notifications.incoming.open'], locale).toBeTruthy();
      expect(catalogue['notifications.feed.mentioned'], locale).toContain('{name}');
    }
  });
});
