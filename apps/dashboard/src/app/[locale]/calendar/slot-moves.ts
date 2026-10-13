/**
 * WHETHER ONE PLAN ON THE CALENDAR CAN MOVE, AND WHETHER THE CALENDAR SAYS
 * POSTS CAN BE DRAGGED — one rule for the drag, the drop, the chip, the
 * drawer's Date/Time/Move and the footer line, so they cannot disagree.
 *
 *   - scheduling is offered at all: the member may schedule AND at least one
 *     channel can be connected (Q8, D-510);
 *   - the plan has not started going out (B-4: PLANNED or SCHEDULED);
 *   - the plan is not HELD (D-531): none of its channels can be connected, so
 *     a move would be refused by the server anyway.
 *
 * Pure, so it is tested as a rule (`tests/unit/connectors-b-calendar-held.test.ts`).
 */
export function slotMovable(input: {
  readonly canSchedule: boolean;
  readonly reschedulable?: boolean | undefined;
  readonly held?: boolean | undefined;
}): boolean {
  return input.canSchedule && input.reschedulable !== false && input.held !== true;
}

/**
 * The footer line "drag any post to another day" is shown only while dragging
 * is offered at all — never while no channel can be connected.
 */
export function dragHintShown(canSchedule: boolean): boolean {
  return canSchedule;
}
