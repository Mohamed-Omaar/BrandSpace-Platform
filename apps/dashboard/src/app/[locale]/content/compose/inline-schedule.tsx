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
 * AN APPROVED DESIGN-SYSTEM EXTENSION (UI-FIDELITY §6.3): the composer's own
 * `cs-field` inputs and `cs-dark-button`, nothing new.
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
}) {
  const id = useId();
  const firstDate = plannedDate && plannedDate >= today ? plannedDate : tomorrow;
  const [date, setDate] = useState(firstDate);
  const [time, setTime] = useState(firstDate === today ? '' : defaultTime);

  return (
    <form action={action} className="cs-form-row" data-testid="editor-schedule-inline">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="contentItemId" value={itemId} />
      <div className="cs-field">
        <label htmlFor={`${id}-date`}>{t['editor.schedule.date']}</label>
        <input
          id={`${id}-date`}
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
      </div>
      <div className="cs-field">
        <label htmlFor={`${id}-time`}>{t['editor.schedule.time']}</label>
        <input
          id={`${id}-time`}
          type="time"
          name="time"
          required
          value={time}
          data-testid="editor-schedule-time"
          aria-describedby={date === today ? `${id}-today` : undefined}
          onChange={(event) => setTime(event.target.value)}
        />
        {date === today ? (
          <p id={`${id}-today`} className="cs-hint" data-testid="editor-schedule-today">
            {t['editor.schedule.todayHint']}
          </p>
        ) : null}
      </div>
      <div className="cs-form-actions">
        <button
          type="submit"
          className="cs-dark-button"
          disabled={disabled}
          data-testid="editor-schedule-submit"
        >
          {t['editor.schedule.submit']}
        </button>
      </div>
    </form>
  );
}
