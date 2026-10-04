import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DROP_STRIP_DAYS,
  LONG_PRESS_MS,
  LONG_PRESS_TOLERANCE_PX,
  MOUSE_DRAG_THRESHOLD_PX,
  dropOutcome,
  dropStateOf,
  stripDayKeys,
  travelled,
} from '../../packages/ui/src/calendar-drag';
import type { CalendarDay, PostRecord } from '../../packages/ui/src';
import {
  pendingMoves,
  withMoves,
} from '../../apps/dashboard/src/app/[locale]/calendar/optimistic-moves';
import { parseSlotMove } from '../../apps/dashboard/src/server/calendar-move';

/**
 * §8.2 (Phase 2B-2b item 10, D-353) — the calendar drag, as rules. The
 * database half (Undo's precondition, idempotency, F2 at Undo time) is
 * `tests/isolation/content-calendar.test.ts`; the browser half — a mouse drag
 * on the month, and a REAL touch long-press on a phone — is
 * `tests/e2e/prototype-v90-phase2b2b-calendar-drag.spec.ts`.
 */

const read = (file: string) => readFileSync(file, 'utf8');

describe('when a drag starts', () => {
  it('a mouse lifts after 5 px, so a plain click still opens the post', () => {
    expect(MOUSE_DRAG_THRESHOLD_PX).toBe(5);
    expect(travelled(3, 4, MOUSE_DRAG_THRESHOLD_PX)).toBe(false); // exactly 5 px
    expect(travelled(4, 4, MOUSE_DRAG_THRESHOLD_PX)).toBe(true);
  });

  it('a finger lifts after a 380 ms long-press, unless it moved more than 8 px first', () => {
    expect(LONG_PRESS_MS).toBe(380);
    expect(LONG_PRESS_TOLERANCE_PX).toBe(8);
    expect(travelled(0, 8, LONG_PRESS_TOLERANCE_PX)).toBe(false);
    expect(travelled(0, 9, LONG_PRESS_TOLERANCE_PX)).toBe(true);
  });
});

describe('what a day does with a dropped post', () => {
  it('a day of the month takes it; a past day refuses it; outside the month takes nothing', () => {
    expect(dropStateOf({ isPast: false, inCurrentPeriod: true })).toBe('ok');
    expect(dropStateOf({ isPast: true, inCurrentPeriod: true })).toBe('past');
    expect(dropStateOf({ isPast: false, inCurrentPeriod: false })).toBe('none');
    expect(dropStateOf({ isPast: true, inCurrentPeriod: false })).toBe('none');
    expect(dropStateOf({ inCurrentPeriod: true })).toBe('ok');
  });

  it('only a different day that takes it is a move; everything else changes nothing', () => {
    expect(dropOutcome({ dayKey: '2026-10-21', state: 'ok' }, '2026-10-20')).toBe('move');
    expect(dropOutcome({ dayKey: '2026-10-20', state: 'ok' }, '2026-10-20')).toBe('cancel');
    expect(dropOutcome({ dayKey: '2026-10-01', state: 'past' }, '2026-10-20')).toBe('refuse');
    expect(dropOutcome({ dayKey: '2026-11-02', state: 'none' }, '2026-10-20')).toBe('cancel');
    expect(dropOutcome(null, '2026-10-20')).toBe('cancel');
    // A tray draft comes from no day: any day that takes it is a move.
    expect(dropOutcome({ dayKey: '2026-10-21', state: 'ok' }, null)).toBe('move');
  });
});

