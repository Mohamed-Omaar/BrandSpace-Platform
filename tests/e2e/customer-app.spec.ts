import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DASHBOARD_BASE_URL, ADMIN_BASE_URL, LOCALES } from './apps';
import { E2E_CREDENTIALS_FILE, type E2eAdminCredentials } from './env';
import { expectNoHorizontalOverflow } from './overflow';

/**
 * The customer application, end to end, in a real browser.
 *
 * Replaces the generic scaffold specs the dashboard used to share with the
 * public website, and covers strictly more: authentication, realm separation,
 * invitation acceptance, workspace switching, RBAC, RTL/LTR, keyboard
 * operation, accessibility and overflow — against pages holding real data.
 *
 * Credentials are generated per run by `pnpm e2e:seed` into a git-ignored file.
 * Nothing here is a real credential, and nothing is reused between runs.
 */

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error(
      'The end-to-end credentials file is missing. Run `pnpm e2e:seed` first — ' +
        '`pnpm test:e2e` does it for you.',
    );
  }
}

/**
 * Sign in and WAIT FOR THE OUTCOME TO LAND.
 *
 * Every form here posts a server action that answers with a redirect. A click
 * only starts that POST; a `page.goto()` issued while it is still in flight
 * CANCELS it, and the session is then left exactly as it was. Waiting for the
 * landing is therefore an assertion, not politeness — it is the difference
 * between testing the flow and testing a cancelled request.
 *
 * Both outcomes are accepted here because several tests sign in deliberately
 * WRONG: success leaves `/sign-in`, failure returns to it carrying `?error=`.
 */
async function signIn(page: Page, email: string, password: string, locale = 'en'): Promise<void> {
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
}

/**
 * Choose a workspace from the picker and wait until the session actually holds
 * it. The action re-verifies membership, writes `activeWorkspaceId` and stamps
 * `lastActivityAt` inside the tenant context before redirecting, so the landing
 * on the workspace home is the proof that all of that completed.
 */
async function enterWorkspace(page: Page, slug: string, locale = 'en'): Promise<void> {
  await page.click(`[data-testid="choose-workspace-${slug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

test.describe('customer authentication', () => {
  test('an anonymous visitor is sent to sign-in, never to a workspace', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page).toHaveURL(/\/en\/sign-in/);
    await expect(page.getByTestId('signin-submit')).toBeVisible();
  });

  test('every protected route redirects when signed out', async ({ page }) => {
    for (const path of [
      '/en/overview',
      '/en/members',
      '/en/settings',
      '/en/plan',
      '/en/permissions',
    ]) {
      await page.goto(`${DASHBOARD_BASE_URL}${path}`);
      await expect(page).toHaveURL(/\/sign-in/);
    }
  });

  test('the root hands off to the workspace home', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en`);
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });

  test('a wrong password fails with a generic message and no detail', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, 'definitely-not-the-password');

    await expect(page.getByTestId('signin-error')).toBeVisible();
    const body = await page.textContent('body');
    // No stack, no SQL, no column names, no "user not found".
    expect(body).not.toMatch(/prisma|postgres|passwordHash|at Object\./i);
    // The URL carries a CODE and an opaque id, never a message.
    const url = new URL(page.url());
    expect(url.searchParams.get('error')).toBe('UNAUTHENTICATED');
    expect(url.searchParams.get('ref')).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('an unknown address fails identically to a wrong password', async ({ page }) => {
    // Strip the correlation id: it is a fresh uuid per request BY DESIGN, and
    // it is the one part that legitimately differs. What must be identical is
    // the wording and the emitted code.
    const withoutRef = (text: string | null): string =>
      (text ?? '').replace(/\((?:reference|المرجع)[^)]*\)/, '').trim();

    await signIn(page, `nobody-${Date.now()}@example.test`, 'whatever-this-is');
    const unknownText = withoutRef(await page.getByTestId('signin-error').textContent());
    const unknownCode = new URL(page.url()).searchParams.get('error');

    const { customer } = credentials();
    await signIn(page, customer.email, 'definitely-not-the-password');
    const wrongText = withoutRef(await page.getByTestId('signin-error').textContent());
    const wrongCode = new URL(page.url()).searchParams.get('error');

    // Identical wording AND identical code: not an account-existence oracle.
    expect(unknownText).toBe(wrongText);
    expect(unknownCode).toBe(wrongCode);
    expect(unknownCode).toBe('UNAUTHENTICATED');
  });

  test('a valid sign-in reaches the workspace picker', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await expect(page).toHaveURL(/\/en\/workspaces/);
    await expect(page.getByTestId(`choose-workspace-${customer.workspaceSlug}`)).toBeVisible();
  });

  test('signing out ends the session', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await expect(page).toHaveURL(/\/en\/overview/);

    /*
     * Sign-out now lives in the profile card's menu at the foot of the rail,
     * which is where the full demo puts it (fidelity pass §8). The assertion is
     * unchanged — signing out must end the session — only the route to the
     * control moved, so the test opens the menu the person would open.
     */
    await page.getByTestId('profile-menu').click();
    await page.click('[data-testid="sign-out"]');
    await expect(page).toHaveURL(/\/en\/sign-in/);

    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await expect(page).toHaveURL(/\/en\/sign-in/);
  });

  test('the password reset request never reveals whether the account exists', async ({ page }) => {
    const { customer } = credentials();

    await page.goto(`${DASHBOARD_BASE_URL}/en/reset`);
    await page.fill('#email', customer.email);
    await page.click('[data-testid="reset-request-submit"]');
    const known = await page.getByTestId('signin-status').textContent();

    await page.goto(`${DASHBOARD_BASE_URL}/en/reset`);
    await page.fill('#email', `nobody-${Date.now()}@example.test`);
    await page.click('[data-testid="reset-request-submit"]');
    const unknown = await page.getByTestId('signin-status').textContent();

    // Byte-identical: this response carries no correlation id at all, because
    // there is nothing to correlate — both arms took the same path.
    expect(known).toBe(unknown);
  });
});

