import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { ALL_PERMISSIONS, ROLE_DEFINITIONS } from '@brandspace/shared';
import { DASHBOARD_BASE_URL } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';

/**
 * REVIEW OF #68, ROUND 4, 2.1 — ROLES & PERMISSIONS AS THE PROTOTYPE SHOWS
 * THEM, AND NEVER AS KEYS.
 *
 * The walk the owner asked for: invite a member with a role, read the roles
 * and permissions page, open a member — and at each step the permissions are
 * the prototype's grouped, plain-language actions, the same answer in both
 * places, with no permission key anywhere a customer can read. The semantics
 * are unchanged: every row is the role's (E6/Q4), read from the role's own
 * definition.
 */

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  const { customer } = credentials();
  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL((url) => !url.pathname.endsWith('/sign-in'));
  const choose = page.getByTestId(`choose-workspace-${customer.workspaceSlug}`);
  if (await choose.isVisible().catch(() => false)) await choose.click();
  await page.waitForURL(/\/en\/overview$/);
}

const WORKSPACE_KEYS = ALL_PERMISSIONS.filter((p) => p.minScope !== 'platform').map((p) => p.key);

/** No permission key is readable anywhere in the page's visible text. */
async function expectNoRawKeys(page: Page, where: string): Promise<void> {
  // Open every disclosure first: a key hidden behind one is still shown.
  await page.evaluate(() => {
    for (const details of Array.from(document.querySelectorAll('details'))) details.open = true;
  });
  const visible = await page.locator('main').innerText();
  const leaked = WORKSPACE_KEYS.filter((key) => visible.includes(key));
  expect(leaked, `${where} shows permission keys`).toEqual([]);
}

/** The rows of a grouped view, as `{ action: state }`. */
async function rowsOf(page: Page, testId: string): Promise<Record<string, string>> {
  return page.evaluate((prefix) => {
    const out: Record<string, string> = {};
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}-row-"]`),
    )) {
      out[row.dataset['testid']!.slice(`${prefix}-row-`.length)] = row.dataset['state'] ?? '';
    }
    return out;
  }, testId);
}

test.describe('round 4 · roles & permissions', () => {
  test.skip(({ isMobile }) => isMobile, 'the phone layout is post-launch (D-468 (b))');

  test('invite → permissions → member view: grouped, the same answer, no keys', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const { customer } = credentials();
    const copywriter = ROLE_DEFINITIONS.find((role) => role.key === 'copywriter')!;

    /* 1 · The owner invites a member as a Copywriter. */
    await signIn(page, customer.email, customer.password);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    const invitee = `e2e-r4-perms-${Date.now()}@brandspace.test`;
    await page.getByTestId('members-invite-open').click();
    await page.fill('#invite-email', invitee);
    await page.selectOption('#invite-role', { label: copywriter.nameEn });
    await page.click('[data-testid="invite-submit"]');
    await expect(page.getByTestId('success-banner')).toBeVisible();
    await expect(page.getByTestId(`invitation-${invitee}`)).toContainText(copywriter.nameEn);
    await expectNoRawKeys(page, 'Team');

    /* 2 · The roles & permissions page: the owner's role, in the prototype's groups. */
    await page.goto(`${DASHBOARD_BASE_URL}/en/permissions`);
    const groups = page.getByTestId('perm-groups');
    await expect(groups).toBeVisible();
    for (const title of [
      'Content',
      'Brand Brain',
      'Media',
      'Planning',
      'Publishing & accounts',
      'Data & AI',
      'Workspace',
    ]) {
      await expect(groups.getByText(title, { exact: true })).toBeVisible();
    }
    await expect(page.getByTestId('perm-groups-row-content.create')).toContainText(
      'Write and edit drafts',
    );
    await expect(page.getByTestId('perm-groups-state-content.create')).toHaveText('From the role');
    await expect(page.getByTestId('permissions-logged')).toBeVisible();
    // Team & roles is the prototype's Team: the rail marks Team, once.
    await expect(page.getByTestId('nav-members')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('sidebar').locator('[aria-current="page"]')).toHaveCount(1);
    await expectNoRawKeys(page, 'Roles & permissions');

    /* 3 · A member's own page: their role's groups, from the role's definition. */
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    const manage = await page
      .locator(`[data-testid="member-manage-${customer.copywriterEmail}"]`)
      .first()
      .getAttribute('href');
    expect(manage).toContain('member=');
    await page.goto(`${DASHBOARD_BASE_URL}${manage!}`);
    await expect(page.getByTestId('member-detail')).toBeVisible();
    await expect(page.getByTestId('member-perms')).toBeVisible();
    const memberRows = await rowsOf(page, 'member-perms');
    const held = new Set(copywriter.permissionKeys);
    expect(memberRows['content.create']).toBe(held.has('content.create') ? 'role' : 'none');
    expect(memberRows['billing.manage']).not.toBe('role');
    await expectNoRawKeys(page, 'the member page');

    /* 4 · The member reads the same answer on their own permissions page. */
    await page.context().clearCookies();
    await signIn(page, customer.copywriterEmail, customer.copywriterPassword);
    await page.goto(`${DASHBOARD_BASE_URL}/en/permissions`);
    await expect(page.getByTestId('your-role')).toHaveText(copywriter.nameEn);
    expect(await rowsOf(page, 'perm-groups')).toEqual(memberRows);
    await expectNoRawKeys(page, "the copywriter's permissions");
  });
});
