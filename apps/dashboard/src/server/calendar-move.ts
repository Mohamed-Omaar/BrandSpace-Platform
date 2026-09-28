/**
 * §8.2 (Phase 2B-2b) — WHAT A DRAGGED MOVE, OR ITS UNDO, MAY ASK FOR.
 *
 * The drag calls `moveSlotAction` with an object rather than a form, so its
 * input is parsed here, at the boundary, before anything reaches the service:
 * a slot id, a date and a time in the calendar's own shapes, and — for an Undo
 * only — the local time the slot must still be at. Anything else is refused
 * whole. Pure, so every shape is tested.
 */
export interface SlotMove {
  readonly slotId: string;
  readonly date: string;
  readonly time: string;
  readonly expectedLocalTime?: string | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;
const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function parseSlotMove(input: unknown): SlotMove | null {
  if (typeof input !== 'object' || input === null) return null;
  const { slotId, date, time, expectedLocalTime } = input as Record<string, unknown>;
  if (typeof slotId !== 'string' || !UUID.test(slotId)) return null;
  if (typeof date !== 'string' || !DATE.test(date)) return null;
  if (typeof time !== 'string' || !TIME.test(time)) return null;
  if (expectedLocalTime !== undefined) {
    if (typeof expectedLocalTime !== 'string' || !LOCAL.test(expectedLocalTime)) return null;
    return { slotId, date, time, expectedLocalTime };
  }
  return { slotId, date, time };
}
