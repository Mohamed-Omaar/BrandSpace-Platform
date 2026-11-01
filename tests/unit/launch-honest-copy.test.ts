import { describe, expect, it } from 'vitest';
import { validateConfiguration } from '@brandspace/config';
import { trialHasEndedFor } from '@brandspace/entitlements';
import { messages } from '../../apps/dashboard/src/i18n/messages';
import { legalDocument } from '../../apps/dashboard/src/legal/documents';

/*
 * CHECK-UP 2026-10-28 M-5, M-4 AND M-9: WHAT THE PRODUCT SAYS MATCHES WHAT IT DOES.
 *
 * M-5 (D-584): at trial end the workspace is read-only — view and export only,
 * no new posts, no publishing, no AI, nothing deleted. Onboarding, the trial
 * banner on Plan & billing and the Terms say exactly that, in en and ar.
 * M-4 (D-585): until a purge exists, deletion closes the workspace and points
 * to privacy@brandspace.cc for erasure; nothing promises automatic erasure.
 * M-9 (D-586): turning maintenance mode on is flagged "Not active yet".
 */

function text(doc: ReturnType<typeof legalDocument>): string {
  return doc.sections
    .flatMap((section) => section.body)
    .flatMap((block) => (typeof block === 'string' ? [block] : block.list))
    .join('\n');
}

describe('D-584 — the trial-end rule', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  it('EXPIRED, or TRIALING past its end, is ended; anything else is not', () => {
    expect(trialHasEndedFor({ status: 'EXPIRED', trialEndsAt: null }, now)).toBe(true);
    expect(
      trialHasEndedFor({ status: 'TRIALING', trialEndsAt: new Date('2026-11-01T11:59:59Z') }, now),
    ).toBe(true);
    expect(
      trialHasEndedFor({ status: 'TRIALING', trialEndsAt: new Date('2026-11-02T00:00:00Z') }, now),
    ).toBe(false);
    expect(trialHasEndedFor({ status: 'ACTIVE', trialEndsAt: new Date(0) }, now)).toBe(false);
    expect(trialHasEndedFor({ status: 'PAST_DUE', trialEndsAt: null }, now)).toBe(false);
    expect(trialHasEndedFor(null, now)).toBe(false);
  });

  it.each([
    ['en', 'read-only', 'export', 'Nothing is deleted'],
    ['ar', 'للعرض فقط', 'تصديره', 'لا يُحذف أي شيء'],
  ] as const)(
    '%s: onboarding, the trial banner and the Terms say the same rule',
    (locale, ro, exp, kept) => {
      const m = messages[locale];
      for (const line of [
        m['createWorkspace.trialNotice'],
        m['billing.trialEndRule'],
        m['billing.trialEnded'],
        text(legalDocument('terms', locale)),
      ]) {
        expect(line).toContain(ro);
        expect(line).toContain(exp);
        expect(line).toContain(kept);
      }
      // The old promises are gone.
      expect(text(legalDocument('terms', locale))).not.toMatch(/nothing is locked|لا يُقفل شيء/);
      expect(m['createWorkspace.trialNotice']).not.toMatch(/paid features stop|المزايا المدفوعة/);
    },
  );
});

describe('D-585 — deletion promises no automatic erasure', () => {
  it.each(['en', 'ar'] as const)(
    '%s: every deletion text points to privacy@brandspace.cc',
    (locale) => {
      const m = messages[locale];
      for (const line of [
        m['data.workspaceDeletion.body'],
        m['data.workspaceDeletion.warning'],
        m['deletion.body'],
      ]) {
        expect(line).toContain('privacy@brandspace.cc');
      }
      expect(m['deletion.body']).not.toMatch(/will be deleted|ستُحذف/);
      const deletion = text(legalDocument('data-deletion', locale));
      expect(deletion).toContain('privacy@brandspace.cc');
      expect(deletion).not.toMatch(/everything in it is deleted|تُحذف مساحة العمل وكل ما فيها/);
    },
  );

  it('en says the owner sentence exactly', () => {
    expect(messages.en['data.workspaceDeletion.body']).toContain(
      'Your workspace is closed. To have its data permanently erased, contact privacy@brandspace.cc.',
    );
  });
});

describe('D-586 — maintenance mode is labelled "Not active yet"', () => {
  it('turning it on warns, and leaving it off does not', () => {
    const on = validateConfiguration('operations', { maintenanceMode: { enabled: true } });
    expect(on.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        path: 'maintenanceMode.enabled',
        message: expect.stringContaining('Not active yet'),
      }),
    );
    const off = validateConfiguration('operations', {});
    expect(off.issues.some((issue) => issue.path === 'maintenanceMode.enabled')).toBe(false);
  });
});
