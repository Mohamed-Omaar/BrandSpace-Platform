import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_BASE_URL, LOCALES } from './apps';
import { expectNoHorizontalOverflow } from './overflow';
// Shared with `plans-entitlements.spec.ts`. One sign-in helper, so the MFA
// step D-27 requires cannot drift between specs.
import { credentials, signIn, submitPassword, totpCode } from './admin-session';

/**
 * Platform Admin Control Center — end-to-end.
 *
 * These journeys use a THROWAWAY account created by `pnpm e2e:seed` moments
 * before the run: a generated password, a generated TOTP seed, generated
 * recovery codes. Nothing here is a real credential and nothing is committed.
 *
 * The assertions that matter most are the negative ones:
 *   - the console is unreachable without a session,
 *   - a password-only session is unreachable too (D-27),
 *   - a stored secret's value never appears in any response, ever.
 */

test.describe.configure({ mode: 'serial' });

const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

/** Press Tab until the element with `testId` has focus. Returns how many. */
async function tabUntilFocused(page: Page, testId: string, max: number): Promise<number> {
  for (let pressed = 1; pressed <= max; pressed += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(
      (id) => document.activeElement?.getAttribute('data-testid') === id,
      testId,
    );
    if (focused) return pressed;
  }
  const actual = await page.evaluate(
    () => document.activeElement?.outerHTML?.slice(0, 120) ?? null,
  );
  throw new Error(`"${testId}" was not focused within ${max} tab presses; focus was on ${actual}`);
}

