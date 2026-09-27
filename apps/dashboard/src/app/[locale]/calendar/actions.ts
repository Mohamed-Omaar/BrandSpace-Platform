'use server';

import { revalidatePath } from 'next/cache';
import { redirect, unstable_rethrow } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import {
  CHANNEL_DISCONNECTED_REASON,
  SCHEDULE_IN_PAST_REASON,
  SLOT_MOVED_SINCE_REASON,
} from '@brandspace/content';
import { createLogger, internalErrorFields, isAppError } from '@brandspace/shared';
import { type WorkspaceSession, requireWorkspaceAction } from '../../../server/customer-context';
import { actionErrorCode } from '../../../server/denial';
import { inContentStudio } from '../../../server/content-context';
import { parseSlotMove } from '../../../server/calendar-move';
import { statusMessage } from '../../../i18n/messages';

const log = createLogger({ context: { component: 'dashboard.calendar' } });

/**
 * Content Calendar actions.
 *
 * THE WORKSPACE AND THE TIMEZONE ARE NEVER TAKEN FROM THE FORM.
 * `requireWorkspace()` reads the workspace from the session and re-verifies
 * membership, and the zone is read from the workspace row inside
 * `inContentStudio` — a timezone that arrived in a request body would let a
 * crafted POST schedule a post in a zone the workspace does not use, and the
 * stored intent would then mean something nobody chose.
 *
 * THE ITEM AND SLOT IDS *ARE* TAKEN FROM THE FORM, because the customer chooses
 * them. RLS, the composite foreign keys and the service's own brand-scope check
 * are what make a foreign one fail rather than succeed quietly.
 *
 * NOTHING HERE PUBLISHES (AC-14.7). There is no connector, no OAuth and no
 * outbound call in this file or anything it reaches.
 */

function pageUrl(locale: string, params: Record<string, string> = {}): string {
  const search = new URLSearchParams(params).toString();
  return `/${locale}/calendar${search ? `?${search}` : ''}`;
}

/**
 * B8 — where a Posts-menu action comes back to. A closed set: the library, or
 * the calendar (the default).
 */
function landing(locale: string, formData: FormData, params: Record<string, string>): string {
  if (formData.get('returnTo') === '/content') {
    const search = new URLSearchParams(params).toString();
    return `/${locale === 'ar' ? 'ar' : 'en'}/content${search ? `?${search}` : ''}`;
  }
  return pageUrl(locale, params);
}

/** Carry the month the customer was looking at through the redirect. */
function periodOf(formData: FormData): Record<string, string> {
  const month = String(formData.get('month') ?? '').trim();
  return /^\d{4}-\d{2}$/.test(month) ? { month } : {};
}

function failure(
  locale: string,
  error: unknown,
  action: string,
  extra: Record<string, string>,
): string {
  const correlationId = randomUUID();
  // The correlation id is the ONLY thing joining this screen to the server log,
  // and the log is redacted. No caption and no title is written either side.
  log.warn('calendar action failed', { correlationId, action, ...internalErrorFields(error) });
  return pageUrl(locale, { ...extra, error: calendarErrorCode(error), ref: correlationId });
}

/**
 * F2 — a time already past (earlier today included) gets its own words; the
 * reason is machine-readable, never matched on a message.
 */
function calendarErrorCode(error: unknown): string {
  if (isAppError(error) && error.publicDetails['reason'] === SCHEDULE_IN_PAST_REASON) {
    return 'SCHEDULE_IN_PAST';
  }
  // Q9 (D-332): every account for one of the post's channels was revoked.
  if (isAppError(error) && error.publicDetails['reason'] === CHANNEL_DISCONNECTED_REASON) {
    return CHANNEL_DISCONNECTED_REASON;
  }
  // §8.2: an Undo found the post somewhere else, so it changed nothing.
  if (isAppError(error) && error.publicDetails['reason'] === SLOT_MOVED_SINCE_REASON) {
    return 'SLOT_MOVED_SINCE';
  }
  return actionErrorCode(error);
}

function actorOf(session: WorkspaceSession) {
  return {
    actorUserId: session.customer.userId,
    actorBrandScope: session.workspace.brandScope,
  };
}

/** AC-14.1 — place a draft on the calendar at a chosen date and time. */
export async function scheduleContentAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const period = periodOf(formData);
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'content.schedule');
    const contentItemId = String(formData.get('contentItemId') ?? '');
    /*
     * The two halves of a wall-clock arrive as two fields, because that is what
     * `<input type="date">` and `<input type="time">` are — and they are the
     * right controls: each is localised and keyboard-operable by the browser,
     * which a hand-rolled picker would have to re-earn.
     */
    const date = String(formData.get('date') ?? '').trim();
    const time = String(formData.get('time') ?? '').trim();

    await inContentStudio(session.workspace.workspaceId, async ({ calendar }) =>
      (await calendar()).schedule({
        contentItemId,
        localTime: `${date}T${time}`,
        ...actorOf(session),
      }),
    );
    destination = pageUrl(locale, { ...period, ok: 'CONTENT_SCHEDULED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'schedule', period);
  }
  revalidatePath(`/${locale}/calendar`);
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}

