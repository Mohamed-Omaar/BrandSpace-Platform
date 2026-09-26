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
      const check = body.indexOf('throw publishJobPastDeadline()');
      expect(check).toBeGreaterThan(0);
      expect(check).toBeLessThan(body.indexOf('publishJob.update('));
    }
  });
});

describe('D-332 · what the screen says, in both languages', () => {
  it('the owner’s words for a post whose time passed while its account was disconnected', () => {
    expect(optionalMessage('en', 'publishing.late.disconnected')).toBe(
      'This post’s time passed while the account was disconnected, so it wasn’t published late. Make a new copy to schedule it again.',
    );
    expect(optionalMessage('ar', 'publishing.late.disconnected')).toBe(
      'عدّى معاد البوست والحساب مفصول، فمتنشرش متأخر. اعمل نسخة جديدة عشان تجدوله تاني.',
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

  it('no Reschedule and no Publish now were added; Retry is hidden for the late case', () => {
    const page = read('apps/dashboard/src/app/[locale]/publishing/page.tsx');
    expect(page).not.toMatch(/reschedule|publishNow|publish-now/i);
    expect(page).toContain('!lateNotice &&');
    expect(page).toContain('action={duplicateContentAction}');
  });
});
