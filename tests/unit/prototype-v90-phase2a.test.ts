import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  CREDIT_SPENDING_PERMISSION,
  OWNER_ONLY_PERMISSION_KEYS,
  creditSpendingPermissions,
  mayReadCreditBalance,
  maySpendCredits,
  ROLE_DEFINITIONS,
  isOwnerOnlyPermission,
} from '@brandspace/shared';
import { NOTE_MANAGE_PERMISSION, NOTE_PERMISSION } from '@brandspace/collaboration';
import { homeSectionsFor } from '../../apps/dashboard/src/server/home';
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
    expect(context).toMatch(/if \(!holdsEvery\(workspace, permissionKey\)\) notFound\(\);/);
    expect(context).toMatch(/required\.every\(\(key\) => holdsPermission\(workspace, key\)\)/);
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
    expect(context).toMatch(/!holdsEvery\(workspace, permissionKey\)\) notFound\(\)/);
  });

  it('the screen sits inside the shell and carries the E6 denial', () => {
    const screen = read('apps/dashboard/src/components/no-access-page.tsx');
    expect(screen).toContain('<WorkspaceShell');
    expect(screen).toContain('kind="forbidden"');
    expect(screen).toContain('denialText(locale');
    expect(screen).toContain('testId="route-no-access"');
  });
});