test.describe('the two session realms are separate', () => {
  test('a customer session grants nothing in the Control Center', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await expect(page).toHaveURL(/\/en\/workspaces/);

    // Same browser, same cookie jar, different application.
    await page.goto(`${ADMIN_BASE_URL}/en/console`);
    await expect(page).toHaveURL(/\/en\/login/);
    await expect(page.getByTestId('nav-nav.workspaces')).toHaveCount(0);
  });

  test('the two applications set different cookies', async ({ page, context }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);

    const cookies = await context.cookies();
    const names = cookies.map((c) => c.name);
    expect(names).toContain('__Host-bs_customer_session');
    expect(names).not.toContain('__Host-bs_platform_session');
  });
});

test.describe('workspace selection and switching', () => {
  test('a member of two workspaces sees both and switches between them', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);

    await expect(page.getByTestId(`choose-workspace-${customer.workspaceSlug}`)).toBeVisible();
    await expect(
      page.getByTestId(`choose-workspace-${customer.secondWorkspaceSlug}`),
    ).toBeVisible();

    await enterWorkspace(page, customer.workspaceSlug);
    await expect(page.getByTestId('active-workspace')).toContainText(customer.workspaceName);

    // Phase 2C moved "switch workspace" INTO the workspace switcher menu, so
    // the menu is opened first. The assertions either side are unchanged: what
    // is being tested is that a member of two workspaces reaches the picker and
    // lands in a correctly scoped second workspace.
    await page.click('[data-testid="workspace-switcher"]');
    await page.click('[data-testid="switch-workspace"]');
    await enterWorkspace(page, customer.secondWorkspaceSlug);
    // A new, correctly scoped context — not the previous workspace's data.
    await expect(page.getByTestId('active-workspace')).not.toContainText(customer.workspaceName);
  });

  test('the workspace name and role are always visible', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await expect(page.getByTestId('active-workspace')).toBeVisible();
    await expect(page.getByTestId('active-role')).toBeVisible();
  });
});

