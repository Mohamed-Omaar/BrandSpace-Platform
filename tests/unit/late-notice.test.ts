import { describe, expect, it } from 'vitest';
import {
  lateNoticeKey,
  postPageRescheduleOffered,
  publishingRescheduleOffered,
} from '../../apps/dashboard/src/server/late-notice';
import { optionalMessage } from '../../apps/dashboard/src/i18n/messages';

/**
 * D-332 / D-345 (Phase 2B-2b, item 11) — WHICH WORDS A LATE, FAILED POST'S
 * NOTICE USES, decided without a page. The new words appear exactly where a
 * Reschedule or "Send for review again" button is shown beside the notice.
 */

const NEW = {
  en: 'This post’s time has passed, so it wasn’t published late. Reschedule it or make a new copy.',
  ar: 'مضى موعد هذا المنشور، لذا لم يُنشر متأخرًا. أعد جدولته أو أنشئ نسخة جديدة منه.',
};
const NEW_DISCONNECTED = {
  en: 'This post’s time passed while the account was disconnected, so it wasn’t published late. Reschedule it or make a new copy.',
  ar: 'مضى موعد هذا المنشور أثناء انفصال الحساب، لذا لم يُنشر متأخرًا. أعد جدولته أو أنشئ نسخة جديدة منه.',
};
const OLD = {
  en: 'This post’s time has passed, so it won’t be published late. Make a new copy to schedule it again.',
  ar: 'مضى موعد هذا المنشور، لذا لن يُنشر متأخرًا. أنشئ نسخة جديدة منه لجدولته مرة أخرى.',
};
const OLD_DISCONNECTED = {
  en: 'This post’s time passed while the account was disconnected, so it wasn’t published late. Make a new copy to schedule it again.',
  ar: 'مضى موعد هذا المنشور أثناء انفصال الحساب، لذا لم يُنشر متأخرًا. أنشئ نسخة جديدة منه لجدولته مرة أخرى.',
};

/** The post page's whole decision, as the page makes it, in one locale. */
function postPageNotice(
  locale: 'en' | 'ar',
  input: {
    itemStatus?: string;
    requiresApproval: boolean;
    permissionKeys: string[];
    disconnected?: boolean;
  },
): string | null {
  return optionalMessage(
    locale,
    lateNoticeKey({
      disconnected: input.disconnected ?? false,
      rescheduleOffered: postPageRescheduleOffered({
        itemStatus: input.itemStatus ?? 'FAILED',
        requiresApproval: input.requiresApproval,
        permissionKeys: input.permissionKeys,
      }),
    }),
  );
}

describe.each(['en', 'ar'] as const)('the post page, in %s', (locale) => {
  it('1 · no approval needed and content.schedule — Reschedule is shown: the new words', () => {
    expect(
      postPageNotice(locale, { requiresApproval: false, permissionKeys: ['content.schedule'] }),
    ).toBe(NEW[locale]);
  });

  it('2 · approval required and content.submit — "Send for review again" is shown: the new words', () => {
    expect(
      postPageNotice(locale, { requiresApproval: true, permissionKeys: ['content.submit'] }),
    ).toBe(NEW[locale]);
  });

  it('3 · without the permission the offered button needs: the earlier words', () => {
    // No approval, so Reschedule would need content.schedule — submit alone is not it.
    expect(
      postPageNotice(locale, { requiresApproval: false, permissionKeys: ['content.submit'] }),
    ).toBe(OLD[locale]);
    // Approval required, so review would need content.submit — schedule alone is not it.
    expect(
      postPageNotice(locale, { requiresApproval: true, permissionKeys: ['content.schedule'] }),
    ).toBe(OLD[locale]);
    expect(postPageNotice(locale, { requiresApproval: false, permissionKeys: [] })).toBe(
      OLD[locale],
    );
  });

  it('4 · the account was disconnected: the new disconnected words, for either way on', () => {
    expect(
      postPageNotice(locale, {
        requiresApproval: false,
        permissionKeys: ['content.schedule'],
        disconnected: true,
      }),
    ).toBe(NEW_DISCONNECTED[locale]);
    expect(
      postPageNotice(locale, {
        requiresApproval: true,
        permissionKeys: ['content.submit'],
        disconnected: true,
      }),
    ).toBe(NEW_DISCONNECTED[locale]);
    // …and the earlier disconnected words where nothing is offered.
    expect(
      postPageNotice(locale, { requiresApproval: false, permissionKeys: [], disconnected: true }),
    ).toBe(OLD_DISCONNECTED[locale]);
  });

  it('5 · something already published — Reschedule is not available: the earlier words', () => {
    for (const disconnected of [false, true]) {
      expect(
        postPageNotice(locale, {
          itemStatus: 'PARTIALLY_PUBLISHED',
          requiresApproval: false,
          permissionKeys: ['content.schedule', 'content.submit'],
          disconnected,
        }),
      ).toBe(disconnected ? OLD_DISCONNECTED[locale] : OLD[locale]);
    }
  });
});

describe('the Publishing row', () => {
  it('offers a way on only for a post with nothing published, to a member who may schedule', () => {
    expect(
      publishingRescheduleOffered({ itemStatus: 'FAILED', permissionKeys: ['content.schedule'] }),
    ).toBe(true);
    expect(publishingRescheduleOffered({ itemStatus: 'FAILED', permissionKeys: [] })).toBe(false);
    expect(
      publishingRescheduleOffered({
        itemStatus: 'PARTIALLY_PUBLISHED',
        permissionKeys: ['content.schedule'],
      }),
    ).toBe(false);
    expect(
      publishingRescheduleOffered({ itemStatus: undefined, permissionKeys: ['content.schedule'] }),
    ).toBe(false);
  });
});
