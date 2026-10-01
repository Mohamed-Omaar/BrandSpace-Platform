import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PUBLISH_DEADLINE_PASSED_REASON,
  publishJobPastDeadline,
  retryableAfterReconnect,
} from '@brandspace/social-connectors';
import { optionalMessage, statusMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * D-332 (OWNER DECISION, PR #47) — AN EXPLICIT RETRY NEVER PUBLISHES LATE.
 * The rules as rules; the database half is
 * `tests/isolation/phase2b1-reconnect-hold.test.ts` and the screen is
 * `tests/e2e/phase6-publishing.spec.ts`.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('D-332 · the refusal', () => {
  it('is a CONFLICT with a machine-readable reason, never matched on its message', () => {
    expect(publishJobPastDeadline()).toMatchObject({
      code: 'CONFLICT',
      publicDetails: { reason: PUBLISH_DEADLINE_PASSED_REASON },
    });
    const actions = read('apps/dashboard/src/app/[locale]/integrations/actions.ts');
    expect(actions).toContain("error.publicDetails['reason'] === PUBLISH_DEADLINE_PASSED_REASON");
    expect(actions).toContain("return 'PUBLISH_DEADLINE_PASSED';");
  });

  it('both retry paths check the deadline before anything is written', () => {
    const source = read('packages/social-connectors/src/publishing.ts');
    const retry = source.slice(
      source.indexOf('  async retry(input'),
      source.indexOf('  async retryOnReconnectedAccount('),
    );
    const reconnected = source.slice(
      source.indexOf('  async retryOnReconnectedAccount('),
      source.indexOf('  async reconnectedRetryable('),
    );
    for (const body of [retry, reconnected]) {
      // The job's write — `update(` or, since PR 5, the conditional `updateMany(`.
      const write = body.search(/publishJob\.update(Many)?\(/);
      expect(write).toBeGreaterThan(0);
      const check = body.indexOf('throw publishJobPastDeadline()');
      expect(check).toBeGreaterThan(0);
      expect(check).toBeLessThan(write);
      // Item 9 (D-332 amended): and a post scheduled again is never retried.
      const superseded = body.indexOf('throw publishJobSuperseded()');
      expect(superseded).toBeGreaterThan(0);
      expect(superseded).toBeLessThan(write);
    }
  });
});

describe('D-332 · what the screen says, in both languages', () => {
  it('the owner’s words for a post whose time passed while its account was disconnected', () => {
    expect(optionalMessage('en', 'publishing.late.disconnected')).toBe(
      'This post’s time passed while the account was disconnected, so it wasn’t published late. Make a new copy to schedule it again.',
    );
    expect(optionalMessage('ar', 'publishing.late.disconnected')).toBe(
      'مضى موعد هذا المنشور أثناء انفصال الحساب، لذا لم يُنشر متأخرًا. أنشئ نسخة جديدة منه لجدولته مرة أخرى.',
    );
  });

  it('the owner-approved neutral line, in formal Arabic like the rest of the product', () => {
    expect(optionalMessage('en', 'publishing.late.passed')).toBe(
      'This post’s time has passed, so it won’t be published late. Make a new copy to schedule it again.',
    );
    expect(optionalMessage('ar', 'publishing.late.passed')).toBe(
      'مضى موعد هذا المنشور، لذا لن يُنشر متأخرًا. أنشئ نسخة جديدة منه لجدولته مرة أخرى.',
    );
  });

  it('every new line exists in ar and en, and points at "Make a new copy"', () => {
    for (const key of ['publishing.late.disconnected', 'publishing.late.passed']) {
      expect(optionalMessage('en', key), key).toMatch(/Make a new copy/);
      expect(optionalMessage('ar', key), key).toMatch(/نسخة جديدة/);
    }
    expect(statusMessage('PUBLISH_DEADLINE_PASSED', 'en')).toMatch(/won’t be published late/);
    expect(statusMessage('PUBLISH_DEADLINE_PASSED', 'ar')).toMatch(/[؀-ۿ]/);
    expect(optionalMessage('en', 'content.action.duplicate')).toBe('Make a new copy');
  });

  it('Phase 2B-2b — beside Reschedule, the owner’s new words, in both languages', () => {
    expect(optionalMessage('en', 'publishing.late.passedReschedule')).toBe(
      'This post’s time has passed, so it wasn’t published late. Reschedule it or make a new copy.',
    );
    expect(optionalMessage('en', 'publishing.late.disconnectedReschedule')).toBe(
      'This post’s time passed while the account was disconnected, so it wasn’t published late. Reschedule it or make a new copy.',
    );
    expect(optionalMessage('ar', 'publishing.late.passedReschedule')).toBe(
      'مضى موعد هذا المنشور، لذا لم يُنشر متأخرًا. أعد جدولته أو أنشئ نسخة جديدة منه.',
    );
    expect(optionalMessage('ar', 'publishing.late.disconnectedReschedule')).toBe(
      'مضى موعد هذا المنشور أثناء انفصال الحساب، لذا لم يُنشر متأخرًا. أعد جدولته أو أنشئ نسخة جديدة منه.',
    );
  });

  it('Phase 2B-2b — the new words only where Reschedule or "Send for review again" is offered', () => {
    const read = (file: string) => readFileSync(file, 'utf8');
    const publishing = read('apps/dashboard/src/app/[locale]/publishing/page.tsx');
    // The same condition decides the words and the button.
    expect(publishing).toContain('publishingRescheduleOffered({');
    expect(publishing).toContain('{rescheduleOffered ? (');
    // The Integrations page offers no Reschedule, so it keeps the earlier words.
    const integrations = read('apps/dashboard/src/app/[locale]/integrations/page.tsx');
    expect(integrations).toContain("'publishing.late.disconnected' : 'publishing.late.passed'");
    expect(integrations).not.toContain('Reschedule');
    // The post page follows the editor (every case: tests/unit/late-notice.test.ts).
    const post = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');
    expect(post).toContain('rescheduleOffered: postPageRescheduleOffered({');
  });

  it('the account wording is used exactly for an account failure', () => {
    expect(retryableAfterReconnect({ failureClass: 'AUTH_REVOKED', failureCode: null })).toBe(true);
    expect(
      retryableAfterReconnect({
        failureClass: 'NOT_CONNECTED',
        failureCode: 'preflight.reconnect_required',
      }),
    ).toBe(true);
    expect(retryableAfterReconnect({ failureClass: 'CONTENT_REJECTED', failureCode: null })).toBe(
      false,
    );
  });

  /*
   * D-332 AS AMENDED (Phase 2B-2, item 9, owner's Option 1). The original rule
   * — "no Reschedule and no Publish now" — was the state before the follow-up
   * the owner decided: a late failed post now also offers RESCHEDULE, which
   * schedules the same post again as a new slot (never "publish now", never
   * late). Retry stays hidden for the late case and for a post already
   * scheduled again; "Make a new copy" stays.
   */
  it('a late failed post offers Reschedule and "Make a new copy", never Publish now, and no Retry', () => {
    const page = read('apps/dashboard/src/app/[locale]/publishing/page.tsx');
    expect(page).not.toMatch(/publishNow|publish-now/i);
    expect(page).toContain('!lateNotice &&');
    expect(page).toContain('!superseded &&');
    expect(page).toContain('action={duplicateContentAction}');
    // Reschedule: only beside the late notice, only for a FAILED post (nothing
    // published), only for a member who may schedule; the calendar's dialog,
    // or the post to send it for review again where approval is required.
    // The condition is named once (`publishingRescheduleOffered`, Phase 2B-2b)
    // so the same rule decides both the button and the notice's words.
    expect(page).toContain('publishingRescheduleOffered({');
    const rule = readFileSync('apps/dashboard/src/server/late-notice.ts', 'utf8');
    const publishingRule = rule.slice(rule.indexOf('export function publishingRescheduleOffered'));
    expect(publishingRule).toContain('input.itemStatus === RESCHEDULABLE');
    expect(publishingRule).toContain("input.permissionKeys.includes('content.schedule')");
    expect(rule).toContain("const RESCHEDULABLE = 'FAILED';");
    const reschedule = page.slice(
      page.indexOf('{rescheduleOffered ? ('),
      page.indexOf("{lateNotice && may('content.create')"),
    );
    expect(reschedule).toContain('href={`/${locale}/calendar?item=${job.contentItemId}`}');
    expect(reschedule).toContain('href={`/${locale}/content/compose?item=${job.contentItemId}`}');
    expect(reschedule.match(/data-testid=\{`reschedule-\$\{job\.id\}`\}/g)).toHaveLength(2);
  });
});
