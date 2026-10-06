import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, Money, ROLE_DEFINITIONS, formatMoneyDisplay } from '@brandspace/shared';
import { OWNER_ONLY_PERMISSIONS, messages } from '../../apps/dashboard/src/i18n/messages';
import {
  GROUPED_PERMISSION_KEYS,
  PERMISSION_GROUPS,
  permissionGroups,
} from '../../apps/dashboard/src/server/permission-groups';

/**
 * REVIEW OF #68, ROUND 4, STEP 1 AND 2.1 — ONE CONTROL SYSTEM, ONE MONEY
 * DISPLAY, AND PERMISSIONS THAT ARE NEVER KEYS.
 */

const ROOT = join(__dirname, '..', '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '.next') return [];
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('1.1 · one button system on customer screens', () => {
  it('no customer screen draws the retired inline button', () => {
    // `apps/admin` (the Control Center) keeps its own look and the legacy
    // `buttonStyle`; `app-shell.tsx` is its shell. Everything else is the
    // prototype's `.btn` class system, through `buttonClass()`/`Button`.
    const customer = [
      ...files(join(ROOT, 'apps', 'dashboard', 'src')),
      ...files(join(ROOT, 'packages', 'ui', 'src')).filter(
        (path) => !/[\\/](primitives|app-shell)\.tsx$/.test(path),
      ),
    ];
    const offenders = customer
      .filter((path) => /\bbuttonStyle\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(ROOT, path));
    expect(offenders).toEqual([]);
  });
});

describe('1.8 · the customer money display', () => {
  const usd = (cents: number) => Money.ofMinor('USD', cents, 2);

  it('writes a whole price as the prototype does — `$79`, never `USD 79.00`', () => {
    expect(formatMoneyDisplay(usd(7900), 'en', { wholeUnits: true })).toBe('$79');
    expect(formatMoneyDisplay(usd(7900), 'ar', { wholeUnits: true })).toBe('$79');
  });

  it('keeps the cents on an invoice, and never rounds a fractional price', () => {
    expect(formatMoneyDisplay(usd(7900), 'en')).toBe('$79.00');
    expect(formatMoneyDisplay(usd(7950), 'en', { wholeUnits: true })).toBe('$79.50');
  });

  it('uses Western digits in Arabic too', () => {
    expect(formatMoneyDisplay(usd(123456), 'ar')).toMatch(/^[$0-9.,]+$/);
  });
});

describe('2.1 · roles & permissions, grouped as the prototype groups them', () => {
  const workspaceKeys = new Set(
    ALL_PERMISSIONS.filter((p) => p.minScope !== 'platform').map((p) => p.key),
  );

  it('names only real workspace permission keys — no new key is introduced', () => {
    for (const key of GROUPED_PERMISSION_KEYS) expect(workspaceKeys.has(key), key).toBe(true);
  });

  it('is the prototype’s seven groups and twenty actions', () => {
    expect(PERMISSION_GROUPS.map((group) => group.id)).toEqual([
      'content',
      'brandBrain',
      'media',
      'planning',
      'publishing',
      'data',
      'workspace',
    ]);
    expect(PERMISSION_GROUPS.flatMap((group) => group.actions)).toHaveLength(20);
  });

  it('has a plain-language label in both languages for every group, action and note', () => {
    const owner = ROLE_DEFINITIONS.find((role) => role.key === 'workspace_owner')!;
    for (const group of permissionGroups(owner.permissionKeys, OWNER_ONLY_PERMISSIONS)) {
      const keys = [
        group.title,
        ...group.rows.flatMap((row) => [row.label, ...(row.note ? [row.note] : [])]),
      ];
      for (const key of keys) {
        for (const locale of ['en', 'ar'] as const) {
          const text = (messages[locale] as Record<string, string>)[key];
          expect(text, `${locale} ${key}`).toBeTruthy();
          // A label is words, never a permission key.
          expect(workspaceKeys.has(text!), `${locale} ${key}`).toBe(false);
        }
      }
    }
  });

  it('states the role’s answer and changes no semantics', () => {
    for (const role of ROLE_DEFINITIONS.filter((r) => r.realm === 'workspace')) {
      const held = new Set(role.permissionKeys);
      for (const group of permissionGroups(role.permissionKeys, OWNER_ONLY_PERMISSIONS)) {
        for (const row of group.rows) {
          const action = PERMISSION_GROUPS.flatMap((g) => g.actions).find((a) => a.id === row.id)!;
          const on = action.keys.every((key) => held.has(key));
          expect(row.state === 'role', `${role.key} ${row.id}`).toBe(on);
        }
      }
    }
  });

  it('marks an owner-only action "Owner only" for a role without it', () => {
    const viewer = ROLE_DEFINITIONS.find((role) => role.key === 'client_viewer')!;
    const rows = permissionGroups(viewer.permissionKeys, OWNER_ONLY_PERMISSIONS).flatMap(
      (group) => group.rows,
    );
    const billing = rows.find((row) => row.id === 'billing.manage')!;
    expect(billing.state).toBe(
      OWNER_ONLY_PERMISSIONS.includes('billing.manage') ? 'ownerOnly' : 'none',
    );
    expect(rows.find((row) => row.id === 'content.create')!.state).toBe('none');
  });

  it('the permissions page renders no permission key', () => {
    const page = readFileSync(
      join(ROOT, 'apps', 'dashboard', 'src', 'app', '[locale]', 'permissions', 'page.tsx'),
      'utf8',
    );
    expect(page).not.toMatch(/<code>\{p\.key\}<\/code>/);
    expect(page).not.toMatch(/>\s*\{p\.key\}\s*</);
  });
});
