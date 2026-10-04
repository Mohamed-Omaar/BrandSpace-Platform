import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RESCHEDULABLE_ITEM_STATUS,
  SLOT_BUSY_JOB_STATUSES,
  liveSlotWhere,
} from '@brandspace/content';
import { publishJobSuperseded, PUBLISH_JOB_SUPERSEDED_REASON } from '@brandspace/social-connectors';
import { optionalMessage, statusMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * ITEM 9 (Phase 2B-2) — RESCHEDULE A FAILED POST (D-332 amended, the owner's
 * Option 1). The rules as rules; the database half is
 * `tests/isolation/reschedule-failed.test.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('the live slot', () => {
  it('is one rule: not cancelled, and a FAILED slot only while a job is busy or published', () => {
    expect(RESCHEDULABLE_ITEM_STATUS).toBe('FAILED');
    expect(liveSlotWhere('item')).toEqual({
      contentItemId: 'item',
      OR: [
        { status: { notIn: ['CANCELLED', 'FAILED'] } },
        {
          status: 'FAILED',
          publishJobs: { some: { status: { in: [...SLOT_BUSY_JOB_STATUSES] } } },
        },
      ],
    });
    expect([...SLOT_BUSY_JOB_STATUSES]).toContain('PUBLISHED');
    expect([...SLOT_BUSY_JOB_STATUSES]).not.toContain('FAILED');
  });

  it('the index migration swaps the predicate in one transaction, and says it is forward-only', () => {
    const sql = read(
      'packages/database/prisma/migrations/20261006130000_calendar_slot_live_excludes_failed/migration.sql',
    );
    expect(sql).toMatch(/BEGIN;\s+DROP INDEX "calendar_slot_one_live_per_item";/);
    expect(sql).toContain(`WHERE "status" NOT IN ('CANCELLED', 'FAILED');`);
    expect(sql).toMatch(/COMMIT;\s*$/);
    expect(read('docs/OPERATIONS.md')).toContain(
      '20261006130000_calendar_slot_live_excludes_failed',
    );
  });

  it('the library tray and the scheduler use the same rule (D11)', () => {
    const library = read('packages/content/src/library.ts');
    expect(library).not.toContain("notIn: ['CANCELLED', 'PUBLISHED', 'FAILED']");
    expect(library).toContain(
      'publishJobs: { some: { status: { in: [...SLOT_BUSY_JOB_STATUSES] } } }',
    );
    expect(read('apps/dashboard/src/app/[locale]/calendar/page.tsx')).toContain(
      "statuses: ['DRAFT', 'APPROVED', 'FAILED'],",
    );
  });
});

describe('schedule() and submit()', () => {
  it('schedule() accepts FAILED only with nothing published, and records the slot it replaces', () => {
    const calendar = read('packages/content/src/calendar.ts');
    expect(calendar).toContain('const rescheduling = item.status === RESCHEDULABLE_ITEM_STATUS;');
    expect(calendar).toContain("status: 'PUBLISHED' },");
    expect(calendar).toContain('replacesFailedSlotId: replaces.id');
    // A NEW slot is attempt 0: the old slot's attempt is never touched here.
    expect(calendar).toContain(
      'const usageIdempotencyKey = scheduleUsageKey(this.#workspaceId, slotId, 0);',
    );
  });

  it('the approval gate is unchanged, and submit() accepts FAILED for a new cycle', () => {
    const calendar = read('packages/content/src/calendar.ts');
    const gate = calendar.indexOf("item.status !== 'APPROVED'");
    const failedCheck = calendar.indexOf('const rescheduling = item.status');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(failedCheck);
    const approvals = read('packages/content/src/approvals.ts');
    expect(approvals).toContain('const fromFailed = item.status === RESCHEDULABLE_ITEM_STATUS;');
  });
});

describe('retry of a superseded attempt', () => {
  it('is a CONFLICT with a machine-readable reason, shown in both languages', () => {
    expect(publishJobSuperseded()).toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: PUBLISH_JOB_SUPERSEDED_REASON },
    });
    expect(statusMessage('PUBLISH_JOB_SUPERSEDED', 'en')).toMatch(/scheduled again/);
    expect(statusMessage('PUBLISH_JOB_SUPERSEDED', 'ar')).toMatch(/[؀-ۿ]/);
    expect(read('apps/dashboard/src/app/[locale]/integrations/actions.ts')).toContain(
      "return 'PUBLISH_JOB_SUPERSEDED';",
    );
  });
});

describe('the screens', () => {
  it('the post page shows the failed notice with Reschedule, review-again and Make a new copy', () => {
    const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
    expect(editor).toContain("{draft.status === 'FAILED' && failed ? (");
    expect(editor).toContain('href={`/${locale}/calendar?item=${draft.id}`}');
    expect(editor).toContain('data-testid="editor-failed-duplicate"');
    // Review of #67, round 2: the same condition, named once for the bar.
    expect(editor).toContain(
      "const mayReview = (draft.status === 'DRAFT' || draft.status === 'FAILED') && can.submit;",
    );
    const page = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');
    // D-332 wording, Phase 2B-2b (owner-approved): the notice names the way on
    // the editor offers this reader — decided by `postPageRescheduleOffered`
    // and `lateNoticeKey` (every case in tests/unit/late-notice.test.ts).
    // Replaces the pins on the single `translate('publishing.late.…')` calls
    // this page used to make.
    expect(page).toContain('lateNoticeKey({');
    expect(page).toContain('rescheduleOffered: postPageRescheduleOffered({');
    expect(page).toContain('itemStatus: draft.status,');
  });

  it('every new line exists in both languages', () => {
    for (const key of [
      'editor.failed.reschedule',
      'editor.failed.reviewAgain',
      'editor.failed.notLate',
      'publishing.reschedule',
      'publishing.resendForReview',
      'publishing.superseded',
    ]) {
      expect(optionalMessage('en', key), key).not.toBeNull();
      expect(optionalMessage('ar', key), key).toMatch(/[؀-ۿ]/);
    }
  });
});
