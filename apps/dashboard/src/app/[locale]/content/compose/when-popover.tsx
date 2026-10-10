'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ProposeTimeResult } from '../actions';

/**
 * BATCH 7 PR C — "WHEN SHOULD IT GO OUT?", the Studio's publish-time popover,
 * ported from `Main.dc.html` lines 343–349 (the `WHV` logic, lines 2310–2321).
 *
 * WHAT IT STORES. The time chosen here is the post's PROPOSED time
 * (`ContentItem.proposedLocalTime`, through `proposeTimeAction`). Choosing it
 * schedules nothing (B1.2): the Studio's Schedule press — or "Approve &
 * schedule" where the brand needs approval (B1.3) — puts it on the calendar.
 *
 * THE CHOICES, as the prototype draws them:
 *   - "Best time automatically" and the "When your audience is active" chips —
 *     only when `best` arrived, i.e. the brand has enough real engagement on
 *     every channel of the post (`server/best-time.ts`). Without it neither is
 *     drawn: no disabled control, no placeholder hours.
 *   - "Pick a date and time — You decide", always.
 *   - "Right after approval — Goes out as soon as <reviewer> approves", only
 *     where the post needs approval: no time stored, the choice is
 *     AFTER_APPROVAL (owner answer, Option B), and the date and time are not
 *     drawn while it is chosen — as the prototype's `isPick` hides them.
 *
 * THE FOOTER follows the owner's rule, not the prototype's line: a post
 * approved after its time is approved and NOT scheduled, and the person picks
 * a new time (D-488).
 *
 * The product's own additions, in the popover's own type: what became of the
 * last change, and "Remove the time" while one is stored.
 */

export interface WhenBest {
  readonly slots: readonly {
    readonly time: string;
    readonly part: string;
    readonly top: boolean;
  }[];
  /** `YYYY-MM-DDTHH:mm`. */
  readonly bestLocalTime: string;
  /** "Oct 14 · 09:00", already in the reader's language. */
  readonly bestLabel: string;
}

type Mode = 'best' | 'pick' | 'after';
export type PublishChoice = 'NONE' | 'PICK' | 'AFTER_APPROVAL';
type Saving = 'idle' | 'saving' | 'failed-past' | 'failed-locked' | 'failed';

const SAVE_PAUSE_MS = 500;

