'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  Button,
  ContentCalendar,
  Dialog,
  Field,
  StateMessage,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
  type CalendarDay,
  type PostRecord,
} from '@brandspace/ui';

/**
 * The Content Calendar — the customer screen.
 *
 * COMPOSED, NOT INVENTED. `ContentCalendar` already ships in `packages/ui`: a
 * month grid with real `role="grid"` semantics, a week view, and an AGENDA that
 * replaces the grid below `md` — because a seven-column calendar at 390px gives
 * each day about fifty pixels and every post becomes an unreadable sliver. It
 * was built as a port of the approved demo's `calendar()` and rendered fixtures;
 * this screen is the same composition with the workspace's own slots behind it
 * (UI-fidelity contract §6.2 rule 4 — reuse before creating).
 *
 * WHAT THIS ADDS TO IT: live period navigation, and the three actions the
 * planning half of the module is for — schedule, move, take off.
 *
 * THE MONTH LIVES IN THE URL. A calendar somebody links to a colleague, comes
 * back to, or reloads after moving a post has to come back to the same month.
 * State that lives only in the browser loses all three, and the Asset Library
 * and the content library both settled this the same way.
 *
 * NOTHING PUBLISHES (AC-14.7). Every slot's target is a mock, and the screen
 * says so rather than implying a connection the product does not have.
 */

export interface SchedulableDraft {
  readonly id: string;
  readonly title: string;
  readonly channels: readonly string[];
}

export interface SlotDetail {
  readonly slotId: string;
  readonly contentItemId: string;
  readonly title: string;
  readonly date: string;
  readonly time: string;
  readonly channels: readonly string[];
}

export interface CalendarViewProps {
  readonly locale: string;
  readonly t: Record<string, string>;
  readonly periodLabel: string;
  /** `YYYY-MM`, the month the URL asked for. */
  readonly month: string;
  readonly previousMonth: string;
  readonly nextMonth: string;
  readonly currentMonth: string;
  readonly days: readonly CalendarDay[];
  readonly slots: readonly SlotDetail[];
  readonly drafts: readonly SchedulableDraft[];
  readonly timezone: string;
  readonly quotaUsed: number;
  readonly quotaLimit: number | null;
  readonly canSchedule: boolean;
  /**
   * The calendar's labels, MINUS the one that is a function.
   *
   * `CalendarLabels.postsOnDay` takes a count and returns a sentence, and a
   * function cannot cross the server/client boundary — React refuses it, which
   * is the correct refusal: a closure has no serialisable form. So the server
   * sends the WORD and this island composes the function, which is the only
   * half that has to run in the browser anyway.
   */
  readonly labels: Omit<Parameters<typeof ContentCalendar>[0]['labels'], 'postsOnDay'>;
  /** The noun `postsOnDay` puts after the count, already translated. */
  readonly postsOnDayLabel: string;
  readonly actions: {
    schedule(formData: FormData): Promise<void>;
    reschedule(formData: FormData): Promise<void>;
    cancel(formData: FormData): Promise<void>;
  };
}

