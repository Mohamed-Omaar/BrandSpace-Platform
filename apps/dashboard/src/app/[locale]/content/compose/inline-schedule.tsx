'use client';

import { useId, useState } from 'react';

/**
 * B9 / F2 (Phase 2B-2) — DATE AND TIME IN THE STUDIO, inline.
 *
 * The same two native controls the calendar's dialog uses, posting to the same
 * `schedule()` (through `scheduleFromStudioAction`), so the rules are the
 * calendar's:
 *
 *   - a new post is proposed for TOMORROW at the brand's default time (A10),
 *     else 09:00;
 *   - no day before today is offered (`min`);
 *   - on TODAY no time is proposed, because the default may already have
 *     passed — the person chooses one, and the server refuses a past time,
 *     earlier today included, with the calendar's own message.
 *
 * D-468: drawn as the prototype's "When" popover draws its date and time —
 * the `1fr 110px` pair of labelled native controls (`bsp-st-when-*`).
 */
export function InlineSchedule({
  locale,
  itemId,
  today,
  tomorrow,
  defaultTime,
  plannedDate,
  disabled,
  action,
  t,
  initial = null,
  hidden = {},
  submitLabel,
  testId = 'editor-schedule-inline',
}: {
  readonly locale: string;
  readonly itemId: string;
  /** `YYYY-MM-DD` in the workspace's zone. */
  readonly today: string;
  readonly tomorrow: string;
  /** `HH:mm`. */
  readonly defaultTime: string;
  /** G6 — the ★ day the Studio was opened for, when it is today or later. */
  readonly plannedDate: string | null;
  readonly disabled: boolean;
  readonly action: (formData: FormData) => Promise<void>;
  readonly t: Record<string, string>;
  /** Round 4 (3.3) — a post already on the calendar starts from its own time. */
  readonly initial?: { readonly date: string; readonly time: string } | null;
  /** Fields the action needs beyond the post (a reschedule's slot and return). */
  readonly hidden?: Readonly<Record<string, string>>;
  readonly submitLabel?: string | undefined;
  /** A reschedule is its own form: `editor-reschedule-inline`. */
  readonly testId?: string;
}) {
  const id = useId();
  const firstDate = initial
    ? initial.date
    : plannedDate && plannedDate >= today
      ? plannedDate
      : tomorrow;
  const [date, setDate] = useState(firstDate);
  const [time, setTime] = useState(initial ? initial.time : firstDate === today ? '' : defaultTime);

  return (
    <form action={action} className="bsp-st-when-form" data-testid={testId}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="contentItemId" value={itemId} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="bsp-st-when-grid">
        <label className="bsp-st-when-field" htmlFor={`${id}-date`}>
          <span>{t['editor.schedule.date']}</span>
          <input
            id={`${id}-date`}
            className="bsp-st-when-input"
            type="date"
            name="date"
            required
            min={today}
            value={date}
            data-testid="editor-schedule-date"
            onChange={(event) => {
              const next = event.target.value;
              setDate(next);
              // Today: nothing proposed. Another day: the default, unless chosen.
              setTime((current) =>
                next === today
                  ? current === defaultTime
                    ? ''
                    : current
                  : current === ''
                    ? defaultTime
                    : current,
              );
            }}
          />
        </label>
        <label className="bsp-st-when-field" htmlFor={`${id}-time`}>
          <span>{t['editor.schedule.time']}</span>
          <input
            id={`${id}-time`}
            className="bsp-st-when-input"
            type="time"
            name="time"
            required
            value={time}
            data-testid="editor-schedule-time"
            aria-describedby={date === today ? `${id}-today` : undefined}
            onChange={(event) => setTime(event.target.value)}
          />
        </label>
      </div>
      {date === today ? (
        <p id={`${id}-today`} className="bsp-st-when-note" data-testid="editor-schedule-today">
          {t['editor.schedule.todayHint']}
        </p>
      ) : null}
      <div className="bsp-st-when-acts">
        <button
          type="submit"
          className="bsp-btn bsp-sm bsp-pur"
          disabled={disabled}
          data-testid="editor-schedule-submit"
        >
          {submitLabel ?? t['editor.schedule.submit']}
        </button>
      </div>
    </form>
  );
}
