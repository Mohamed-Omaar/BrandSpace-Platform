import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  OWNER_ONLY_PERMISSION_KEYS,
  ROLE_DEFINITIONS,
  isOwnerOnlyPermission,
} from '@brandspace/shared';
import { messages, statusMessage } from '../../apps/dashboard/src/i18n/messages';
import {
  actionErrorCode,
  deniedPermission,
  denialText,
  permissionDenied,
} from '../../apps/dashboard/src/server/denial';

/**
 * Prototype v90 alignment, Phase 2A (docs/PROTOTYPE-V76-ALIGNMENT.md §5.3) — the
 * screen halves of the permission and post-lifecycle items. The server halves
 * are proven against PostgreSQL in tests/isolation.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const both = (key: string) => {
  const en = (messages.en as Record<string, string>)[key];
  const ar = (messages.ar as Record<string, string>)[key];
  expect(en, `en:${key}`).toBeTruthy();
  expect(ar, `ar:${key}`).toBeTruthy();
  expect(en).not.toBe(ar);
};

function actionFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return actionFiles(full);
    return name === 'actions.ts' ? [full] : [];
  });
}

describe('A5 + E6 · a refusal names the permission and who can change it', () => {
  it('owner-only is exactly what the Owner holds and no other role does', () => {
    expect([...OWNER_ONLY_PERMISSION_KEYS].sort()).toEqual([
      'billing.manage',
      'workspace.delete',
      'workspace.transfer_ownership',
    ]);
    const others = ROLE_DEFINITIONS.filter(
      (r) => r.realm === 'workspace' && r.key !== 'workspace_owner',
    );
    for (const key of OWNER_ONLY_PERMISSION_KEYS) {
      expect(
        others.some((r) => r.permissionKeys.includes(key)),
        key,
      ).toBe(false);
    }
    expect(isOwnerOnlyPermission('member.invite')).toBe(false);
  });

  it('has every denial sentence in both languages', () => {
    for (const key of [
      'perms.denied.title',
      'perms.denied.body',
      'perms.denied.hint',
      'perms.denied.you',
      'perms.denied.hintOwner',
      'perms.denied.ownerOnly',
      'perms.denied.thisAction',
      'perms.fromRole',
    ]) {
      both(key);
    }
  });

  it('a page names the member, the permission and the owner', () => {
    const en = denialText('en', {
      permissionKey: 'member.invite',
      memberName: 'Sara',
      ownerName: 'Omar',
    });
    expect(en.body).toBe(
      "Sara doesn't have the “Invite a member” permission. " +
        'Permissions come from the role · ask Omar to change your role.',
    );
    expect(en.ownerOnly).toBe(false);
    const ar = denialText('ar', {
      permissionKey: 'member.invite',
      memberName: 'سارة',
      ownerName: 'عمر',
    });
    expect(ar.body).toContain('سارة');
    expect(ar.body).toContain('عمر');
    expect(ar.body).toContain('دعوة عضو');
  });

  it('an owner-only permission says so instead of "ask the owner"', () => {
    const text = denialText('en', {
      permissionKey: 'billing.manage',
      memberName: 'Sara',
      ownerName: 'Omar',
    });
    expect(text.ownerOnly).toBe(true);
    expect(text.body).toBe('“Change the plan or payment method” is owner-only.');
    expect(text.body).not.toContain('Omar');
  });

  it('an action refusal keeps the permission KEY for the URL, never a name', () => {
    expect(actionErrorCode(permissionDenied('member.invite'))).toBe('FORBIDDEN:member.invite');
    expect(actionErrorCode(permissionDenied('billing.manage'))).toBe(
      'FORBIDDEN_OWNER:billing.manage',
    );
    // A FORBIDDEN that names nothing, or names a key outside the catalogue,
    // stays the plain code.
    expect(actionErrorCode(new AppError('FORBIDDEN', 'ladder'))).toBe('FORBIDDEN');
    expect(actionErrorCode(permissionDenied('platform.everything'))).toBe('FORBIDDEN');
    expect(deniedPermission(new AppError('NOT_FOUND', 'x'))).toBeNull();
    expect(actionErrorCode(new Error('boom'))).toBe('INTERNAL');
  });

  it('the banner turns the key into words and refuses anything else', () => {
    expect(statusMessage('FORBIDDEN:member.invite', 'en')).toBe(
      "You don't have the “Invite a member” permission. " +
        'Permissions come from the role · ask the owner to change your role.',
    );
    expect(statusMessage('FORBIDDEN:member.invite', 'ar')).toContain('دعوة عضو');
    expect(statusMessage('FORBIDDEN_OWNER:billing.manage', 'en')).toBe(
      '“Change the plan or payment method” is owner-only.',
    );
    // A crafted key the dictionary does not hold is never echoed.
    expect(statusMessage('FORBIDDEN:evil.key', 'en')).toBe(statusMessage('FORBIDDEN', 'en'));
    expect(statusMessage('FORBIDDEN:<script>', 'en')).toBeNull();
  });

  it('actions refuse with a named FORBIDDEN instead of a swallowed 404', () => {
    const dir = path.join(root, 'apps/dashboard/src/app/[locale]');
    const offenders: string[] = [];
    for (const file of actionFiles(dir)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('actionErrorCode')) continue;
      // Files that report failures through `actionErrorCode` must gate through
      // the action variant, or the refusal is caught and shown as INTERNAL.
      const plain = source.match(/await requireWorkspace\(locale, [^)]+\)/g) ?? [];
      const allowed = plain.filter((call) => call.includes('CAMPAIGN_ASSOCIATION_PERMISSION'));
      if (plain.length !== allowed.length) offenders.push(path.relative(root, file));
      if (/toPublicErrorCode\(error\)/.test(source)) offenders.push(`${file}: toPublicErrorCode`);
    }
    expect(offenders).toEqual([]);
  });

  it('the action gate is the same permission test as the page gate', () => {
    const context = read('apps/dashboard/src/server/customer-context.ts');
    expect(context).toMatch(
      /if \(permissionKey && !holdsPermission\(workspace, permissionKey\)\) notFound\(\);/,
    );
    expect(context).toMatch(
      /if \(!holdsPermission\(session\.workspace, permissionKey\)\) \{\s*throw permissionDenied\(permissionKey\);/,
    );
  });

  it('Members and Billing explain a missing control, and Permissions says "from the role"', () => {
    const members = read('apps/dashboard/src/app/[locale]/members/page.tsx');
    expect(members).toMatch(/!may\('member\.invite'\) && \(\s*<PermissionNotice/);
    const billing = read('apps/dashboard/src/app/[locale]/billing/page.tsx');
    expect(billing).toMatch(/mayManage \? null : \(\s*<PermissionNotice/);
    const permissions = read('apps/dashboard/src/app/[locale]/permissions/page.tsx');
    expect(permissions).toContain("t('perms.fromRole')");
  });
});
