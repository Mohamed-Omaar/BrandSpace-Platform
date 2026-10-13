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

/**
 * D-531 (owner, #81) — A HELD POST IS LABELLED "HELD" («محجوز»), never
 * "Scheduled": the drawer preview's status pill takes the held label in place
 * of the scheduled one. Everything else in the labels is unchanged.
 */
export function heldPreviewLabels<
  L extends { readonly statusLabels: Readonly<Record<string, string>> },
>(labels: L, heldLabel: string): L {
  return { ...labels, statusLabels: { ...labels.statusLabels, SCHEDULED: heldLabel } };
}

/**
 * D-531 — a planned post is HELD when it has channels and none of them can be
 * connected (`connectable`: the platforms the publishing policy switches on).
 * It cannot go out, and every surface labels it "Held" (owner, #81): the
 * calendar's chip, popover, list and drawer, and Home's upcoming rows.
 */
export function heldSlot(platformKeys: readonly string[], connectable: readonly string[]): boolean {
  return platformKeys.length > 0 && !platformKeys.some((key) => connectable.includes(key));
}