export function CalendarView({
  locale,
  t,
  periodLabel,
  month,
  previousMonth,
  nextMonth,
  currentMonth,
  days,
  slots,
  drafts,
  timezone,
  quotaUsed,
  quotaLimit,
  canSchedule,
  labels,
  postsOnDayLabel,
  actions,
}: CalendarViewProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [scheduling, setScheduling] = useState(false);
  const [openSlotId, setOpenSlotId] = useState<string | null>(null);

  const goTo = (target: string) => {
    startTransition(() => router.push(`/${locale}/calendar?month=${target}`));
  };

  const openSlot = slots.find((slot) => slot.slotId === openSlotId) ?? null;

  /*
   * A POST CHIP CARRIES THE SLOT ID, so opening one is a lookup rather than a
   * search through the rendered days. `PostRecord.id` is the slot's id for
   * exactly this reason — the chip is a plan, not a draft.
   */
  const onOpenPost = (post: PostRecord) => setOpenSlotId(post.id);

  const quotaText =
    quotaLimit === null
      ? `${t['calendar.quota']}: ${quotaUsed} · ${t['calendar.quotaUnlimited']}`
      : `${t['calendar.quota']}: ${quotaUsed} / ${quotaLimit}`;

  return (
    <div data-testid="calendar-page" style={{ display: 'grid', gap: spacingTokens.lg }}>
      <ContentCalendar
        periodLabel={periodLabel}
        days={days}
        labels={{ ...labels, postsOnDay: (count) => `${count} ${postsOnDayLabel}` }}
        busy={pending}
        onPrevious={() => goTo(previousMonth)}
        onNext={() => goTo(nextMonth)}
        onToday={() => goTo(currentMonth)}
        onOpenPost={onOpenPost}
        createAction={
          canSchedule ? (
            <Button
              variant="primary"
              size="sm"
              data-testid="calendar-schedule-open"
              onClick={() => setScheduling(true)}
            >
              {t['calendar.scheduleSubmit']}
            </Button>
          ) : undefined
        }
        filters={
          <>
            {/*
              THE ZONE IS STATED, ALWAYS. Every time on this screen is a
              wall-clock in the workspace's zone, and a calendar that does not
              say which zone it means is a calendar people misread — which is
              the whole reason the slot stores the intent (AC-14.2, AC-14.3).
            */}
            <span
              data-testid="calendar-timezone"
              style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}
            >
              {t['calendar.timezoneNote']}: {timezone}
            </span>
            <span
              data-testid="calendar-quota"
              style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}
            >
              {quotaText}
            </span>
          </>
        }
      />

      {/* ------------------------------------------- schedule a draft --- */}
      <Dialog
        open={scheduling}
        onClose={() => setScheduling(false)}
        title={t['calendar.scheduleTitle'] ?? ''}
        description={`${t['calendar.timezoneNote']}: ${timezone}`}
        closeLabel={t['common.close'] ?? 'Close'}
        testId="calendar-schedule-dialog"
      >
        {drafts.length === 0 ? (
          <StateMessage
            title={t['calendar.noSchedulable'] ?? ''}
            description={t['calendar.noSchedulableBody'] ?? ''}
          />
        ) : (
          <form action={actions.schedule} style={{ display: 'grid', gap: spacingTokens.md }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="month" value={month} />

            <Field label={t['calendar.scheduleDraft'] ?? ''} htmlFor="schedule-item">
              <select
                className="bs-control"
                id="schedule-item"
                name="contentItemId"
                required
                data-testid="schedule-item"
                style={inputStyle()}
              >
                {drafts.map((draft) => (
                  <option key={draft.id} value={draft.id}>
                    {draft.title}
                  </option>
                ))}
              </select>
            </Field>

            {/*
              NATIVE date AND time INPUTS, deliberately. Each is localised by
              the browser, keyboard-operable, and announced correctly by screen
              readers — everything a hand-rolled picker would have to re-earn,
              and the reason WCAG 2.2 AA is cheaper to keep here than to rebuild.
            */}
            <div className="bs-form-row">
              <Field label={t['calendar.scheduleDate'] ?? ''} htmlFor="schedule-date">
                <input
                  className="bs-control"
                  id="schedule-date"
                  name="date"
                  type="date"
                  required
                  data-testid="schedule-date"
                  style={inputStyle()}
                />
              </Field>
              <Field label={t['calendar.scheduleTime'] ?? ''} htmlFor="schedule-time">
                <input
                  className="bs-control"
                  id="schedule-time"
                  name="time"
                  type="time"
                  required
                  data-testid="schedule-time"
                  style={inputStyle()}
                />
              </Field>
            </div>

            <div>
              <button type="submit" data-testid="schedule-submit" style={buttonStyle('primary')}>
                {t['calendar.scheduleSubmit']}
              </button>
            </div>
          </form>
        )}
      </Dialog>

      {/* ------------------------------------- move or remove a slot --- */}
      <Dialog
        open={openSlot !== null}
        onClose={() => setOpenSlotId(null)}
        title={openSlot?.title ?? ''}
        description={`${t['calendar.mockTarget']}`}
        closeLabel={t['common.close'] ?? 'Close'}
        testId="calendar-slot-dialog"
      >
        {openSlot ? (
          <div style={{ display: 'grid', gap: spacingTokens.md }}>
            <p style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary, margin: 0 }}>
              {t['calendar.channels']}: {openSlot.channels.join(' · ')}
            </p>

            {canSchedule ? (
              <form action={actions.reschedule} style={{ display: 'grid', gap: spacingTokens.md }}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="month" value={month} />
                <input type="hidden" name="slotId" value={openSlot.slotId} />
                <div className="bs-form-row">
                  <Field label={t['calendar.scheduleDate'] ?? ''} htmlFor="reschedule-date">
                    <input
                      className="bs-control"
                      id="reschedule-date"
                      name="date"
                      type="date"
                      required
                      defaultValue={openSlot.date}
                      data-testid="reschedule-date"
                      style={inputStyle()}
                    />
                  </Field>
                  <Field label={t['calendar.scheduleTime'] ?? ''} htmlFor="reschedule-time">
                    <input
                      className="bs-control"
                      id="reschedule-time"
                      name="time"
                      type="time"
                      required
                      defaultValue={openSlot.time}
                      data-testid="reschedule-time"
                      style={inputStyle()}
                    />
                  </Field>
                </div>
                <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
                  <button
                    type="submit"
                    data-testid="reschedule-submit"
                    style={buttonStyle('primary')}
                  >
                    {t['calendar.rescheduleSubmit']}
                  </button>
                </div>
              </form>
            ) : null}

            <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
              <a
                href={`/${locale}/content/compose?item=${openSlot.contentItemId}`}
                data-testid="calendar-open-studio"
                style={buttonStyle('neutral')}
              >
                {t['calendar.openInStudio']}
              </a>
              {canSchedule ? (
                <form action={actions.cancel}>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="month" value={month} />
                  <input type="hidden" name="slotId" value={openSlot.slotId} />
                  <button
                    type="submit"
                    data-testid="calendar-cancel-submit"
                    style={buttonStyle('neutral')}
                  >
                    {t['calendar.cancelSubmit']}
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
