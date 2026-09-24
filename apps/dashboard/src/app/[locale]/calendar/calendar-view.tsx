'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  Banner,
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
 * NOTHING ON THIS SCREEN PUBLISHES, and that is not the same claim the header
 * used to make. It said "every slot's target is a mock", which was true of
 * Phase 5 and stopped being true when Phase 6 shipped real connections and the
 * scheduler began sweeping due slots into publish jobs. The three actions here
 * still reach no network — they move a plan — but the plan they move is one the
 * worker will act on, so P6-10 puts the publishing readiness of each scheduled
 * slot on the screen rather than a line saying nothing ever goes out.
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
  /** Phase 8 — the campaign the post belongs to, when it belongs to one. */
  readonly campaignName: string | null;
  /** The slot's own publishing state, already translated. */
  readonly statusLabel: string;
  /** The latest review's state, or `null` when nobody has been asked. */
  readonly approvalLabel: string | null;
  /** How many pictures the post carries across its variants. */
  readonly mediaCount: number;
  /**
   * PHASE 6 · P6-10 — whether this post has a route to its platforms, or
   * `null` when the question does not apply (it is not waiting to go out).
   *
   * ALREADY TRANSLATED, like every other label on this island. The server owns
   * the words; this component owns where they sit.
   */
  readonly readiness: SlotReadinessDetail | null;
}

export interface SlotReadinessDetail {
  /** The worst of the channels, in words. */
  readonly label: string;
  /** True when the post cannot go out at all as it stands. */
  readonly blocking: boolean;
  /** Only the channels that are in the way; empty when nothing is. */
  readonly channels: readonly {
    readonly platformKey: string;
    readonly label: string;
    /** `null` for a reader who may not see connected accounts. */
    readonly accountName: string | null;
  }[];
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
  /**
   * `?item=` — "Schedule" from the Content Library (D-282): the scheduling
   * dialog opens with that post chosen. Ignored unless it is a schedulable draft.
   */
  readonly preselectItemId?: string | undefined;
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
  preselectItemId,
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
  const preselected = drafts.some((draft) => draft.id === preselectItemId)
    ? preselectItemId
    : undefined;
  const [scheduling, setScheduling] = useState(preselected !== undefined);
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
                defaultValue={preselected}
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
        description={t['calendar.slotDialogHint'] ?? ''}
        closeLabel={t['common.close'] ?? 'Close'}
        testId="calendar-slot-dialog"
      >
        {openSlot ? (
          <div style={{ display: 'grid', gap: spacingTokens.md }}>
            {/*
              WHAT THE POST ACTUALLY IS, before what can be done to it.
              A definition list rather than a sentence, because a reader
              scanning for one fact — did it go out? — should not have to read
              the other three. Every row is omitted when it has no value: a
              post in no campaign has no campaign row, which is the honest
              rendering of "none" (D-184).
            */}
            <dl
              data-testid="calendar-slot-facts"
              style={{ margin: 0, display: 'grid', gap: spacingTokens['2xs'] }}
            >
              <SlotFact term={t['calendar.channels'] ?? ''} value={openSlot.channels.join(' · ')} />
              {openSlot.campaignName ? (
                <SlotFact
                  term={t['calendar.campaign'] ?? ''}
                  value={openSlot.campaignName}
                  testId="calendar-slot-campaign"
                />
              ) : null}
              <SlotFact
                term={t['calendar.publishState'] ?? ''}
                value={openSlot.statusLabel}
                testId="calendar-slot-status"
              />
              {openSlot.approvalLabel ? (
                <SlotFact
                  term={t['calendar.approvalState'] ?? ''}
                  value={openSlot.approvalLabel}
                  testId="calendar-slot-approval"
                />
              ) : null}
              {openSlot.mediaCount > 0 ? (
                <SlotFact
                  term={t['calendar.media'] ?? ''}
                  value={String(openSlot.mediaCount)}
                  testId="calendar-slot-media"
                />
              ) : null}
              {openSlot.readiness ? (
                <SlotFact
                  term={t['calendar.readiness'] ?? ''}
                  value={openSlot.readiness.label}
                  testId="calendar-slot-readiness"
                />
              ) : null}
            </dl>

            {/*
              WHAT IS IN THE WAY, AND WHERE TO FIX IT.

              `StateMessage` rather than a bespoke panel — the design system's
              own inline notice, already used on this screen for the empty
              draft list (UI-fidelity contract §6.2 rule 4: reuse before
              creating). NOT a colour literal and not a new treatment.

              One line per blocked channel, naming the channel and what is
              wrong with it. The account's own name is appended only when the
              server sent one, which it does only for a reader holding
              `integrations.read`.
            */}
            {openSlot.readiness?.blocking ? (
              <Banner tone="warning" testId="calendar-slot-readiness-detail">
                <ul style={{ margin: 0, paddingInlineStart: spacingTokens.md }}>
                  {openSlot.readiness.channels.map((channel) => (
                    <li key={channel.platformKey}>
                      {channel.accountName
                        ? `${channel.platformKey} · ${channel.label} — ${channel.accountName}`
                        : `${channel.platformKey} · ${channel.label}`}
                    </li>
                  ))}
                </ul>
              </Banner>
            ) : null}

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

/** One `term: value` row in the slot dialog's fact list. */
function SlotFact({
  term,
  value,
  testId,
}: {
  readonly term: string;
  readonly value: string;
  readonly testId?: string;
}) {
  return (
    <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
      <dt style={{ ...typographyTokens.caption, color: colorTokens.textMuted, margin: 0 }}>
        {term}
      </dt>
      <dd
        data-testid={testId}
        style={{ ...typographyTokens.bodySm, color: colorTokens.textPrimary, margin: 0 }}
      >
        {value}
      </dd>
    </div>
  );
}
