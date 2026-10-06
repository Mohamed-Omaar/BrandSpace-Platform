import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  comparableChange,
  deltaText,
  homeCreditGrant,
} from '../../apps/dashboard/src/server/home-prototype';
import {
  mediaStorageCategories,
  mediaStorageKeyFor,
  mediaStorageRemainder,
} from '../../apps/dashboard/src/server/media-storage';
import { messages } from '../../apps/dashboard/src/i18n/messages';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('Round 4 · 4.5 — a change only against a complete previous period', () => {
  it('is "—" when the previous 28 days were not measured from their first day', () => {
    expect(comparableChange(33_210, [null, null, 5, 7])).toBeNull();
    expect(deltaText(comparableChange(33_210, [null, 4])).text).toBe('—');
    expect(comparableChange(120, [])).toBeNull();
  });

  it('is the change when they were', () => {
    expect(comparableChange(120, [3, null, 4])).toBe(120);
    expect(deltaText(comparableChange(-80, [9])).text).toBe('↓ -8%');
  });

  it('is "—" when there is no change to show at all', () => {
    expect(comparableChange(null, [1, 2])).toBeNull();
  });
});

describe('Round 4 · 4.6 (review of 2a) — Home’s "of N" is the pinned monthly grant', () => {
  it('reads the subscription’s pinned grant, even for a plan the catalogue does not list', () => {
    expect(homeCreditGrant({ pinnedMonthlyCredits: 1_200 }, undefined)).toBe(1_200);
    expect(homeCreditGrant({ pinnedMonthlyCredits: 1_200 }, 500)).toBe(1_200);
  });

  it('falls back to the catalogue when nothing was pinned', () => {
    expect(homeCreditGrant({ pinnedMonthlyCredits: 0 }, 500)).toBe(500);
    expect(homeCreditGrant({ pinnedMonthlyCredits: 0 }, undefined)).toBeNull();
  });

  it('has no N without a subscription', () => {
    expect(homeCreditGrant(null, 500)).toBeNull();
  });
});

describe('Round 4 · 4.7 — the Media storage categories', () => {
  it('names a file by its persisted kind and source', () => {
    expect(mediaStorageKeyFor('IMAGE', 'UPLOAD')).toBe('photos');
    expect(mediaStorageKeyFor('IMAGE', 'IMPORTED')).toBe('photos');
    expect(mediaStorageKeyFor('VIDEO', 'UPLOAD')).toBe('videos');
    expect(mediaStorageKeyFor('IMAGE', 'AI_GENERATED')).toBe('ai');
    expect(mediaStorageKeyFor('DOCUMENT', 'UPLOAD')).toBe('brand');
    expect(mediaStorageKeyFor('FONT', 'UPLOAD')).toBe('brand');
  });

  it('regroups the meter rows into four, in the prototype order, with the files', () => {
    const view = mediaStorageCategories(
      [
        { category: 'ASSET', kind: 'IMAGE', source: 'UPLOAD', bytes: 1_000n },
        { category: 'ASSET', kind: 'IMAGE', source: 'AI_GENERATED', bytes: 300n },
        { category: 'ASSET', kind: 'VIDEO', source: 'UPLOAD', bytes: 5_000n },
        { category: 'ASSET', kind: 'DOCUMENT', source: 'UPLOAD', bytes: 40n },
        { category: 'BRAND_BRAIN', kind: null, source: null, bytes: 60n },
        { category: 'UPLOADING', kind: null, source: null, bytes: 999n },
      ],
      [
        { kind: 'IMAGE', source: 'UPLOAD', files: 4 },
        { kind: 'IMAGE', source: 'AI_GENERATED', files: 2 },
        { kind: 'VIDEO', source: 'UPLOAD', files: 1 },
        { kind: 'DOCUMENT', source: 'UPLOAD', files: 3 },
      ],
      5,
    );
    expect(view).toStrictEqual([
      { key: 'photos', bytes: 1_000, files: 4 },
      { key: 'videos', bytes: 5_000, files: 1 },
      { key: 'ai', bytes: 300, files: 2 },
      { key: 'brand', bytes: 100, files: 8 },
    ]);
  });

  it('adds up to the total it sits under: the counter beyond the four is one more part', () => {
    const four = [
      { key: 'photos', bytes: 1_000, files: 4 },
      { key: 'videos', bytes: 5_000, files: 1 },
      { key: 'ai', bytes: 300, files: 2 },
      { key: 'brand', bytes: 100, files: 8 },
    ] as const;
    // Kept equal by the product: nothing beyond the four.
    expect(mediaStorageRemainder(6_400, four)).toBe(0);
    // An upload in progress (or drift not yet recounted) is the rest, and the sum holds.
    const rest = mediaStorageRemainder(7_000, four);
    expect(rest).toBe(600);
    expect(four.reduce((sum, row) => sum + row.bytes, 0) + rest).toBe(7_000);
    // Never negative.
    expect(mediaStorageRemainder(10, four)).toBe(0);
  });

  it('is display only: it reads the meter rows and never the counter or BYTES_PER_GB', () => {
    const source = read('apps/dashboard/src/server/media-storage.ts');
    expect(source).not.toMatch(/BYTES_PER_GB\s*=/);
    expect(source).not.toMatch(/usageCounter|consumeBytes|refundBytes/);
  });

  it('has its words in both languages', () => {
    for (const key of ['photos', 'videos', 'ai', 'brand']) {
      expect(messages.en[`assets.storageCat.${key}` as keyof typeof messages.en]).toBeTruthy();
      expect(messages.ar[`assets.storageCat.${key}` as keyof typeof messages.ar]).toBeTruthy();
    }
  });
});