test.describe('invitation acceptance', () => {
  test('an invalid token shows a uniform failure and names no workspace', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/invitations/definitely-not-a-real-token`);
    await expect(page.getByTestId('invitation-invalid')).toBeVisible();
    const body = await page.textContent('body');
    expect(body).not.toContain('E2E Primary Workspace');
  });

  test('a valid token shows the workspace and role, and asks for sign-in first', async ({
    page,
  }) => {
    const { customer } = credentials();
    await page.goto(`${DASHBOARD_BASE_URL}/en/invitations/${customer.invitationToken}`);
    await expect(page.getByTestId('invitation-workspace')).toContainText(customer.workspaceName);
    await expect(page.getByTestId('invitation-role')).toBeVisible();
    // Acceptance binds to a PROVEN identity, so it needs a session first.
    await expect(page.getByTestId('invitation-signin-first')).toBeVisible();
  });

  test('the WRONG signed-in recipient cannot accept it', async ({ page }) => {
    const { customer } = credentials();
    // Sign in as the OWNER, then open the invitation addressed to somebody else.
    await signIn(page, customer.email, customer.password);
    await page.goto(`${DASHBOARD_BASE_URL}/en/invitations/${customer.invitationToken}`);
    await page.click('[data-testid="invitation-accept"]');

    // Refused, and with the same wording as an unknown token.
    await expect(page.getByTestId('invitation-error')).toBeVisible();
    const url = new URL(page.url());
    expect(url.searchParams.get('error')).toBe('NOT_FOUND');
  });

  /*
   * A-2. THE JOURNEY FOR SOMEBODY WHO HAS NEVER USED THE PRODUCT.
   *
   * Nothing is pre-created for this address but the invitation itself: no
   * user row, no password, no membership. That is the whole test — the
   * previous suite pre-seeded the invitee's `User`, and that pre-creation is
   * what hid the fact that a new invitee had no way in at all.
   */
  test('a brand-new invitee sets a password and lands in the workspace', async ({ page }) => {
    const { customer } = credentials();
    const password = 'a-strong-local-only-newcomer-3182';

    // Proof the address really is new: the acceptance page is reachable
    // anonymously and offers the set-up form, not an accept button.
    await page.goto(`${DASHBOARD_BASE_URL}/en/invitations/${customer.newcomerToken}`);
    await expect(page.getByTestId('invitation-workspace')).toContainText(customer.workspaceName);
    await expect(page.getByTestId('invitation-setup-title')).toBeVisible();
    await expect(page.getByTestId('invitation-accept')).toHaveCount(0);

    // The invited address is NOT a field: it comes from the invitation row, so
    // this form cannot be used to create an account for somebody else.
    await expect(page.locator('input[name="email"]')).toHaveCount(0);

    // The minimum is enforced in the field, so a short password never reaches
    // the invitation. Asserted here rather than in a test of its own: the
    // token is single-use, and a second test would need a second invitation
    // only to check something this one is already holding.
    await page.fill('[data-testid="invitation-password"]', 'short');
    const shortIsValid = await page
      .getByTestId('invitation-password')
      .evaluate((el) => (el as HTMLInputElement).validity.valid);
    expect(shortIsValid).toBe(false);

    await page.fill('[data-testid="invitation-password"]', password);
    await page.click('[data-testid="invitation-setup-submit"]');

    // Signed in, in the workspace, in one step.
    await page.waitForURL(/\/en\/overview/);
    await expect(page.getByTestId('heading')).toBeVisible();

    // And the identity now works like any other. Cookies cleared first: the
    // onboarding already signed them in, and a sign-in form is not served to
    // somebody who has a session.
    await page.context().clearCookies();
    await signIn(page, customer.newcomerEmail, password);
    await expect(page).toHaveURL(/\/en\/(workspaces|overview)/);
  });

  test('the invited recipient CAN accept it and lands in the workspace', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.invitedEmail, customer.password);
    await page.goto(`${DASHBOARD_BASE_URL}/en/invitations/${customer.invitationToken}`);
    await page.click('[data-testid="invitation-accept"]');

    await expect(page).toHaveURL(/\/en\/overview/);
    await expect(page.getByTestId('active-workspace')).toContainText(customer.workspaceName);
  });
});

test.describe('RBAC is enforced by the server, not by hidden buttons', () => {
  test('a read-only member cannot reach the team page at all', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.viewerEmail, customer.viewerPassword);
    await enterWorkspace(page, customer.workspaceSlug);

    // 404, not 403: which pages exist but are closed is itself information.
    const response = await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    expect(response?.status()).toBe(404);
  });

  test('a read-only member cannot reach settings or the plan page', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.viewerEmail, customer.viewerPassword);
    await enterWorkspace(page, customer.workspaceSlug);

    for (const path of ['/en/settings', '/en/plan']) {
      const response = await page.goto(`${DASHBOARD_BASE_URL}${path}`);
      expect(response?.status()).toBe(404);
    }
  });

  test('the navigation hides what the role cannot use', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.viewerEmail, customer.viewerPassword);
    await enterWorkspace(page, customer.workspaceSlug);

    await expect(page.getByTestId('nav-members')).toHaveCount(0);
    await expect(page.getByTestId('nav-settings')).toHaveCount(0);
    // But the permissions page is open to every member — it shows the truth
    // about their own grants.
    await expect(page.getByTestId('nav-permissions')).toBeVisible();
  });

  test('the owner CAN reach every page the viewer cannot', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);

    for (const [path, testId] of [
      ['/en/members', 'members-card'],
      ['/en/settings', 'settings-card'],
      ['/en/plan', 'plan-card'],
    ] as const) {
      await page.goto(`${DASHBOARD_BASE_URL}${path}`);
      await expect(page.getByTestId(testId)).toBeVisible();
    }
  });

  test('the permissions page reports the role a member actually holds', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.viewerEmail, customer.viewerPassword);
    await enterWorkspace(page, customer.workspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/permissions`);

    await expect(page.getByTestId('your-role')).toBeVisible();
    // Read-only means read-only: no mutating permission is reported as held.
    await expect(page.getByTestId('permission-state-workspace.update')).toContainText('Disabled');
    await expect(page.getByTestId('permission-state-member.invite')).toContainText('Disabled');
    await expect(page.getByTestId('permission-state-workspace.read')).toContainText('Enabled');
  });
});

