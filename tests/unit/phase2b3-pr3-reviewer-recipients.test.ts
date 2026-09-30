import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reviewReminderChoice } from '@brandspace/content';

/**
 * PHASE 2B-3 PR 3 — WHO A REVIEW REMINDER GOES TO, as a pure choice over the
 * eligible reviewers asked at run time (report §5).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('reviewReminderChoice', () => {
  it('the assignee alone, while they are still eligible', () => {
    expect(reviewReminderChoice({ eligible: ['a', 'b', 'c'], assignedToUserId: 'b' })).toEqual([
      'b',
    ]);
  });

  it('an assignee no longer eligible is never used: every eligible reviewer instead', () => {
    expect(reviewReminderChoice({ eligible: ['a', 'c'], assignedToUserId: 'b' })).toEqual([
      'a',
      'c',
    ]);
  });

  it('unassigned: every eligible reviewer, in the order they were found', () => {
    expect(reviewReminderChoice({ eligible: ['c', 'a'], assignedToUserId: null })).toEqual([
      'c',
      'a',
    ]);
  });

  it('nobody eligible: nobody — the action ends BLOCKED no_eligible_reviewer', () => {
    expect(reviewReminderChoice({ eligible: [], assignedToUserId: 'b' })).toEqual([]);
    expect(reviewReminderChoice({ eligible: [], assignedToUserId: null })).toEqual([]);
  });
});

describe('the reminder never looks people up by permission alone', () => {
  it('uses the approvals service’s reviewer rule, never resolveRecipients (F6 stays open)', () => {
    const service = readFileSync(path.join(root, 'packages/content/src/approvals.ts'), 'utf8');
    const method = service.slice(
      service.indexOf('async reviewReminderRecipients('),
      service.indexOf('async defaultReviewer('),
    );
    expect(method).toContain('this.eligibleReviewers(');
    expect(method).toContain('requestedByUserId');
    expect(method).toContain('createdByUserId');

    const worker = readFileSync(
      path.join(root, 'apps/worker/src/processors/automation.ts'),
      'utf8',
    );
    const port = worker.slice(
      worker.indexOf('async remindReviewers('),
      worker.indexOf('async submitForApproval('),
    );
    expect(port).toContain('reviewReminderRecipients(');
    expect(port).toContain("'approval.reminder'");
    expect(port).not.toContain('resolveRecipients');
  });
});