describe('Round 4 · 4.1 — sign-up', () => {
  const page = read('apps/dashboard/src/app/[locale]/(auth)/sign-up/page.tsx');

  it('has one password field (no confirmation) and still has Show', () => {
    expect(page).not.toContain('confirmLabel');
    expect(page).toContain("show: t('password.show')");
  });

  it('asks no zone: the browser’s is posted, and the server still refuses an empty one', () => {
    expect(page).not.toContain('SearchableSelect');
    expect(page).toContain('<BrowserTimeZoneInput />');
    expect(read('packages/auth/src/signup.ts')).toContain("'A timezone is required.'");
  });
});

describe('Round 4 · 4.3 — "Accept all" is the per-fact accept, in turn', () => {
  const actions = read('apps/dashboard/src/app/[locale]/onboarding/actions.ts');
  const start = actions.indexOf('export async function acceptAllSetupCandidatesAction');
  const body = actions.slice(start, actions.indexOf('\n}\n', start));

  it('needs the same permission and applies the same review per fact', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("requireWorkspaceAction(locale, 'brand_brain.review')");
    expect(body).toContain('applyCandidateReview(');
    expect(body).toContain("one.set('decision', 'accept')");
    expect(body).not.toMatch(/accept_edited|brandKnowledgeCandidate\.update/);
  });
});

describe('Round 4 · 4.2 / 4.4 — Settings and the rail', () => {
  it('hides the Brands row only for a single brand, keeping the route one link away', () => {
    const frame = read('apps/dashboard/src/components/settings-frame.tsx');
    expect(frame).toContain('listAccessibleBrands(brandSource)');
    expect(frame).toContain("item.key === 'brand' && selected !== 'brand'");
    expect(frame).toContain("labelKey: 'brand.profile'");
  });

  it('names the person from their own account, with Latin initials', () => {
    const shell = read('apps/dashboard/src/components/workspace-shell.tsx');
    expect(shell).toContain('const identity = personName || personEmail || workspaceName;');
    expect(shell).toContain('/[A-Za-z]/.test(personName)');
  });
});