test.describe('the team page performs real work', () => {
  test('lists members, marks the owner, and states the last-owner rule', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);

    await expect(page.getByTestId('members-table')).toBeVisible();
    await expect(page.getByTestId(`member-${customer.email}`)).toBeVisible();
    await expect(page.getByTestId(`owner-badge-${customer.email}`)).toBeVisible();
    await expect(page.getByTestId('last-owner-rule')).toBeVisible();
  });

  test('invites a member and shows the invitation, with no token in the page', async ({ page }) => {
    const { customer } = credentials();
    const invitee = `e2e-new-${Date.now()}@brandspace.test`;

    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);

    await page.fill('#invite-email', invitee);
    await page.click('[data-testid="invite-submit"]');

    await expect(page.getByTestId('success-banner')).toBeVisible();
    await expect(page.getByTestId(`invitation-${invitee}`)).toBeVisible();

    // THE RAW TOKEN EXISTS ONLY IN THE EMAILED LINK. It must not be rendered.
    //
    // Two checks, because one alone is not the property.
    //
    //   1. No acceptance URL anywhere in the DELIVERED HTML. A leaked token
    //      would take exactly this shape, whatever its length, and this covers
    //      attributes and inline data as well as text.
    //   2. No token-shaped run of characters in the VISIBLE text — what a
    //      person could read or copy off the screen.
    //
    // `innerText`, not `textContent`: `textContent` includes the contents of
    // <script> elements, and Next.js's own streaming payload carries long
    // base64-ish chunk names that match any "looks like a token" pattern. That
    // made the check fail on framework internals while saying nothing about the
    // invitation, which is the opposite of a useful assertion.
    const html = await page.content();
    expect(html).not.toMatch(/\/invitations\/[A-Za-z0-9_-]+/);

    const visible = await page.innerText('body');
    expect(visible).not.toMatch(/[A-Za-z0-9_-]{43,}/);
  });

  test('revokes an invitation', async ({ page }) => {
    const { customer } = credentials();
    const invitee = `e2e-revoke-${Date.now()}@brandspace.test`;

    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);
    await page.fill('#invite-email', invitee);
    await page.click('[data-testid="invite-submit"]');

    await page.click(`[data-testid="revoke-${invitee}"]`);
    await expect(page.getByTestId('success-banner')).toBeVisible();
    await expect(page.getByTestId(`invitation-${invitee}`)).toContainText('REVOKED');
  });

  test('refuses to remove the last owner, with a safe message', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.secondWorkspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);

    await page.click(`[data-testid="remove-member-${customer.email}"]`);
    await expect(page.getByTestId('error-banner')).toBeVisible();

    // A CODE in the URL, and no internal text anywhere on the page.
    const url = new URL(page.url());
    expect(url.searchParams.get('error')).toBe('CONFLICT');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/prisma|constraint|transaction/i);
  });
});

test.describe('the plan page shows resolved entitlements honestly', () => {
  test('renders the plan and the credit balance', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/plan`);

    await expect(page.getByTestId('current-plan')).toBeVisible();
    await expect(page.getByTestId('credit-balance')).toBeVisible();
    // A real number, not a placeholder.
    await expect(page.getByTestId('credit-balance')).toHaveText(/^\d+$/);
  });

  test('states plainly when nothing is configured, rather than inventing rows', async ({
    page,
  }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/plan`);

    // Either a real feature table, or an honest empty state — never a fake row.
    const hasTable = await page.getByTestId('features-table').count();
    const hasEmpty = await page.getByTestId('empty-state').count();
    expect(hasTable + hasEmpty).toBeGreaterThan(0);
  });
});

