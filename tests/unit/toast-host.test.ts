import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  TOAST_MAX_MS,
  TOAST_MIN_MS,
  TOAST_RESUME_MS,
  toastDuration,
} from '../../packages/ui/src/toast-timing';
import { messages, successFlash } from '../../apps/dashboard/src/i18n/messages';

/**
 * C8 / MO9 (Phase 2B-2b, D8) — the toast host, as rules. The browser half —
 * the toast appearing, `ok` leaving the URL, refresh not replaying it, hover
 * holding it, the next navigation closing it — is
 * `tests/e2e/prototype-v90-phase2b2b-shell.spec.ts`.
 */

describe('reading time: 2.5 s + 55 ms per character, between 4 s and 9 s', () => {
  it('a short message stays the 4 s minimum', () => {
    expect(toastDuration('Saved.')).toBe(TOAST_MIN_MS);
    expect(toastDuration('')).toBe(4_000);
  });

  it('in between, it is exactly the formula', () => {
    const text = 'x'.repeat(40);
    expect(toastDuration(text)).toBe(2_500 + 55 * 40);
    expect(toastDuration('Your publishing settings were saved.')).toBe(2_500 + 55 * 36);
  });

  it('a long message stops at the 9 s maximum', () => {
    expect(toastDuration('x'.repeat(200))).toBe(TOAST_MAX_MS);
    expect(TOAST_MAX_MS).toBe(9_000);
  });

  it('counts characters, not UTF-16 units, and Arabic like any other script', () => {
    expect(toastDuration('😀'.repeat(40))).toBe(2_500 + 55 * 40);
    expect(toastDuration('ح'.repeat(40))).toBe(2_500 + 55 * 40);
  });

  it('leaving a held toast resumes with 2.2 s to go', () => {
    expect(TOAST_RESUME_MS).toBe(2_200);
  });
});

describe('successFlash', () => {
  it('is the banner’s words, in both languages, and nothing for an unknown code', () => {
    expect(successFlash('SETTINGS_SAVED', 'en')).toMatchObject({ tone: 'success' });
    expect(successFlash('SETTINGS_SAVED', 'ar')?.message).toMatch(/[؀-ۿ]/);
    expect(successFlash('NOT_A_CODE', 'en')).toBeUndefined();
    expect(successFlash(null, 'en')).toBeUndefined();
  });

  it('the dismiss label exists in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      expect((messages[locale] as Record<string, string>)['toast.dismiss'], locale).toBeTruthy();
    }
  });
});

describe('the flows touched by Phase 2B-2a and 2B-2b say "done" with a toast', () => {
  const read = (file: string) => readFileSync(file, 'utf8');
  const pages = [
    'settings/publishing',
    'settings/ai',
    'content/compose',
    'calendar',
    'publishing',
    'campaigns',
    'campaigns/[campaignId]',
    'automations',
  ];

  it.each(pages)('%s hands its ?ok= to the shell and draws no success banner', (page) => {
    const source = read(`apps/dashboard/src/app/[locale]/${page}/page.tsx`);
    expect(source).toMatch(/flash=\{successFlash\((ok|single\('ok'\)), locale\)\}/);
    expect(source).not.toContain('<CustomerBanner tone="success">');
  });

  it('the shell has exactly one host, and the host cleans the URL', () => {
    const shell = read('apps/dashboard/src/components/workspace-shell.tsx');
    expect(shell.match(/<ToastHost /g)).toHaveLength(1);
    const host = read('packages/ui/src/toast-host.tsx');
    expect(host).toContain('rest.delete(consume);');
    expect(host).toContain('window.history.replaceState(');
    // One toast system: nothing else in the dashboard renders a Toast.
    expect(read('apps/dashboard/src/components/workspace-shell.tsx')).not.toContain('<Toast ');
  });
});