/** AC-14.8 — move a slot to another date or time. */
export async function rescheduleContentAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const period = periodOf(formData);
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'content.schedule');
    const slotId = String(formData.get('slotId') ?? '');
    const date = String(formData.get('date') ?? '').trim();
    const time = String(formData.get('time') ?? '').trim();

    await inContentStudio(session.workspace.workspaceId, async ({ calendar }) =>
      (await calendar()).reschedule({
        slotId,
        localTime: `${date}T${time}`,
        ...actorOf(session),
      }),
    );
    destination = landing(locale, formData, { ...period, ok: 'CONTENT_RESCHEDULED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'reschedule', period);
    if (formData.get('returnTo') === '/content') {
      const failed = new URL(destination, 'http://x').searchParams;
      destination = landing(locale, formData, {
        error: failed.get('error') ?? '',
        ref: failed.get('ref') ?? '',
      });
    }
  }
  revalidatePath(`/${locale}/calendar`);
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}

/** What a dragged move, or its Undo, came to — for the toast the drag shows. */
export type MoveSlotResult =
  | { readonly ok: true; readonly status: string; readonly localTime: string }
  | { readonly ok: false; readonly message: string };

/**
 * §8.2 (Phase 2B-2b) — A POST DRAGGED TO ANOTHER DAY, OR THE UNDO OF THAT.
 *
 * THE SAME MOVE AS THE FORM ABOVE: the same `content.schedule` requirement,
 * the same `CalendarService.reschedule` — F2, quota, approval, B-4, brand and
 * workspace scope, the audit event — and nothing a drag may skip. Only the
 * transport differs: it answers with the outcome instead of redirecting, so
 * the calendar can say where the post went and offer Undo without leaving the
 * page. An Undo carries `expectedLocalTime` (the owner-approved precondition),
 * so a second Undo, or one racing another move, changes nothing.
 *
 * Nothing calls this while a pointer moves: only a committed drop does.
 */
export async function moveSlotAction(input: {
  readonly locale: string;
  readonly slotId: string;
  readonly date: string;
  readonly time: string;
  readonly expectedLocalTime?: string | undefined;
}): Promise<MoveSlotResult> {
  const locale = input.locale === 'ar' ? 'ar' : 'en';
  try {
    const session = await requireWorkspaceAction(locale, 'content.schedule');
    const move = parseSlotMove(input);
    if (!move) {
      return { ok: false, message: statusMessage('VALIDATION_FAILED', locale) ?? '' };
    }
    const moved = await inContentStudio(session.workspace.workspaceId, async ({ calendar }) =>
      (await calendar()).reschedule({
        slotId: move.slotId,
        localTime: `${move.date}T${move.time}`,
        ...actorOf(session),
        expectedLocalTime: move.expectedLocalTime,
      }),
    );
    revalidatePath(`/${locale}/calendar`);
    revalidatePath(`/${locale}/content`);
    return { ok: true, status: moved.slot.status, localTime: moved.slot.scheduledLocalTime };
  } catch (error: unknown) {
    // A session that has lapsed is Next.js control flow (a redirect), not a failure.
    unstable_rethrow(error);
    const correlationId = randomUUID();
    log.warn('calendar move failed', {
      correlationId,
      action: input.expectedLocalTime ? 'undo' : 'move',
      ...internalErrorFields(error),
    });
    return {
      ok: false,
      message: statusMessage(calendarErrorCode(error), locale, correlationId) ?? '',
    };
  }
}

/** AC-14.8 — take a slot off the calendar; the draft goes back to DRAFT. */
export async function cancelScheduleAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const period = periodOf(formData);
  let destination: string;
  try {
    const session = await requireWorkspaceAction(locale, 'content.schedule');
    const slotId = String(formData.get('slotId') ?? '');

    await inContentStudio(session.workspace.workspaceId, async ({ calendar }) =>
      (await calendar()).cancel({ slotId, ...actorOf(session) }),
    );
    destination = landing(locale, formData, { ...period, ok: 'CONTENT_UNSCHEDULED' });
  } catch (error: unknown) {
    destination = failure(locale, error, 'cancel', period);
    if (formData.get('returnTo') === '/content') {
      const failed = new URL(destination, 'http://x').searchParams;
      destination = landing(locale, formData, {
        error: failed.get('error') ?? '',
        ref: failed.get('ref') ?? '',
      });
    }
  }
  revalidatePath(`/${locale}/calendar`);
  revalidatePath(`/${locale}/content`);
  redirect(destination);
}