export function WhenPopover({
  locale,
  itemId,
  t,
  today,
  tomorrow,
  defaultTime,
  plannedDate,
  proposed,
  choice,
  best,
  requiresApproval,
  reviewerName,
  propose,
  onProposed,
  onDone,
  saveOnMount = false,
  initial = null,
  children,
}: {
  readonly locale: string;
  readonly itemId: string;
  readonly t: Record<string, string>;
  /** `YYYY-MM-DD` in the workspace's zone. */
  readonly today: string;
  readonly tomorrow: string;
  /** `HH:mm`, the brand's default time. */
  readonly defaultTime: string;
  /** The ★ day the Studio was opened for, when it is today or later. */
  readonly plannedDate: string | null;
  /** What the post holds now, `YYYY-MM-DDTHH:mm`, or null. */
  readonly proposed: string | null;
  /** The post's stored choice. */
  readonly choice: PublishChoice;
  readonly best: WhenBest | null;
  /** The post still needs approval: "Right after approval" is offered. */
  readonly requiresApproval: boolean;
  /** Who approves by default, for "Goes out as soon as … approves". */
  readonly reviewerName: string | null;
  readonly propose: (formData: FormData) => Promise<ProposeTimeResult>;
  readonly onProposed: (value: string | null, choice: PublishChoice) => void;
  readonly onDone: () => void;
  /** The new post's hand-off: what was chosen before the draft existed. */
  readonly initial?: { readonly date: string; readonly time: string } | null;
  readonly saveOnMount?: boolean;
  /** The calendar link, where the Studio offers it. */
  readonly children?: React.ReactNode;
}) {
  const id = useId();
  const firstDate =
    proposed?.slice(0, 10) ??
    (initial?.date || (plannedDate && plannedDate >= today ? plannedDate : tomorrow));
  const [date, setDate] = useState(firstDate);
  const [time, setTime] = useState(
    proposed?.slice(11, 16) ?? (initial?.time || (firstDate === today ? '' : defaultTime)),
  );
  const [mode, setMode] = useState<Mode>(
    choice === 'AFTER_APPROVAL' && requiresApproval
      ? 'after'
      : best && proposed !== null && proposed === best.bestLocalTime
        ? 'best'
        : 'pick',
  );
  const [saving, setSaving] = useState<Saving>('idle');
  const storedRef = useRef(choice === 'AFTER_APPROVAL' ? 'after' : proposed);
  storedRef.current = choice === 'AFTER_APPROVAL' ? 'after' : proposed;
  const sequence = useRef(0);
  const timer = useRef<number | null>(null);

  const save = (nextDate: string, nextTime: string | null | 'after') => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const value =
      nextTime === 'after' ? 'after' : nextTime === null ? null : `${nextDate}T${nextTime}`;
    if (
      value !== null &&
      value !== 'after' &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate) || !/^\d{2}:\d{2}$/.test(nextTime ?? ''))
    ) {
      return;
    }
    if (value === storedRef.current) return;
    const form = new FormData();
    form.set('locale', locale);
    form.set('contentItemId', itemId);
    if (value === null) form.set('clear', '1');
    else if (value === 'after') form.set('afterApproval', '1');
    else {
      form.set('date', nextDate);
      form.set('time', nextTime ?? '');
    }
    const mine = ++sequence.current;
    setSaving('saving');
    void propose(form).then(
      (result) => {
        if (mine !== sequence.current) return;
        if (result.ok) {
          setSaving('idle');
          onProposed(result.proposedLocalTime, result.publishChoice);
          return;
        }
        setSaving(
          result.code === 'SCHEDULE_IN_PAST'
            ? 'failed-past'
            : result.code === 'LOCKED'
              ? 'failed-locked'
              : 'failed',
        );
      },
      () => {
        if (mine === sequence.current) setSaving('failed');
      },
    );
  };
  const saveSoon = (nextDate: string, nextTime: string) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save(nextDate, nextTime), SAVE_PAUSE_MS);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  const savedOnce = useRef(false);
  useEffect(() => {
    if (!saveOnMount || savedOnce.current) return;
    savedOnce.current = true;
    // Once, with what the new post's panel handed over.
    save(date, time);
  }, [saveOnMount]);

  const chooseBest = () => {
    if (!best) return;
    setMode('best');
    const nextDate = best.bestLocalTime.slice(0, 10);
    const nextTime = best.bestLocalTime.slice(11, 16);
    setDate(nextDate);
    setTime(nextTime);
    save(nextDate, nextTime);
  };

  const modes: readonly { key: Mode; label: string; sub: string; act: () => void }[] = [
    ...(best
      ? [
          {
            key: 'best' as const,
            label: t['studio.when.mode.best'] ?? '',
            sub: (t['studio.when.mode.bestSub'] ?? '').replace('{label}', best.bestLabel),
            act: chooseBest,
          },
        ]
      : []),
    {
      key: 'pick',
      label: t['studio.when.mode.pick'] ?? '',
      sub: t['studio.when.mode.pickSub'] ?? '',
      act: () => {
        setMode('pick');
        // Leaving "Right after approval" keeps the date and time on screen.
        if (storedRef.current === 'after') save(date, time);
      },
    },
    ...(requiresApproval
      ? [
          {
            key: 'after' as const,
            label: t['studio.when.mode.after'] ?? '',
            sub: (t['studio.when.mode.afterSub'] ?? '').replace(
              '{reviewer}',
              reviewerName ?? t['studio.when.reviewerAny'] ?? '',
            ),
            act: () => {
              setMode('after');
              save(date, 'after');
            },
          },
        ]
      : []),
  ];

  return (
    <div className="bsp-st-when-form" data-testid="editor-propose">
      {modes.map((choice) => (
        <button
          key={choice.key}
          type="button"
          className="bsp-st-when-mode"
          aria-pressed={mode === choice.key}
          data-testid={`editor-when-mode-${choice.key}`}
          onClick={choice.act}
        >
          <span className="bsp-st-when-mode-label">{choice.label}</span>
          <span className="bsp-st-when-mode-sub">{choice.sub}</span>
        </button>
      ))}
      {mode !== 'after' ? (
        <>
          <div className="bsp-st-when-grid">
            <label className="bsp-st-when-field" htmlFor={`${id}-date`}>
              <span>{t['editor.schedule.date']}</span>
              <input
                id={`${id}-date`}
                className="bsp-st-when-input"
                type="date"
                min={today}
                value={date}
                data-testid="editor-schedule-date"
                onChange={(event) => {
                  const next = event.target.value;
                  // Today: nothing proposed. Another day: the default, unless chosen.
                  const nextTime =
                    next === today
                      ? time === defaultTime
                        ? ''
                        : time
                      : time === ''
                        ? defaultTime
                        : time;
                  setDate(next);
                  setTime(nextTime);
                  setMode('pick');
                  saveSoon(next, nextTime);
                }}
              />
            </label>
            <label className="bsp-st-when-field" htmlFor={`${id}-time`}>
              <span>{t['editor.schedule.time']}</span>
              <input
                id={`${id}-time`}
                className="bsp-st-when-input"
                type="time"
                value={time}
                data-testid="editor-schedule-time"
                aria-describedby={date === today ? `${id}-today` : undefined}
                onChange={(event) => {
                  setTime(event.target.value);
                  setMode('pick');
                  saveSoon(date, event.target.value);
                }}
              />
            </label>
          </div>
          {date === today ? (
            <p id={`${id}-today`} className="bsp-st-when-note" data-testid="editor-schedule-today">
              {t['editor.schedule.todayHint']}
            </p>
          ) : null}
          {best ? (
            <div className="bsp-st-when-times" data-testid="editor-when-times">
              <span>{t['studio.when.goodTimes']}</span>
              <div className="bsp-st-when-chips">
                {best.slots.map((slot) => (
                  <button
                    key={slot.time}
                    type="button"
                    className="bsp-chip bsp-st-when-chip"
                    aria-pressed={time === slot.time}
                    data-testid={`editor-when-time-${slot.time.replace(':', '')}`}
                    onClick={() => {
                      setTime(slot.time);
                      setMode('pick');
                      save(date, slot.time);
                    }}
                  >
                    <span className="bsp-ltr">{slot.time}</span> ·{' '}
                    {slot.top
                      ? `${t[`studio.when.part.${slot.part}`] ?? ''} · ${t['studio.when.mostEngagement'] ?? ''}`
                      : t[`studio.when.part.${slot.part}`]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      <span className="bsp-st-when-note" data-testid="editor-when-note">
        {mode === 'after'
          ? t['studio.when.noteAfter']
          : requiresApproval
            ? t['studio.when.noteApproval']
            : t['studio.when.noteSchedule']}
      </span>
      {saving !== 'idle' || proposed !== null || choice === 'AFTER_APPROVAL' ? (
        <div className="bsp-st-when-foot">
          <span className="bsp-st-when-note" role="status" data-testid="editor-when-saving">
            {saving === 'saving'
              ? t['studio.saving']
              : saving === 'failed-past'
                ? t['studio.when.failedPast']
                : saving === 'failed-locked'
                  ? t['studio.when.failedLocked']
                  : saving === 'failed'
                    ? t['studio.when.failed']
                    : ''}
          </span>
          {proposed !== null || choice === 'AFTER_APPROVAL' ? (
            <button
              type="button"
              className="bsp-st-when-clear"
              data-testid="editor-when-clear"
              onClick={() => save(date, null)}
            >
              {t['studio.when.remove']}
            </button>
          ) : null}
        </div>
      ) : null}
      {children}
      <button
        type="button"
        className="bsp-btn bsp-sm bsp-st-end"
        data-testid="editor-when-done"
        onClick={() => {
          // "Done" keeps what is shown: the time on screen is the post's time.
          if (mode !== 'after') save(date, time);
          onDone();
        }}
      >
        {t['studio.whenDone']}
      </button>
    </div>
  );
}
