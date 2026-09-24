import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CreditGrantSource,
  CreditTransactionType,
  InvitationStatus,
  MembershipStatus,
  WorkspaceStatus,
} from '@prisma/client';
import { ALL_PERMISSIONS } from '@brandspace/shared';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PHASE 6 · P6-14 — ARABIC AND RTL, AS RULES OVER THE WHOLE CUSTOMER APP.
 *
 * The existing guards were narrower than the product: the Arabic-copy check
 * covered Brand Brain keys only, and the physical-property scan covered
 * `packages/ui` only. Phase 6 added screens and copy across the dashboard, so
 * both now cover the dashboard as a whole — and a third rule pins the failure
 * the widened scan actually found: an accessible name written in English
 * directly in a component, which an Arabic screen reader reads out in English.
 */

const ROOT = path.resolve(__dirname, '../..');
const DASHBOARD = path.join(ROOT, 'apps/dashboard/src');

/**
 * A file that vanished between listing and reading is not a failure: the
 * boundary suites plant and delete `__*_probe.ts` files in these trees while
 * this suite scans them (the same race `design-system.test.ts` documents). A
 * missing file cannot contain what these scans look for, so it reads as empty.
 */
function readIfPresent(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function isDirectory(full: string): boolean {
  try {
    return statSync(full).isDirectory();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (isDirectory(full)) out.push(...sources(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments removed — a comment naming `marginLeft` is not a layout. */
function code(file: string): string {
  return readIfPresent(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The internal design-system reference page renders tokens and specimen copy
 * for the team, not customer-facing text; the i18n rule does not govern it.
 */
const customerFiles = sources(DASHBOARD).filter(
  (file) => !file.includes(`${path.sep}design-system${path.sep}`),
);

describe('P6-14 · every Arabic string is Arabic', () => {
  /**
   * Values that are legitimately the same in both languages. Empty since P6-16
   * removed the search control and its keyboard-shortcut glyph; anything added
   * here needs that kind of reason.
   */
  const SAME_IN_BOTH = new Set<string>();

  const en = messages.en as Record<string, string>;
  const ar = messages.ar as Record<string, string>;

  it('no Arabic value is a copy of the English one', () => {
    const copied = Object.keys(en).filter((key) => !SAME_IN_BOTH.has(key) && ar[key] === en[key]);
    expect(copied).toEqual([]);
  });

  it('every Arabic value contains Arabic script', () => {
    const latinOnly = Object.keys(ar).filter(
      (key) => !SAME_IN_BOTH.has(key) && !/[\u0600-\u06FF]/.test(ar[key] ?? ''),
    );
    expect(latinOnly).toEqual([]);
  });

  it('every placeholder in an English value survives into the Arabic one', () => {
    const lost: string[] = [];
    for (const key of Object.keys(en)) {
      const wanted = (en[key]!.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
      const got = (ar[key]?.match(/\{[a-zA-Z]+\}/g) ?? []).sort();
      if (wanted.join() !== got.join()) lost.push(`${key}: ${wanted.join()} vs ${got.join()}`);
    }
    expect(lost).toEqual([]);
  });
});

describe('P6-14 · the customer app lays out logically, never by side', () => {
  it('scans the dashboard (a guard on the scan itself)', () => {
    expect(customerFiles.length).toBeGreaterThan(100);
  });

  it('uses no physical left/right layout property anywhere', () => {
    const offenders: string[] = [];
    for (const file of customerFiles) {
      const match = code(file).match(
        /\b(marginLeft|marginRight|paddingLeft|paddingRight|borderLeft|borderRight|textAlign:\s*'(left|right)')\b/,
      );
      if (match) offenders.push(`${path.relative(ROOT, file)}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('P6-14 · no accessible name is written in English in a component', () => {
  /**
   * `BrandMark title="BrandSpace"` is the product's name, the same in both
   * languages. The Brand Brain key field's placeholder is an EXAMPLE of the
   * machine key it asks for, which is not translated because the key is not.
   */
  const ALLOWED = new Set(['title="BrandSpace"', 'placeholder="identity.positioning"']);

  it('aria-label, title, placeholder and alt come from the dictionary', () => {
    const offenders: string[] = [];
    for (const file of customerFiles.filter((f) => f.endsWith('.tsx'))) {
      for (const match of code(file).matchAll(
        /\b(aria-label|title|placeholder|alt)="([^"{]*[A-Za-z][^"]*)"/g,
      )) {
        if (!ALLOWED.has(match[0])) offenders.push(`${path.relative(ROOT, file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('P6-14 · the Permissions screen describes every permission in both languages', () => {
  const workspacePermissions = ALL_PERMISSIONS.filter((p) => p.minScope !== 'platform');
  const en = messages.en as Record<string, string>;
  const ar = messages.ar as Record<string, string>;

  it('has an Arabic and English description for every workspace permission', () => {
    expect(workspacePermissions.length).toBeGreaterThan(40);
    const missing = workspacePermissions
      .map((p) => `perms.desc.${p.key}`)
      .filter((key) => !en[key] || !ar[key]);
    expect(missing).toEqual([]);
  });

  it('the English description IS the catalogue description, so the two cannot drift', () => {
    for (const permission of workspacePermissions) {
      expect(en[`perms.desc.${permission.key}`], permission.key).toBe(permission.description);
    }
  });

  it('describes no permission the catalogue does not have', () => {
    const known = new Set(workspacePermissions.map((p) => `perms.desc.${p.key}`));
    const stale = Object.keys(en).filter((key) => key.startsWith('perms.desc.') && !known.has(key));
    expect(stale).toEqual([]);
  });
});

describe('P6-14 · credit history names each entry in the reader’s language', () => {
  it('every ledger kind the database can hold has a label in both languages', () => {
    const kinds = Object.values(CreditTransactionType);
    expect(kinds.length).toBeGreaterThan(5);
    for (const locale of ['en', 'ar'] as const) {
      const catalogue = messages[locale] as Record<string, string>;
      const missing = kinds.filter((kind) => !catalogue[`plan.ledgerType.${kind}`]);
      expect(missing, locale).toEqual([]);
    }
  });
});

describe('P6-15 · the Team screen names member and invitation states in words', () => {
  it('every membership and invitation status has a label in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const catalogue = messages[locale] as Record<string, string>;
      const missing = [
        ...Object.values(MembershipStatus).map((s) => `members.memberStatus.${s}`),
        ...Object.values(InvitationStatus).map((s) => `members.inviteStatus.${s}`),
      ].filter((key) => !catalogue[key]);
      expect(missing, locale).toEqual([]);
    }
  });

  it('the page renders the label, never the raw status', () => {
    const page = readFileSync(
      path.join(ROOT, 'apps/dashboard/src/app/[locale]/members/page.tsx'),
      'utf8',
    );
    expect(page).not.toMatch(/label=\{(m|i)\.status\}/);
  });
});

describe('P6-15 · Home and Plan name workspace state and credit sources in words', () => {
  it('every workspace status and grant source has a label in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      const catalogue = messages[locale] as Record<string, string>;
      const missing = [
        ...Object.values(WorkspaceStatus).map((s) => `overview.workspaceStatus.${s}`),
        ...Object.values(CreditGrantSource).map((s) => `plan.grantSource.${s}`),
      ].filter((key) => !catalogue[key]);
      expect(missing, locale).toEqual([]);
    }
  });
});
