import type { MessageKey } from '../i18n/messages';

/**
 * D-332 / D-345 — WHICH WORDS A LATE, FAILED POST'S NOTICE USES.
 *
 * Where the screen actually offers a way on beside the notice — Reschedule, or
 * "Send for review again" where the brand requires approval — the notice names
 * it: "Reschedule it or make a new copy." Everywhere else the owner's earlier
 * words stay. The two screens that show the notice gate their buttons slightly
 * differently, so each has its own "is it offered?" and both share the choice
 * of words. Pure functions, so every case is tested without a page.
 */

/** Nothing published: the only state in which a post can be scheduled again. */
const RESCHEDULABLE = 'FAILED';

/**
 * THE POST PAGE follows the editor's own buttons: Reschedule for a member with
 * `content.schedule` where the brand needs no approval; sending it for review
 * again for a member with `content.submit` where it does. A post with anything
 * published (PARTIALLY_PUBLISHED) is never offered either.
 */
export function postPageRescheduleOffered(input: {
  readonly itemStatus: string;
  readonly requiresApproval: boolean;
  readonly permissionKeys: readonly string[];
}): boolean {
  if (input.itemStatus !== RESCHEDULABLE) return false;
  return input.permissionKeys.includes(
    input.requiresApproval ? 'content.submit' : 'content.schedule',
  );
}

/**
 * THE PUBLISHING ROW shows Reschedule — or, where approval is required, a link
 * to the post to send it for review again — to a member with
 * `content.schedule`, for a post with nothing published.
 */
export function publishingRescheduleOffered(input: {
  readonly itemStatus: string | undefined;
  readonly permissionKeys: readonly string[];
}): boolean {
  return input.itemStatus === RESCHEDULABLE && input.permissionKeys.includes('content.schedule');
}

/** The words, from whether the account was disconnected and whether a way on is offered. */
export function lateNoticeKey(input: {
  readonly disconnected: boolean;
  readonly rescheduleOffered: boolean;
}): MessageKey {
  if (input.disconnected) {
    return input.rescheduleOffered
      ? 'publishing.late.disconnectedReschedule'
      : 'publishing.late.disconnected';
  }
  return input.rescheduleOffered ? 'publishing.late.passedReschedule' : 'publishing.late.passed';
}
