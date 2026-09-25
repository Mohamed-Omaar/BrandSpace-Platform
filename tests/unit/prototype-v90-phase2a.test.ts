import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  OWNER_ONLY_PERMISSION_KEYS,
  ROLE_DEFINITIONS,
  isOwnerOnlyPermission,
} from '@brandspace/shared';
import { NOTE_PERMISSION } from '@brandspace/collaboration';
import { messages, statusMessage } from '../../apps/dashboard/src/i18n/messages';
import {
  KNOWN_PAGE_PERMISSIONS,
  type KnownPage,
} from '../../apps/dashboard/src/server/known-routes';
import { SETTINGS_NAV_ROUTES } from '../../apps/dashboard/src/server/settings-nav';
import { TOPBAR_CREATE_FLOWS, TOPBAR_PERMISSIONS } from '../../apps/dashboard/src/server/topbar';
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

describe('E2 / Q5 · "No access to this page" for the known navigation list only', () => {
  const known = Object.keys(KNOWN_PAGE_PERMISSIONS) as KnownPage[];
  const pageFile = (route: string) => `apps/dashboard/src/app/[locale]${route}/page.tsx`;

  it('has its title in both languages', () => {
    both('errors.noAccess.title');
  });

  it.each(known)('%s gates through the known-route table and renders NoAccessPage', (route) => {
    const source = read(pageFile(route));
    expect(source).toContain(`await requireWorkspacePage(locale, '${route}')`);
    expect(source).toMatch(
      /if \(!access\.allowed\) return <NoAccessPage locale=\{locale\} access=\{access\} \/>;/,
    );
    // The page no longer carries a second, drifting copy of its permission.
    expect(source).not.toMatch(/requireWorkspace\(locale, '[^']+'\)/);
  });

  it('the sidebar, the Settings list and the top bar advertise the gate the page applies', () => {
    const shell = read('apps/dashboard/src/components/workspace-shell.tsx');
    const nav = [
      ...shell.matchAll(/href: '(\/[^']+)',\s*key: '[^']+',\s*permission: (?:'([^']+)'|null)/g),
    ];
    expect(nav.length).toBeGreaterThan(10);
    for (const [, href, permission] of nav) {
      if (!permission) continue;
      expect(KNOWN_PAGE_PERMISSIONS[href as KnownPage], href).toBe(permission);
    }
    for (const route of SETTINGS_NAV_ROUTES) {
      if (!route.permission) continue;
      expect(KNOWN_PAGE_PERMISSIONS[route.path as KnownPage], route.path).toBe(route.permission);
    }
    expect(KNOWN_PAGE_PERMISSIONS['/approvals']).toBe(TOPBAR_PERMISSIONS.review);
    expect(KNOWN_PAGE_PERMISSIONS['/notes']).toBe(TOPBAR_PERMISSIONS.notes);
    expect(KNOWN_PAGE_PERMISSIONS['/notes']).toBe(NOTE_PERMISSION);
    expect(KNOWN_PAGE_PERMISSIONS['/copilot']).toBe(TOPBAR_PERMISSIONS.copilot);
    for (const flow of TOPBAR_CREATE_FLOWS) {
      const route = flow.path.split('?')[0] as KnownPage;
      expect(flow.requires, route).toContain(KNOWN_PAGE_PERMISSIONS[route]);
    }
  });

  it('records keep the identical 404: resource routes are NOT on the list', () => {
    for (const route of [
      '/campaigns/[campaignId]',
      '/billing/invoices/[invoiceId]',
      '/billing/checkout/[outcome]',
    ]) {
      expect(known).not.toContain(route);
      expect(read(pageFile(route))).toMatch(/requireWorkspace\(locale, '[^']+'\)/);
    }
    const context = read('apps/dashboard/src/server/customer-context.ts');
    // `requireWorkspace` itself still answers a missing permission with 404.
    expect(context).toMatch(/!holdsPermission\(workspace, permissionKey\)\) notFound\(\)/);
  });

  it('the screen sits inside the shell and carries the E6 denial', () => {
    const screen = read('apps/dashboard/src/components/no-access-page.tsx');
    expect(screen).toContain('<WorkspaceShell');
    expect(screen).toContain('kind="forbidden"');
    expect(screen).toContain('denialText(locale');
    expect(screen).toContain('testId="route-no-access"');
  });
});