describe('the phone’s drop strip', () => {
  it('is the next 14 days, today first, across a month and a year end', () => {
    expect(DROP_STRIP_DAYS).toBe(14);
    const days = stripDayKeys('2026-12-25');
    expect(days).toHaveLength(14);
    expect(days[0]).toBe('2026-12-25');
    expect(days[6]).toBe('2026-12-31');
    expect(days[7]).toBe('2027-01-01');
    expect(days[13]).toBe('2027-01-07');
    expect(stripDayKeys('')).toEqual([]);
  });

  it('two rows of seven, glass, every day a drop target', () => {
    const calendar = read('packages/ui/src/calendar.tsx');
    const strip = calendar.slice(calendar.indexOf('export function CalendarDropStrip'));
    expect(strip).toContain("gridTemplateColumns: 'repeat(7, minmax(0, 1fr))'");
    expect(strip).toContain('data-drop-day={day.key}');
    expect(strip).toContain('data-drop-state="ok"');
    expect(strip).toContain('className="bs-drag-strip"');
  });
});

describe('the move is drawn at once; the server confirms or reverts it', () => {
  const post = (id: string): PostRecord =>
    ({
      id,
      status: 'scheduled',
      caption: id,
      whenLabel: '',
      platforms: [],
    }) as unknown as PostRecord;
  const day = (key: string, posts: PostRecord[]): CalendarDay =>
    ({
      key,
      label: key.slice(8),
      longLabel: key,
      inCurrentPeriod: true,
      isToday: false,
      posts,
    }) as CalendarDay;
  const times: Record<string, string> = { a: '18:00', b: '09:00', c: '12:00' };
  const timeOf = (id: string) => times[id] ?? '';

  it('takes the post off its day and puts it on the new one, in time order', () => {
    const days = [day('2026-10-20', [post('a'), post('c')]), day('2026-10-21', [post('b')])];
    const shown = withMoves(days, new Map([['c', '2026-10-21']]), timeOf);
    expect(shown[0]?.posts.map((p) => p.id)).toEqual(['a']);
    expect(shown[1]?.posts.map((p) => p.id)).toEqual(['b', 'c']);
    // The same day, or no moves: the days are handed back untouched.
    expect(withMoves(days, new Map(), timeOf)).toBe(days);
    expect(withMoves(days, new Map([['a', '2026-10-20']]), timeOf)).toBe(days);
  });

  it('a move to a day outside the month shown takes the post off the page', () => {
    const days = [day('2026-10-30', [post('a')])];
    expect(withMoves(days, new Map([['a', '2026-11-03']]), timeOf)[0]?.posts).toEqual([]);
  });

  it('an override ends once the server shows the same, or the post has left the month', () => {
    const moves = new Map([
      ['a', '2026-10-21'],
      ['b', '2026-10-22'],
      ['c', '2026-10-23'],
    ]);
    const server: Record<string, string> = { a: '2026-10-21', b: '2026-10-20' };
    const left = pendingMoves(moves, (id) => server[id]);
    expect([...left.entries()]).toEqual([['b', '2026-10-22']]);
    // Nothing to drop: the same map, so React does not render again.
    expect(pendingMoves(left, (id) => server[id])).toBe(left);
  });
});

