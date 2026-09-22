import { describe, expect, it } from 'vitest';
import { ROTATION_START, foldRotation, type RotationState } from '@brandspace/billing';

/**
 * WHAT "CLEAN" IS ALLOWED TO MEAN.
 *
 * The reconciliation pass reads the platform a page at a time and the scheduler
 * remembers where it got to. The clean record used to be written by whichever
 * page happened to FINISH the rotation, so this sequence was possible:
 *
 *   page 1 → drift   → CRITICAL
 *   page 2 → clean   → (nothing)
 *   page 3 → clean, exhausted → "reconciliation.clean"
 *
 * The CRITICAL survived, and the newest word on the platform's financial state
 * said everything was fine. An operator reading the audit log top-down would
 * have seen a green light over a red one.
 *
 * The decision is pure so every sequence that matters can be asserted here,
 * including that one. The scheduler's own suite proves it is this function that
 * decides what gets written.
 */

/** Feed a rotation a list of pages and collect what each one recorded. */
function replay(
  pages: ReadonlyArray<{ drifts: number; exhausted: boolean }>,
  from: RotationState = ROTATION_START,
): { records: string[]; state: RotationState } {
  let state = from;
  const records: string[] = [];
  for (const [index, page] of pages.entries()) {
    const result = foldRotation(state, {
      drifts: page.drifts,
      exhausted: page.exhausted,
      cursor: `cursor-${index}`,
    });
    state = result.next;
    records.push(result.record);
  }
  return { records, state };
}

describe('a clean record belongs to a rotation, not to a page', () => {
  it('THE DEFECT: drift on an early page and a clean final page records NO clean', () => {
    const { records } = replay([
      { drifts: 3, exhausted: false },
      { drifts: 0, exhausted: false },
      { drifts: 0, exhausted: true },
    ]);
    expect(records).toEqual(['drift', 'nothing', 'nothing']);
    // The whole point: the rotation that found drift says nothing clean at all.
    expect(records).not.toContain('rotation_clean');
  });

  it('a rotation with no drift anywhere records exactly one clean, at the end', () => {
    const { records } = replay([
      { drifts: 0, exhausted: false },
      { drifts: 0, exhausted: false },
      { drifts: 0, exhausted: true },
    ]);
    expect(records).toEqual(['nothing', 'nothing', 'rotation_clean']);
    expect(records.filter((record) => record === 'rotation_clean')).toHaveLength(1);
  });

  it('EVERY page that finds drift records it, wherever it falls', () => {
    const { records } = replay([
      { drifts: 1, exhausted: false },
      { drifts: 0, exhausted: false },
      { drifts: 2, exhausted: true },
    ]);
    expect(records).toEqual(['drift', 'nothing', 'drift']);
  });

  it('drift on the LAST page also suppresses the clean record', () => {
    const { records } = replay([
      { drifts: 0, exhausted: false },
      { drifts: 4, exhausted: true },
    ]);
    expect(records).toEqual(['nothing', 'drift']);
  });

  it('THE NEXT ROTATION STARTS CLEAN — one rotation is never described by another', () => {
    const dirty = replay([
      { drifts: 1, exhausted: false },
      { drifts: 0, exhausted: true },
    ]);
    expect(dirty.state).toEqual(ROTATION_START);

    // The very next rotation, with nothing wrong, says so.
    const { records } = replay([{ drifts: 0, exhausted: true }], dirty.state);
    expect(records).toEqual(['rotation_clean']);
  });

  it('a single-page rotation is still a whole rotation', () => {
    expect(replay([{ drifts: 0, exhausted: true }]).records).toEqual(['rotation_clean']);
    expect(replay([{ drifts: 1, exhausted: true }]).records).toEqual(['drift']);
  });

  it('carries the cursor while the rotation runs, and drops it when it ends', () => {
    const running = foldRotation(ROTATION_START, {
      drifts: 0,
      exhausted: false,
      cursor: 'workspace-9',
    });
    expect(running.next.cursor).toBe('workspace-9');

    const ended = foldRotation(running.next, { drifts: 0, exhausted: true, cursor: 'workspace-z' });
    expect(ended.next.cursor).toBeNull();
  });
});