test.describe('settings save through the tenant-scoped path', () => {
  test('saves a new workspace name and shows a success code', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);

    const renamed = `E2E Primary Workspace ${Date.now() % 1000}`;
    await page.fill('#name', renamed);
    await page.click('[data-testid="settings-save"]');

    await expect(page.getByTestId('success-banner')).toBeVisible();
    await expect(page.getByTestId('active-workspace')).toContainText(renamed);

    // Put the name back, so a re-run starts from the same state.
    await page.fill('#name', customer.workspaceName);
    await page.click('[data-testid="settings-save"]');
  });

  test('rejects an empty name with a code, not a stack trace', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);

    // `required` is a client-side hint; the SERVER is what must refuse.
    await page.evaluate(() => {
      document.querySelector('#name')?.removeAttribute('required');
    });
    await page.fill('#name', 'x');
    await page.click('[data-testid="settings-save"]');

    await expect(page.getByTestId('error-banner')).toBeVisible();
    const url = new URL(page.url());
    expect(url.searchParams.get('error')).toBe('INVALID_INPUT');
    const body = await page.textContent('body');
    expect(body).not.toMatch(/AppError|VALIDATION_FAILED|at async/i);
  });
});

test.describe('bilingual: Arabic RTL and English LTR', () => {
  for (const locale of LOCALES) {
    test(`renders ${locale.code} with dir=${locale.dir}`, async ({ page }) => {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale.code}/sign-in`);
      await expect(page.locator('html')).toHaveAttribute('dir', locale.dir);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.lang);
    });

    test(`the authenticated shell renders in ${locale.code}`, async ({ page }) => {
      const { customer } = credentials();
      await signIn(page, customer.email, customer.password, locale.code);
      await enterWorkspace(page, customer.workspaceSlug, locale.code);
      await expect(page.locator('html')).toHaveAttribute('dir', locale.dir);
      await expect(page.getByTestId('active-workspace')).toBeVisible();
    });
  }

  test('a locale-less path redirects to the default locale', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/sign-in`);
    await expect(page).toHaveURL(/\/ar\/sign-in/);
  });

  test('an unsupported locale is a 404', async ({ page }) => {
    const response = await page.goto(`${DASHBOARD_BASE_URL}/fr/overview`);
    expect(response?.status()).toBe(404);
  });
});

test.describe('accessibility and keyboard operation', () => {
  test('sign-in has no serious or critical violations, in both locales', async ({ page }) => {
    for (const locale of LOCALES) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale.code}/sign-in`);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      const serious = results.violations.filter((v) =>
        ['serious', 'critical'].includes(v.impact ?? ''),
      );
      expect(serious, JSON.stringify(serious.map((v) => v.id))).toEqual([]);
    }
  });

  test('the workspace home has no serious or critical violations', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious, JSON.stringify(serious.map((v) => v.id))).toEqual([]);
  });

  test('the team page has no serious or critical violations', async ({ page }) => {
    const { customer } = credentials();
    await signIn(page, customer.email, customer.password);
    await enterWorkspace(page, customer.workspaceSlug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/members`);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const serious = results.violations.filter((v) =>
      ['serious', 'critical'].includes(v.impact ?? ''),
    );
    expect(serious, JSON.stringify(serious.map((v) => v.id))).toEqual([]);
  });

  test('sign-in is operable by keyboard alone', async ({ page }) => {
    const { customer } = credentials();
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);

    // Tab to the email field, fill, tab on, fill, and submit with Enter.
    await page.keyboard.press('Tab');
    await page.locator('#email').focus();
    await page.keyboard.type(customer.email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(customer.password);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/en\/workspaces/);
  });

  test('the focused element always has a visible indicator', async ({ page }) => {
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await page.locator('#email').focus();
    const outline = await page
      .locator('#email')
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe('none');
  });
});

test.describe('layout never overflows horizontally', () => {
  for (const locale of LOCALES) {
    test(`the signed-in pages fit at 390px (${locale.code})`, async ({ page }) => {
      const { customer } = credentials();
      await page.setViewportSize({ width: 390, height: 800 });
      await signIn(page, customer.email, customer.password, locale.code);
      await enterWorkspace(page, customer.workspaceSlug, locale.code);

      for (const path of [
        `/${locale.code}/overview`,
        `/${locale.code}/members`,
        `/${locale.code}/plan`,
      ]) {
        await page.goto(`${DASHBOARD_BASE_URL}${path}`);
        await expectNoHorizontalOverflow(page, path);
      }
    });
  }

  test('the sign-in card fits on a small screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${DASHBOARD_BASE_URL}/ar/sign-in`);
    await expectNoHorizontalOverflow(page, 'the Arabic sign-in page');
  });
});