async function expectNoBlockingA11yViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ''));
  const detail = blocking
    .map(
      (v) =>
        `  [${v.impact}] ${v.id}: ${v.help}\n` +
        v.nodes.map((n) => `      ${n.target.join(' ')}`).join('\n'),
    )
    .join('\n');
  expect(blocking, `serious/critical a11y violations on ${label}:\n${detail}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test.describe('the Control Center is unreachable without a verified session', () => {
  for (const path of [
    '/console',
    '/console/configuration',
    '/console/secrets',
    '/console/plans',
    '/console/features',
    '/console/audit',
    '/console/health',
  ]) {
    test(`redirects an anonymous visitor away from ${path}`, async ({ page }) => {
      await page.goto(`${ADMIN_BASE_URL}/en${path}`);
      await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);
      await expect(page.getByTestId('heading')).toBeVisible();
    });
  }

  test('the application root sends an anonymous visitor to sign in', async ({ page }) => {
    await page.goto(`${ADMIN_BASE_URL}/en`);
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);
  });

  test('a forged session cookie grants nothing', async ({ request }) => {
    // Sent as a raw header rather than through the cookie jar: a `__Host-`
    // cookie cannot be injected over http even on localhost, and the point is
    // what the SERVER does with an unknown token, not what the browser stores.
    const response = await request.get(`${ADMIN_BASE_URL}/en/console`, {
      headers: { cookie: '__Host-bs_platform_session=forged-token-not-in-the-session-store' },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(307);
    expect(response.headers()['location']).toBe('/en/login');
  });

  test('a session id from the database is not a usable token', async ({ request }) => {
    // Sessions are stored as a SHA-256 hash of the token, so even full read
    // access to platform_session yields nothing that can be replayed.
    const response = await request.get(`${ADMIN_BASE_URL}/en/console`, {
      headers: { cookie: `__Host-bs_platform_session=${'a'.repeat(43)}` },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(307);
    expect(response.headers()['location']).toBe('/en/login');
  });

  test('is never indexable', async ({ page }) => {
    await page.goto(`${ADMIN_BASE_URL}/en/login`);
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');
  });
});

// ---------------------------------------------------------------------------
// Authentication and MFA (D-27)
// ---------------------------------------------------------------------------

test.describe('sign-in requires a password AND a second factor', () => {
  test('rejects a wrong password without saying why', async ({ page }) => {
    await page.goto(`${ADMIN_BASE_URL}/en/login`);
    await page.getByTestId('email').fill(credentials().email);
    await page.getByTestId('password').fill('this is not the password');
    await page.getByTestId('submit').click();

    await expect(page).toHaveURL(/\/en\/login\?error=1$/);
    const message = await page.getByTestId('login-error').textContent();
    expect(message).toBe('Invalid credentials.');
    // No hint about which half was wrong, and no session was issued.
    await page.goto(`${ADMIN_BASE_URL}/en/console`);
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);
  });

  test('gives the same message for an unknown account', async ({ page }) => {
    await page.goto(`${ADMIN_BASE_URL}/en/login`);
    await page.getByTestId('email').fill('nobody-at-all@brandspace.test');
    await page.getByTestId('password').fill('this is not the password');
    await page.getByTestId('submit').click();

    await expect(page).toHaveURL(/\/en\/login\?error=1$/);
    expect(await page.getByTestId('login-error').textContent()).toBe('Invalid credentials.');
  });

  test('a correct password alone does NOT open the console', async ({ page }) => {
    // The single most important assertion in this file. A stolen password, or a
    // stolen pre-MFA cookie, must be worth nothing.
    await submitPassword(page, 'en');
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/mfa`);

    await page.goto(`${ADMIN_BASE_URL}/en/console`);
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);

    await page.goto(`${ADMIN_BASE_URL}/en/console/secrets`);
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);
  });

  test('rejects a wrong verification code', async ({ page }) => {
    await submitPassword(page, 'en');
    await page.getByTestId('mfa-code').fill('000000');
    await page.getByTestId('submit').click();

    await expect(page).toHaveURL(/\/en\/mfa\?error=1$/);
    expect(await page.getByTestId('mfa-error').textContent()).toBe('Invalid verification code.');
  });

  test('the MFA page is unreachable without a pre-MFA session', async ({ page }) => {
    await page.goto(`${ADMIN_BASE_URL}/en/mfa`);
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);
  });

  test('a valid code opens the console and shows who is signed in', async ({ page }) => {
    await signIn(page, 'en');

    await expect(page.getByTestId('actor-identity')).toContainText(credentials().email);
    await expect(page.getByTestId('environment-badge')).toBeVisible();
    await expect(page.getByTestId('stat-environment')).toContainText('DEVELOPMENT');
  });

  test('signing out ends the session immediately', async ({ page }) => {
    await signIn(page, 'en');
    /* Sign-out sits inside the operator's profile-card menu (fidelity pass §8). */
    await page.getByTestId('profile-menu').click();
    await page.getByTestId('sign-out').click();

    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);
    await page.goto(`${ADMIN_BASE_URL}/en/console`);
    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/login`);
  });
});

// ---------------------------------------------------------------------------
// Configuration lifecycle
// ---------------------------------------------------------------------------

test.describe('the configuration lifecycle works end to end', () => {
  test('draft, edit, validate, activate — and the change is what takes effect', async ({
    page,
  }) => {
    await signIn(page, 'en');
    await page.getByTestId('nav-nav.configuration').click();
    await expect(page).toHaveURL(/\/en\/console\/configuration/);

    // A domain with no prices and no cross-domain references: the point here is
    // the lifecycle, not the payload.
    await page.getByTestId('domain-operations').click();
    await expect(page.getByTestId('domain-operations')).toHaveAttribute('aria-current', 'page');

    await page.getByTestId('draft-reason').fill('End-to-end verification of the draft lifecycle');
    await page.getByTestId('create-draft').click();
    await expect(page.getByTestId('config-ok')).toContainText('Draft created');

    const draftRow = page.locator('[data-testid^="version-"]').first();
    await expect(draftRow).toBeVisible();
    const versionNumber = (await draftRow.getAttribute('data-testid'))!.replace('version-', '');
    await expect(page.getByTestId(`status-${versionNumber}`)).toHaveText('DRAFT');

    // Edit the payload: without this the console could create and activate
    // drafts but never actually change a setting.
    const current = JSON.parse(await page.getByTestId('draft-payload').inputValue()) as {
      trialDefaultDays: number;
    };
    await page
      .getByTestId('draft-payload')
      .fill(JSON.stringify({ ...current, trialDefaultDays: 21 }, null, 2));
    await page.getByTestId('save-draft').click();
    await expect(page.getByTestId('config-ok')).toContainText('Draft saved');

    await page.getByTestId(`validate-${versionNumber}`).click();
    await expect(page.getByTestId('config-ok')).toContainText('Valid.');

    await page.getByTestId(`activate-${versionNumber}`).click();
    await expect(page.getByTestId('config-ok')).toContainText('Configuration activated');
    await expect(page.getByTestId(`status-${versionNumber}`)).toHaveText('ACTIVE');

    // The activated value is what the next draft starts from, which is the only
    // observable proof that activation changed the effective configuration.
    await page.getByTestId('draft-reason').fill('Confirm the activated value is the new baseline');
    await page.getByTestId('create-draft').click();
    const seeded = JSON.parse(await page.getByTestId('draft-payload').inputValue()) as {
      trialDefaultDays: number;
    };
    expect(seeded.trialDefaultDays).toBe(21);
  });

  test('an invalid draft is refused at validation AND at activation', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/configuration?domain=operations`);

    // A draft is already open from the previous test; edit it to something the
    // schema rejects. 9999 minutes of support-mode access is far past the cap.
    const versionNumber = (await page
      .locator('[data-testid^="version-"]')
      .first()
      .getAttribute('data-testid'))!.replace('version-', '');

    const current = JSON.parse(await page.getByTestId('draft-payload').inputValue()) as Record<
      string,
      unknown
    >;
    await page
      .getByTestId('draft-payload')
      .fill(JSON.stringify({ ...current, supportModeTtlMinutes: 9999 }, null, 2));
    await page.getByTestId('save-draft').click();
    await expect(page.getByTestId('config-ok')).toContainText('Draft saved');

    await page.getByTestId(`validate-${versionNumber}`).click();
    await expect(page.getByTestId('config-ok')).toContainText('validation error');
    await expect(page.getByTestId(`status-${versionNumber}`)).toHaveText('DRAFT');

    // Activation re-validates server-side. A page that somehow offered the
    // button anyway must still not be able to deploy an invalid document.
    await page.getByTestId(`activate-${versionNumber}`).click();
    await expect(page.getByTestId('config-error')).toBeVisible();
    await expect(page.getByTestId(`status-${versionNumber}`)).toHaveText('DRAFT');
  });

  test('malformed JSON is rejected without a stack trace', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/configuration?domain=operations`);

    await page.getByTestId('draft-payload').fill('{ not json at all');
    await page.getByTestId('save-draft').click();

    await expect(page.getByTestId('config-error')).toContainText('The payload is not valid JSON.');

    // The URL carries a CODE and an opaque correlation id — never a parser
    // message, which would echo a fragment of the submitted payload.
    const params = new URL(page.url()).searchParams;
    expect(params.get('error')).toBe('INVALID_JSON');
    expect(params.get('ref')).toMatch(/^[0-9a-f-]{36}$/);
    expect(page.url()).not.toContain('not json at all');
    expect(page.url()).not.toContain('JSON.parse');
    expect(page.url()).not.toContain('SyntaxError');

    // The reference is shown so an operator can quote it against the log.
    await expect(page.getByTestId('config-error')).toContainText(params.get('ref')!);
  });

  test('a failed action puts no internal detail in the address bar', async ({ page }) => {
    await signIn(page, 'en');
    // Its own domain and its own draft: this assertion is about the error
    // boundary, so it must not depend on what earlier tests left behind.
    await page.goto(`${ADMIN_BASE_URL}/en/console/configuration?domain=usage-limits`);
    await page.getByTestId('draft-reason').fill('Error-boundary check for the address bar');
    await page.getByTestId('create-draft').click();
    await expect(page.getByTestId('config-ok')).toContainText('Draft created');

    // The version the EDITOR is bound to, read from its own label, so the
    // version edited and the version activated are guaranteed to be the same.
    const label = (await page.locator('label[for="payload"]').textContent())!;
    const versionNumber = /v(\d+)/.exec(label)![1]!;

    // A payload the schema rejects: `maxItems` must be a positive integer.
    await page.getByTestId('draft-payload').fill(JSON.stringify({ limits: 'not-an-object' }));
    await page.getByTestId('save-draft').click();
    await expect(page.getByTestId('config-ok')).toContainText('Draft saved');

    await page.getByTestId(`activate-${versionNumber}`).click();
    await expect(page.getByTestId('config-error')).toBeVisible();

    const url = page.url();
    for (const fragment of [
      'postgresql://',
      'prisma',
      'secret_record',
      'Error:',
      'at ',
      'not-an-object',
    ]) {
      expect(url, `the URL must not carry "${fragment}"`).not.toContain(fragment);
    }
    const code = new URL(url).searchParams.get('error');
    expect(code).toBe('INVALID_INPUT');
    expect(new URL(url).searchParams.get('ref')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('a concurrent edit is refused rather than silently overwriting', async ({
    page,
    context,
  }) => {
    await signIn(page, 'en');
    const url = `${ADMIN_BASE_URL}/en/console/configuration?domain=operations`;
    await page.goto(url);

    // Two administrators with the same draft open. The second one to save is
    // working from a stale view.
    const second = await context.newPage();
    await second.goto(url);

    const firstPayload = JSON.parse(await page.getByTestId('draft-payload').inputValue()) as Record<
      string,
      unknown
    >;
    await page
      .getByTestId('draft-payload')
      .fill(JSON.stringify({ ...firstPayload, trialDefaultDays: 31 }, null, 2));
    await page.getByTestId('save-draft').click();
    await expect(page.getByTestId('config-ok')).toContainText('Draft saved');

    const secondPayload = JSON.parse(
      await second.getByTestId('draft-payload').inputValue(),
    ) as Record<string, unknown>;
    await second
      .getByTestId('draft-payload')
      .fill(JSON.stringify({ ...secondPayload, trialDefaultDays: 99 }, null, 2));
    await second.getByTestId('save-draft').click();

    await expect(second.getByTestId('config-error')).toContainText('changed by someone else');

    // The first administrator's edit survived intact.
    await page.reload();
    const saved = JSON.parse(await page.getByTestId('draft-payload').inputValue()) as {
      trialDefaultDays: number;
    };
    expect(saved.trialDefaultDays).toBe(31);
    await second.close();
  });

  test('an ACTIVE version cannot be edited at all', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/configuration?domain=operations`);

    // The editor is bound to the draft, never to the deployed version.
    const editedVersion = await page.getByTestId('draft-payload').getAttribute('id');
    expect(editedVersion).toBe('payload');

    const activeRows = page.locator('[data-testid^="status-"]');
    const statuses = await activeRows.allTextContents();
    expect(statuses).toContain('ACTIVE');

    const label = await page.locator('label[for="payload"]').textContent();
    const activeVersionNumbers = await Promise.all(
      (await page.locator('tr[data-testid^="version-"]').all()).map(async (row) => ({
        version: (await row.getAttribute('data-testid'))!.replace('version-', ''),
        status: (await row.locator('[data-testid^="status-"]').textContent())!,
      })),
    );
    const active = activeVersionNumbers.find((v) => v.status === 'ACTIVE')!;
    expect(label).not.toContain(`v${active.version} `);
  });

  test('a change reason is required, and the browser enforces it before the server does', async ({
    page,
  }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/configuration?domain=website`);

    await page.getByTestId('draft-reason').fill('short');
    await page.getByTestId('create-draft').click();

    // Still on the same page: the form never submitted.
    await expect(page).toHaveURL(/\/en\/console\/configuration/);
    const validity = await page
      .getByTestId('draft-reason')
      .evaluate((el) => (el as HTMLInputElement).validity.valid);
    expect(validity).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Secrets: stored, masked, never revealed
// ---------------------------------------------------------------------------

test.describe('secrets are stored but never shown', () => {
  // A fake value with a shape a scanner would flag, so the assertion is not
  // trivially satisfied by an empty string.
  const FAKE_VALUE = 'e2e-fake-provider-key-8f21c0a4d7b93e56';
  const SECRET_NAME = `e2e ${Date.now()}`;

  test('stores a secret and shows only masked metadata', async ({ page }) => {
    await signIn(page, 'en');
    await page.getByTestId('nav-nav.secrets').click();
    await expect(page).toHaveURL(/\/en\/console\/secrets/);

    await expect(page.getByTestId('no-reveal-notice')).toBeVisible();

    await page.getByTestId('secret-name').fill(SECRET_NAME);
    await page.getByTestId('secret-category').selectOption('ai_provider');
    await page.getByTestId('secret-provider').fill('e2e-provider');
    await page.getByTestId('secret-value').fill(FAKE_VALUE);
    await page.getByTestId('secret-save').click();

    await expect(page.getByTestId('secret-ok')).toContainText('stored');

    // The value must not be anywhere in the rendered page.
    expect(await page.content()).not.toContain(FAKE_VALUE);

    // Find the row for THIS secret rather than whichever row happens to be
    // first: an assertion against another secret's mask proves nothing.
    const row = page.locator('tr', { hasText: SECRET_NAME });
    await expect(row).toHaveCount(1);
    const maskedText = (await row.locator('[data-testid^="masked-"]').textContent())!;

    expect(maskedText).not.toContain(FAKE_VALUE);
    // At most the last four characters are ever shown, behind an ellipsis.
    expect(maskedText).toMatch(/^(….{4}|••••)$/u);
    expect(FAKE_VALUE).toContain(maskedText.replace('…', ''));

    // The fingerprint lets an operator answer "is this the key I meant?"
    // without anything being decrypted.
    const fingerprint = (await row.locator('[data-testid^="fingerprint-"]').textContent())!;
    expect(fingerprint).toMatch(/^[0-9a-f]{6,}…?$/);
    expect(FAKE_VALUE).not.toContain(fingerprint.replace('…', ''));
  });

  test('the stored value is absent from the raw HTTP response, not just the DOM', async ({
    page,
  }) => {
    await signIn(page, 'en');
    const response = await page.goto(`${ADMIN_BASE_URL}/en/console/secrets`);
    const body = await response!.text();

    expect(body).not.toContain(FAKE_VALUE);
    // Nor the value the seed stored for MFA.
    expect(body).not.toContain(credentials().totpSecret);
    expect(body).not.toContain(credentials().password);
  });

  test('offers no reveal control of any kind', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/secrets`);

    // Every control a person could press, by its accessible name. A page that
    // cannot decrypt has nothing to put behind such a button; this asserts that
    // no one added one.
    const controls = await page
      .locator('button, a[href], [role="button"]')
      .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim().toLowerCase()));

    expect(
      controls.length,
      'the page must have controls for this to mean anything',
    ).toBeGreaterThan(0);
    for (const name of controls) {
      expect(name, `"${name}" looks like a control that would display a stored secret`).not.toMatch(
        /reveal|unmask|decrypt|show (secret|value|key)|copy (secret|value|key)/,
      );
    }

    // And no field is pre-filled with anything: a value input that arrives
    // populated would mean the server sent a stored secret back.
    const prefilled = await page
      .locator('input[type="password"], input[type="text"], textarea')
      .evaluateAll((els) =>
        els
          .map((el) => (el as HTMLInputElement | HTMLTextAreaElement).value)
          .filter((v) => v !== ''),
      );
    expect(prefilled).toEqual([]);
  });

  test('rotates a secret without ever displaying either value', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console/secrets`);

    const rotateButton = page
      .locator(
        '[data-testid^="rotate-"]:not([data-testid^="rotate-value"]):not([data-testid^="rotate-reason"])',
      )
      .first();
    const ref = (await rotateButton.getAttribute('data-testid'))!.replace('rotate-', '');
    const NEW_VALUE = 'e2e-fake-provider-key-rotated-4c17be09';

    await page.getByTestId(`rotate-value-${ref}`).fill(NEW_VALUE);
    await page.getByTestId(`rotate-reason-${ref}`).fill('End-to-end rotation check');
    await page.getByTestId(`rotate-${ref}`).click();

    await expect(page.getByTestId('secret-ok')).toContainText('rotated');
    const html = await page.content();
    expect(html).not.toContain(NEW_VALUE);
    expect(html).not.toContain(FAKE_VALUE);
  });
});

// ---------------------------------------------------------------------------
// Bilingual rendering
// ---------------------------------------------------------------------------

test.describe('the Control Center is bilingual in both directions', () => {
  for (const locale of LOCALES) {
    test(`renders the sign-in page as ${locale.code} with dir=${locale.dir}`, async ({ page }) => {
      await page.goto(`${ADMIN_BASE_URL}/${locale.code}/login`);

      await expect(page.locator('html')).toHaveAttribute('dir', locale.dir);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.lang);
      await expect(page.getByTestId('heading')).toBeVisible();
      expect(await page.locator('h1').count()).toBe(1);
      await expect(page.locator('main#main')).toBeVisible();
    });

    test(`renders the console as ${locale.code} with dir=${locale.dir}`, async ({ page }) => {
      await signIn(page, locale.code);

      await expect(page.locator('html')).toHaveAttribute('dir', locale.dir);
      await expect(page.locator('html')).toHaveAttribute('lang', locale.lang);
      expect(await page.locator('h1').count()).toBe(1);
      expect(await page.locator('main').count()).toBe(1);
      expect(await page.locator('nav').count()).toBeGreaterThanOrEqual(1);
    });
  }

  test('an unsupported locale is a 404, not a silent fallback', async ({ page }) => {
    const response = await page.goto(`${ADMIN_BASE_URL}/fr/login`);
    expect(response?.status()).toBe(404);
  });

  test('switching locale switches direction', async ({ page }) => {
    await signIn(page, 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    await page.getByTestId('locale-switch').click();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

test.describe('the Control Center is operable by keyboard alone', () => {
  test('the skip link is the first tab stop on the sign-in page', async ({ page }) => {
    await page.goto(`${ADMIN_BASE_URL}/en/login`);
    await page.keyboard.press('Tab');

    const skip = page.getByTestId('skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
  });

  test('the whole sign-in flow can be completed without a mouse', async ({ page }) => {
    const { email, password, totpSecret } = credentials();
    await page.goto(`${ADMIN_BASE_URL}/en/login`);

    await page.keyboard.press('Tab'); // skip link
    await page.keyboard.press('Tab'); // email
    await expect(page.getByTestId('email')).toBeFocused();
    await page.keyboard.type(email);

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('password')).toBeFocused();
    await page.keyboard.type(password);

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('submit')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/mfa`);
    await expect(page.getByTestId('mfa-code')).toBeVisible();

    // Tab until the code field has focus. Bounded at three so this still fails
    // if the field is buried behind a pile of other stops, but it does not
    // depend on exactly when the freshly navigated document takes focus.
    const tabs = await tabUntilFocused(page, 'mfa-code', 3);
    expect(tabs, 'the verification code field should be an early tab stop').toBeLessThanOrEqual(3);

    await page.keyboard.type(totpCode(totpSecret));
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(`${ADMIN_BASE_URL}/en/console`);
  });

  test('every console navigation link is reachable by Tab', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console`);

    const links = page.locator('nav a[data-testid^="nav-"]');
    const total = await links.count();
    expect(total, 'the console must have navigation links').toBeGreaterThan(0);

    const reached = new Set<string>();
    for (let i = 0; i < total + 12; i += 1) {
      await page.keyboard.press('Tab');
      const marker = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return el.getAttribute('data-testid');
      });
      if (marker) reached.add(marker);
    }

    for (const testid of await links.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')!),
    )) {
      expect(reached, `${testid} was not reachable by Tab`).toContain(testid);
    }
  });

  test('the focused element always has a visible focus indicator', async ({ page }) => {
    await signIn(page, 'en');
    // A fresh navigation, so tab order starts at the top of the document rather
    // than from wherever the sign-in submission left focus.
    await page.goto(`${ADMIN_BASE_URL}/en/console`);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');

    const indicator = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const style = window.getComputedStyle(el);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });

    expect(indicator).not.toBeNull();
    const hasOutline =
      indicator!.outlineStyle !== 'none' && parseFloat(indicator!.outlineWidth) > 0;
    const hasRing = indicator!.boxShadow !== 'none' && indicator!.boxShadow !== '';
    expect(hasOutline || hasRing, `focus indicator missing: ${JSON.stringify(indicator)}`).toBe(
      true,
    );
  });

  test('the skip link moves focus to the main landmark', async ({ page }) => {
    await signIn(page, 'en');
    await page.goto(`${ADMIN_BASE_URL}/en/console`);

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('skip-link')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/#main$/);
    await expect(page.locator('main#main')).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Accessibility and layout
// ---------------------------------------------------------------------------

const CONSOLE_PAGES = [
  '/console',
  '/console/configuration',
  '/console/secrets',
  '/console/providers',
  '/console/ai-models',
  '/console/routing',
  '/console/flags',
  '/console/plans',
  // Phase 3. The registry joins the a11y and overflow sweeps like every other
  // console page — a new screen that nobody checks is how the first blocking
  // violation ships.
  '/console/features',
  '/console/audit',
  '/console/health',
] as const;

test.describe('accessibility', () => {
  for (const locale of ['ar', 'en'] as const) {
    test(`the sign-in page has no serious or critical violations (${locale})`, async ({ page }) => {
      await page.goto(`${ADMIN_BASE_URL}/${locale}/login`);
      await expectNoBlockingA11yViolations(page, `${locale}/login`);
    });
  }

  // One test per page rather than one loop over ten. An axe scan of a page with
  // a long version history is not fast, and a single shared timeout turns a slow
  // page into an unattributable failure of all ten.
  for (const path of CONSOLE_PAGES) {
    test(`${path} has no serious or critical violations`, async ({ page }) => {
      await signIn(page, 'en');
      await page.goto(`${ADMIN_BASE_URL}/en${path}`);
      await expectNoBlockingA11yViolations(page, path);
    });
  }

  for (const path of ['/console', '/console/configuration', '/console/secrets']) {
    test(`${path} has no serious or critical violations in Arabic`, async ({ page }) => {
      await signIn(page, 'ar');
      await page.goto(`${ADMIN_BASE_URL}/ar${path}`);
      await expectNoBlockingA11yViolations(page, `ar${path}`);
    });
  }
});

test.describe('layout never overflows horizontally', () => {
  const VIEWPORTS = [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 390, height: 844 },
  ] as const;

  for (const viewport of VIEWPORTS) {
    for (const locale of ['ar', 'en'] as const) {
      test(`console pages fit at ${viewport.name} (${locale})`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await signIn(page, locale);

        for (const path of CONSOLE_PAGES) {
          await page.goto(`${ADMIN_BASE_URL}/${locale}${path}`);
          await expectNoHorizontalOverflow(page, `${locale}${path}`);
        }
      });
    }
  }

  test('the sign-in page fits on a small screen in both directions', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const locale of ['ar', 'en'] as const) {
      await page.goto(`${ADMIN_BASE_URL}/${locale}/login`);
      await expectNoHorizontalOverflow(page, `${locale} sign-in`);
      await expect(page.getByTestId('heading')).toBeInViewport();
    }
  });
});
