import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  dragHintShown,
  slotMovable,
} from '../../apps/dashboard/src/app/[locale]/calendar/slot-moves';

/**
 * B-PRE REVIEW (step B items 1–3) — A HELD POST ON THE CALENDAR.
 *
 * One rule decides whether a plan can move: scheduling offered at all (Q8),
 * the plan not started (B-4), and the plan not HELD (D-531). The drag, the
 * drop, the chip and the drawer's Date/Time/Move all ask it; the footer's
 * "drag any post to another day" line asks whether dragging is offered at all.
 * The calendar names only channels the `content` document configures.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('a plan can move only when nothing refuses it', () => {
  it('scheduling offered, not started, not held: it moves', () => {
    expect(slotMovable({ canSchedule: true, reschedulable: true, held: false })).toBe(true);
    expect(slotMovable({ canSchedule: true })).toBe(true);
  });

  it('a held post never moves, even while other channels are on', () => {
    expect(slotMovable({ canSchedule: true, reschedulable: true, held: true })).toBe(false);
  });

  it('nothing moves while no channel can be connected, or once it has started', () => {
    expect(slotMovable({ canSchedule: false, reschedulable: true, held: false })).toBe(false);
    expect(slotMovable({ canSchedule: true, reschedulable: false })).toBe(false);
  });

  it('the drag line is shown only while dragging is offered at all', () => {
    expect(dragHintShown(true)).toBe(true);
    expect(dragHintShown(false)).toBe(false);
  });
});

describe('the calendar asks that one rule everywhere', () => {
  const view = read('apps/dashboard/src/app/[locale]/calendar/calendar-view.tsx');

  it('the drawer’s Date/Time/Move form, the chip, the drag and the drop', () => {
    expect(view).toContain(
      '{movable(openSlot) ? (\n              <form action={actions.reschedule}',
    );
    expect(view).toContain('canMove: slot !== undefined && movable(slot)');
    expect(view).toContain('return slot && movable(slot) ? `slot:${post.id}` : undefined;');
    expect(view).toContain("if (!slot || !movable(slot) || !actions.move) return 'ignored';");
  });

  it('both drag lines (the footer and the phone’s note)', () => {
    expect(view).toContain("hint: dragHintShown(canSchedule) ? (t['calendar.hint'] ?? '') : '',");
    expect(view).toMatch(
      /\{dragHintShown\(canSchedule\) \? \(\s*<p className="bs-narrow-only" data-testid="calendar-move-note"/,
    );
  });

  it('Open in the Studio and Take off the calendar stay for a held post', () => {
    expect(view).toContain('{canUnschedule && openSlot.reschedulable !== false ? (');
    expect(view).toContain('data-testid="calendar-open-studio"');
  });

  it('channels are named, and only configured ones are shown', () => {
    const page = read('apps/dashboard/src/app/[locale]/calendar/page.tsx');
    expect(page).toContain(
      'const channels = view.slot.platformKeys.filter((key) => platformKeys.includes(key));',
    );
    expect(page).toMatch(/\.filter\(\s*\(key\) => platformKeys\.includes\(key\),\s*\)/);
    expect(view).toContain('value={openSlot.channels.map(channelName).join(');
  });
});