describe('the move and its Undo go through the one reschedule', () => {
  const slotId = '0f8fad5b-d9cb-469f-a165-70867728950e';

  it('accepts only a slot id, a date, a time and — for an Undo — the time it must still be at', () => {
    expect(parseSlotMove({ slotId, date: '2026-10-21', time: '18:00' })).toEqual({
      slotId,
      date: '2026-10-21',
      time: '18:00',
    });
    expect(
      parseSlotMove({
        slotId,
        date: '2026-10-20',
        time: '18:00',
        expectedLocalTime: '2026-10-21T18:00',
      }),
    ).toMatchObject({ expectedLocalTime: '2026-10-21T18:00' });
    for (const bad of [
      null,
      'slot',
      { slotId: 'nope', date: '2026-10-21', time: '18:00' },
      { slotId, date: '21/10/2026', time: '18:00' },
      { slotId, date: '2026-10-21', time: '6pm' },
      { slotId, date: '2026-10-21', time: '18:00', expectedLocalTime: '2026-10-21' },
      { slotId, date: '2026-10-21', time: '18:00', expectedLocalTime: 5 },
    ]) {
      expect(parseSlotMove(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('the action needs content.schedule and calls the same service as the drawer’s form', () => {
    const actions = read('apps/dashboard/src/app/[locale]/calendar/actions.ts');
    const move = actions.slice(actions.indexOf('export async function moveSlotAction'));
    const body = move.slice(0, move.indexOf('\n}\n'));
    expect(body).toContain("requireWorkspaceAction(locale, 'content.schedule')");
    expect(body).toContain('(await calendar()).reschedule({');
    expect(body).toContain('expectedLocalTime: move.expectedLocalTime,');
    expect(body).toContain('unstable_rethrow(error);');
    // No second path to the database, no skipping a rule.
    expect(body).not.toMatch(/calendarSlot|prisma|\$executeRaw|updateMany/);
  });

  it('Undo carries the time the move put it at, and a refused Undo leaves it moved', () => {
    const view = read('apps/dashboard/src/app/[locale]/calendar/calendar-view.tsx');
    const undo = view.slice(
      view.indexOf('const undoMove = async'),
      view.indexOf('const commitMove'),
    );
    expect(undo).toContain('expectedLocalTime: movedTo.localTime,');
    expect(undo).toMatch(
      /if \(!result\.ok\) \{\s*\/\/ It stays moved[^\n]*\n\s*moveTo\(slotId, movedTo\.date\);\s*refuse\(result\.message\);/,
    );
    const commit = view.slice(view.indexOf('const commitMove'), view.indexOf('const onDrop ='));
    expect(commit).toMatch(
      /if \(!result\.ok\) \{\s*moveTo\(slot\.slotId, null\);\s*refuse\(result\.message\);/,
    );
    expect(commit).toContain("testId: 'calendar-undo'");
  });

  it('the refusal reason for a slot that moved since is said in both languages', async () => {
    const { statusMessage } = await import('../../apps/dashboard/src/i18n/messages');
    expect(statusMessage('SLOT_MOVED_SINCE', 'en')).toBeTruthy();
    expect(statusMessage('SLOT_MOVED_SINCE', 'ar')).toMatch(/[؀-ۿ]/);
  });
});

describe('the engine: only a committed drop calls anything', () => {
  const engine = read('packages/ui/src/use-calendar-drag.ts');

  it('onDrop is called in exactly one place: the end of a gesture that became a move', () => {
    expect(engine.match(/optionsRef\.current\.onDrop\(/g)).toHaveLength(1);
    const end = engine.slice(engine.indexOf('const end = (commit: boolean)'));
    expect(end.slice(0, end.indexOf('// ---- mouse'))).toContain(
      "const outcome = commit ? dropOutcome(target, g.fromDay) : 'cancel';",
    );
    // At release it looks again under the pointer, in case the page moved under it.
    expect(engine).toContain('if (commit && gesture?.lifted) move(gesture.x, gesture.y);');
    // Moving and hovering only describe.
    const move = engine.slice(
      engine.indexOf('const move = (x: number'),
      engine.indexOf('const glideBack'),
    );
    expect(move).not.toContain('onDrop');
  });

  it('a lifted touch drag stops the page scrolling; before the lift the page scrolls', () => {
    expect(engine).toContain(
      "root.addEventListener('touchmove', onTouchMove, { passive: false });",
    );
    expect(engine).toContain(
      "root.addEventListener('touchstart', onTouchStart, { passive: true });",
    );
    expect(engine).toMatch(/if \(!g\.lifted\) \{[\s\S]*?return;\s*\}\s*event\.preventDefault\(\);/);
    expect(engine).toContain('}, LONG_PRESS_MS);');
    expect(engine).toContain("root.addEventListener('contextmenu', onContextMenu);");
  });

  it('Escape puts it back; reduced motion keeps the drag and drops the animation', () => {
    expect(engine).toMatch(/event\.key === 'Escape' && gesture\?\.lifted[\s\S]*?end\(false\);/);
    expect(engine).toContain('const still = () => prefersReducedMotion();');
    expect(engine).toContain('duration: motionMs.drop, easing: OVERSHOOT');
    expect(engine).toContain('duration: motionMs.settle');
  });

  it('native drag and drop is gone from the calendar', () => {
    for (const file of [
      'packages/ui/src/calendar.tsx',
      'packages/ui/src/post-card.tsx',
      'apps/dashboard/src/app/[locale]/calendar/calendar-view.tsx',
    ]) {
      expect(read(file), file).not.toMatch(/dataTransfer|onDragStart|onDragOver|\bdraggable\b/);
    }
  });
});

describe('who can drag what', () => {
  const view = read('apps/dashboard/src/app/[locale]/calendar/calendar-view.tsx');

  it('only a scheduler, and only a post that has not started going out (published cannot)', () => {
    expect(view).toContain('if (!canSchedule) return undefined;');
    expect(view).toContain(
      'return slot && slot.reschedulable !== false ? `slot:${post.id}` : undefined;',
    );
    // Drop targets exist only for a scheduler (D-468: the ported calendar's prop).
    expect(view).toContain('dropTargets={canSchedule}');
  });
});

describe('the looks', () => {
  const css = read('packages/ui/src/tokens.css');

  it('lift: scale 1.04, rotate −1.5°, a deeper shadow, 180 ms — and translate is never eased', () => {
    expect(css).toMatch(/\.bs-drag-copy\.bs-drag-lifted \{\s*scale: 1\.04;\s*rotate: -1\.5deg;/);
    const copy = css.slice(
      css.indexOf('.bs-drag-copy {'),
      css.indexOf('.bs-drag-copy.bs-drag-lifted'),
    );
    expect(copy).toContain('scale var(--bs-motion-drag-lift)');
    expect(copy).not.toMatch(/translate var|transform var|\ball\b/);
  });

  it('a day that takes it is light purple and dashed; a past day grey with a red dashed outline', () => {
    expect(css).toMatch(
      /\[data-drop-over='ok'\] \{\s*background-color: var\(--bs-brand-purple-tint\) !important;\s*outline: 2px dashed var\(--bs-brand-purple\);/,
    );
    expect(css).toMatch(
      /\[data-drop-over='past'\] \{\s*background-color: var\(--bs-surface-sunken\) !important;\s*outline: 2px dashed var\(--bs-danger\);/,
    );
  });

  it('a move that changed the post’s status pulses its card once, as a ring', () => {
    expect(css).toMatch(
      /\.bs-status-pulse \{\s*animation: bs-status-pulse var\(--bs-motion-loop\) var\(--bs-ease-out\) 1;/,
    );
    const view = read('apps/dashboard/src/app/[locale]/calendar/calendar-view.tsx');
    expect(view).toContain('if (!post || post.status === pending.status) return;');
    expect(view).toContain("chip.classList.add('bs-status-pulse');");
  });

  it('the strip is glass with the unprefixed blur only (§8.0)', () => {
    const strip = css.slice(css.indexOf('.bs-drag-strip {'));
    expect(strip.slice(0, strip.indexOf('}'))).toContain('backdrop-filter: blur(24px);');
    expect(strip.slice(0, strip.indexOf('}'))).not.toContain('-webkit-backdrop-filter');
  });

  it('its words exist in both languages, and the phone hint is §8.2’s', async () => {
    const { messages } = await import('../../apps/dashboard/src/i18n/messages');
    for (const key of [
      'calendar.drag.pastDay',
      'calendar.drag.strip',
      'calendar.drag.moved',
      'calendar.drag.undo',
      'calendar.drag.undone',
      'calendar.moveFromPost',
    ]) {
      for (const locale of ['en', 'ar'] as const) {
        expect((messages[locale] as Record<string, string>)[key], `${locale} ${key}`).toBeTruthy();
      }
    }
    expect(messages.en['calendar.moveFromPost']).toBe(
      'Press and hold a post, then drag it to its new day.',
    );
    expect(messages.en['calendar.drag.moved']).toContain('{when}');
    expect(messages.ar['calendar.drag.moved']).toContain('{when}');
  });
});