describe('E3 + Q18 · spending credits needs copilot.use as well as the feature key', () => {
  const SPENDING_FEATURE_KEYS = [
    'content.create',
    'content.edit',
    'assets.upload',
    'brand_brain.chat',
    'analytics.explain',
    'strategy.manage',
  ];

  it('the rule is the feature key AND copilot.use', () => {
    expect(CREDIT_SPENDING_PERMISSION).toBe('copilot.use');
    expect(creditSpendingPermissions('content.create')).toEqual(['content.create', 'copilot.use']);
    expect(creditSpendingPermissions('copilot.use')).toEqual(['copilot.use']);
    expect(maySpendCredits(['content.create'], 'content.create')).toBe(false);
    expect(maySpendCredits(['content.create', 'copilot.use'], 'content.create')).toBe(true);
    expect(maySpendCredits(['copilot.use'], 'content.create')).toBe(false);
    expect(mayReadCreditBalance(['credits.read'])).toBe(false);
    expect(mayReadCreditBalance(['credits.read', 'copilot.use'])).toBe(true);
  });

  it('no role loses a spending capability: every holder of a spending key holds copilot.use', () => {
    for (const role of ROLE_DEFINITIONS.filter((r) => r.realm === 'workspace')) {
      const spends = SPENDING_FEATURE_KEYS.filter((k) => role.permissionKeys.includes(k));
      if (spends.length === 0) continue;
      expect(role.permissionKeys, role.key).toContain('copilot.use');
    }
  });

  it('every API route marked spendsCredits gates on creditSpendingPermissions(<its permission>)', () => {
    const files = ['content', 'creative', 'brand-brain', 'analytics'].map((f) =>
      read(`apps/api/src/routes/${f}.ts`),
    );
    const marked: string[] = [];
    for (const source of files) {
      for (const block of source.split(/\n {2}route\(/).slice(1)) {
        const url = /'(\/v1\/[^']+)'/.exec(block)?.[1] ?? '';
        const permission = /permission: ([A-Z_]+|'[^']+'),/.exec(block)?.[1];
        if (!block.includes('spendsCredits: true')) {
          expect(block, url).not.toContain('creditSpendingPermissions(');
          continue;
        }
        marked.push(url);
        expect(block, url).toContain(
          `await resolveCaller(req, reply, creditSpendingPermissions(${permission}))`,
        );
      }
    }
    expect(marked.sort()).toEqual([
      '/v1/analytics/explain',
      '/v1/brand-brain/chat',
      '/v1/content/generate',
      '/v1/content/tool',
      '/v1/creative/generate',
      '/v1/intelligence/content-gap',
      '/v1/strategy/generate',
    ]);
  });

  it('every copy of resolveCaller requires EVERY key it is given', () => {
    for (const file of ['content', 'brand-brain', 'phase7-context']) {
      const source = read(`apps/api/src/routes/${file}.ts`);
      expect(source, file).toContain('permission: string | readonly string[],');
      expect(source, file).toMatch(
        /!required\.every\(\(key\) => workspace\.permissionKeys\.includes\(key\)\)/,
      );
    }
  });

  it('the dashboard offers no credit-spending button without copilot.use', () => {
    const compose = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');
    expect(compose).toContain(
      "generate: maySpendCredits(workspace.permissionKeys, 'content.create')",
    );
    expect(compose).toMatch(
      /tools=\{maySpendCredits\(workspace\.permissionKeys, 'content\.edit'\) \? CONTENT_TOOLS : \[\]\}/,
    );
    expect(compose).toMatch(
      /generateMedia:\s*maySpendCredits\(workspace\.permissionKeys, 'assets\.upload'\)/,
    );
    const composer = read('apps/dashboard/src/app/[locale]/content/compose/composer-view.tsx');
    expect(composer).toMatch(
      /\{can\.generate \? \(\s*<button[^>]*?\s*type="button"\s*className="cs-ghost-button"/,
    );
    // Writing it yourself spends nothing and stays available.
    expect(composer).toContain('const canWrite = hasInputs && draft === null;');
    const pages: Array<[string, RegExp]> = [
      [
        'analytics/page.tsx',
        /mayExplain = maySpendCredits\(workspace\.permissionKeys, 'analytics\.explain'\)/,
      ],
      [
        'strategy/page.tsx',
        /mayGenerate = maySpendCredits\(workspace\.permissionKeys, 'strategy\.manage'\)/,
      ],
      [
        'intelligence/page.tsx',
        /mayAnalyse = maySpendCredits\(workspace\.permissionKeys, 'strategy\.manage'\)/,
      ],
      [
        'brand-brain/page.tsx',
        /chat: maySpendCredits\(workspace\.permissionKeys, 'brand_brain\.chat'\)/,
      ],
      [
        'creative/page.tsx',
        /if \(!maySpendCredits\(workspace\.permissionKeys, 'assets\.upload'\)\)/,
      ],
      ['copilot/page.tsx', /maySeeCredits = mayReadCreditBalance\(workspace\.permissionKeys\)/],
      ['plan/page.tsx', /mayReadCredits = mayReadCreditBalance\(workspace\.permissionKeys\)/],
      ['billing/page.tsx', /mayReadCredits = mayReadCreditBalance\(workspace\.permissionKeys\)/],
    ];
    for (const [file, pattern] of pages) {
      expect(read(`apps/dashboard/src/app/[locale]/${file}`), file).toMatch(pattern);
    }
    expect(read('apps/dashboard/src/server/command-center.ts')).toContain(
      "permissions: ['credits.read', 'billing.read', 'copilot.use'], run: creditsRunningOut",
    );
    expect(TOPBAR_CREATE_FLOWS.find((f) => f.key === 'creative')?.requires).toContain(
      'copilot.use',
    );
  });

  it('the dashboard spending actions ask for the same keys the API does', () => {
    for (const [file, key] of [
      ['analytics/actions.ts', 'analytics.explain'],
      ['strategy/actions.ts', 'strategy.manage'],
      ['intelligence/actions.ts', 'strategy.manage'],
    ] as const) {
      expect(read(`apps/dashboard/src/app/[locale]/${file}`), file).toContain(
        `requireWorkspace(locale, creditSpendingPermissions('${key}'))`,
      );
    }
  });

  it('E3 — archiving a fact needs brand_brain.edit; brand identity stays on brand.manage', () => {
    const actions = read('apps/dashboard/src/app/[locale]/brand-brain/actions.ts');
    const archive = actions.slice(actions.indexOf('export async function archiveKnowledgeAction'));
    expect(archive).toContain("requireWorkspaceAction(locale, 'brand_brain.edit')");
    expect(read('apps/dashboard/src/app/[locale]/brand-brain/page.tsx')).toContain(
      "remove: can('brand_brain.edit')",
    );
    expect(read('apps/dashboard/src/app/[locale]/settings/brand/actions.ts')).toContain(
      "requireWorkspaceAction(locale, 'brand.manage')",
    );
  });
});

describe('A6 + E7 / Q12 · Home by role, and a member who may only comment', () => {
  const role = (key: string) => ROLE_DEFINITIONS.find((r) => r.key === key)?.permissionKeys ?? [];

  it('chooses Home sections from permissions, per role', () => {
    expect(homeSectionsFor(role('workspace_owner'))).toEqual({
      reviewQueue: true,
      myWork: true,
      topPosts: true,
      feedback: false,
    });
    expect(homeSectionsFor(role('approver'))).toMatchObject({ reviewQueue: true, myWork: false });
    expect(homeSectionsFor(role('copywriter'))).toMatchObject({
      reviewQueue: false,
      myWork: true,
      topPosts: false,
    });
    expect(homeSectionsFor(role('analyst'))).toMatchObject({ topPosts: true, myWork: false });
    // The Viewer today reads no content, so it gets none of these sections…
    expect(homeSectionsFor(role('client_viewer'))).toEqual({
      reviewQueue: false,
      myWork: false,
      topPosts: false,
      feedback: false,
    });
    // …and once a later release grants it `content.read`, the feedback section (E7).
    expect(homeSectionsFor([...role('client_viewer'), 'content.read'])).toEqual({
      reviewQueue: false,
      myWork: false,
      topPosts: false,
      feedback: true,
    });
  });

  it('the Viewer is NOT given content.read in Phase 2A', () => {
    expect(role('client_viewer')).toEqual(['workspace.read']);
  });

  it('notes.manage goes to exactly the roles that read content, and not to the Viewer', () => {
    expect(NOTE_MANAGE_PERMISSION).toBe('notes.manage');
    for (const r of ROLE_DEFINITIONS.filter((d) => d.realm === 'workspace')) {
      expect(r.permissionKeys.includes('notes.manage'), r.key).toBe(
        r.permissionKeys.includes(NOTE_PERMISSION),
      );
    }
    expect(role('client_viewer')).not.toContain('notes.manage');
  });

  it('the notes panel and Home offer triage only with notes.manage', () => {
    const panel = read('apps/dashboard/src/components/notes-panel.tsx');
    expect(panel).toContain('mayManage = actor.permissionKeys.includes(NOTE_MANAGE_PERMISSION)');
    expect(panel).toMatch(
      /\{status === 'RESOLVED' && !mayManage \? null : \(\s*<form\s*action=\{replyToNoteThreadAction\}/,
    );
    expect(panel).toMatch(
      /\{mayManage \? \(\s*<form action=\{status === 'RESOLVED' \? reopenNoteThreadAction/,
    );
    expect(panel).toMatch(/\{mayManage \? \(\s*<details data-testid=\{`note-options-/);
    const home = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
    expect(home).toContain("entry.status === 'OPEN' && mayManageNotes ? (");
  });

  it('the notes service asks notes.manage for every triage write', () => {
    const service = read('packages/collaboration/src/notes.ts');
    for (const method of ['resolve', 'reopen', 'assign', 'setDue', 'setImportance']) {
      const body = service.slice(service.indexOf(`  async ${method}(`));
      const end = body.indexOf('\n  }\n');
      expect(body.slice(0, end), method).toContain('this.#requireManage(input.actor);');
    }
    expect(service).toContain(
      "if (thread.status === 'RESOLVED') this.#requireManage(input.actor);",
    );
  });

  it("Home lists the member's own work by createdBy/requestedBy, and feedback links to the calendar", () => {
    const home = read('apps/dashboard/src/app/[locale]/overview/page.tsx');
    expect(home).toMatch(
      /createdByUserId: customer\.userId,\s*status: \{ in: \['DRAFT', 'CHANGES_REQUESTED'\] \}/,
    );
    expect(home).toContain('requestedByUserId: customer.userId');
    expect(home).toContain('item: { createdByUserId: customer.userId, deletedAt: null }');
    expect(home).toMatch(/testId="home-feedback"[\s\S]*?href=\{`\/\$\{locale\}\/calendar`\}/);
    // A member without analytics is told the figure is hidden, not pending.
    expect(home).toMatch(/!maySeeAnalytics\s*\?\s*t\('overview\.metric\.hidden'\)/);
    for (const key of [
      'home.role.review.title',
      'home.role.drafts.title',
      'home.role.sent.title',
      'home.role.scheduled.title',
      'home.role.top.title',
      'home.role.feedback.title',
      'home.role.feedback.open',
    ]) {
      both(key);
    }
  });
});

describe('B3 / Q8 · an edit by someone without content.schedule unschedules the post', () => {
  it('both edit paths hand the editor’s session permissions to the rule', () => {
    const actions = read('apps/dashboard/src/app/[locale]/content/actions.ts');
    const save = actions.slice(actions.indexOf('export async function saveVariantAction'));
    expect(save.slice(0, save.indexOf('\n}\n'))).toContain(
      'actorPermissionKeys: session.workspace.permissionKeys',
    );
    const api = read('apps/api/src/routes/content.ts');
    expect(api).toContain('permissionKeys: workspace.permissionKeys,');
    expect(api).toContain('actorPermissionKeys: caller.permissionKeys,');
  });

  it('the library gets the calendar as its scheduling port, in the dashboard and the API', () => {
    expect(read('apps/dashboard/src/server/content-context.ts')).toContain(
      'scheduling: await calendar(),',
    );
    const api = read('apps/api/src/routes/content.ts');
    expect(api).toMatch(
      /scheduling: new ContentCalendarService\(\{[\s\S]*?quota: scheduleQuota\(db, caller\.workspaceId\)/,
    );
  });

  it('the composer says what saving will do, in both languages', () => {
    const editor = read('apps/dashboard/src/app/[locale]/content/compose/draft-editor.tsx');
    expect(editor).toContain("draft.status === 'SCHEDULED' && can.edit");
    both('editor.scheduledWarning.unschedules');
    both('editor.scheduledWarning.scheduler');
  });
});

describe('F1 · every edit path, the campaign included, obeys the edit rules', () => {
  /** The body of the method that starts at `signature`, up to the next method. */
  const method = (source: string, signature: string) => {
    const start = source.indexOf(signature);
    expect(start, signature).toBeGreaterThan(-1);
    const next = source.indexOf('\n  async ', start + signature.length);
    return source.slice(start, next === -1 ? undefined : next);
  };

  it('no new write path changes a variant without the guards', () => {
    const files = readdirSync(path.join(root, 'packages/content/src')).filter((f) =>
      f.endsWith('.ts'),
    );
    const writers = files.flatMap((f) =>
      (read(`packages/content/src/${f}`).match(/contentVariant\.update\(/g) ?? []).map(() => f),
    );
    // editVariant (library) and applyTool (studio). A third needs these guards too.
    expect(writers.sort()).toEqual(['library.ts', 'studio.ts']);
    const library = read('packages/content/src/library.ts');
    const edit = method(library, 'async editVariant(');
    expect(edit).toContain('await this.assertEditable(variant.contentItemId);');
    expect(edit).toContain('await this.revokeApprovalOnEdit(');
    const studio = read('packages/content/src/studio.ts');
    expect(method(studio, 'async applyTool(')).toContain('await this.revokeApprovalOnEdit(');
    expect(studio).toMatch(/async #toolRequest[\s\S]*?await this\.assertEditable\(/);
  });

  it('a campaign change refuses a published post and withdraws a review, after the no-op', () => {
    const campaigns = read('packages/content/src/campaigns.ts');
    const set = method(campaigns, 'async setContentCampaign(');
    const noop = set.indexOf('if (input.campaignId === item.campaignId) return;');
    const readOnly = set.indexOf('READ_ONLY_CONTENT_STATUSES.includes(item.status)');
    const withdraw = set.indexOf('this.#reviewWithdrawal.withdrawForEdit(');
    expect(noop).toBeGreaterThan(-1);
    expect(readOnly).toBeGreaterThan(noop);
    expect(withdraw).toBeGreaterThan(readOnly);
    expect(read('apps/dashboard/src/server/content-context.ts')).toContain(
      'withdrawForEdit: async (input) => (await approvals()).withdrawForEdit(input)',
    );
  });

  it('the composer hides the campaign control on a published post, and offers "Make a new copy"', () => {
    const compose = read('apps/dashboard/src/app/[locale]/content/compose/page.tsx');
    expect(compose).toMatch(
      /manageCampaigns:\s*workspace\.permissionKeys\.includes\('campaigns\.manage'\) && !composerDraft\?\.readOnly/,
    );
    expect((messages.en as Record<string, string>)['content.action.duplicate']).toBe(
      'Make a new copy',
    );
    both('content.action.duplicate');
  });
});
