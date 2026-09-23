import crypto from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { withPlatformPrisma } from './platform-prisma';

/**
 * A CUSTOMER CAN TURN ON A SECOND FACTOR — Phase 4 §2.
 *
 * THE DEFECT THIS EXISTS FOR. `SignupService` has carried complete, tested
 * customer MFA since Phase 9 — enrolment, a live-code confirmation, hashed
 * recovery codes consumed exactly once, a disable that demands a working code —
 * and NOTHING IN THE PRODUCT CALLED ANY OF IT. The only callers were three API
 * routes the dashboard never uses, so the sole way for a customer to enrol was
 * for somebody to craft an HTTP request by hand with their session cookie.
 * `remainingRecoveryCodes`, whose own comment says it is "the number the
 * settings page shows", had no caller at all.
 *
 * A BROWSER TEST, because the gap was never in the service: every rule it
 * enforces was already proven by `phase9-account`. What was missing was a way in,
 * and only a browser can show that there is one.
 *
 * THE CODE IS COMPUTED FROM THE SEED THE SCREEN SHOWS. The page returns the
 * otpauth URI once, which is what an authenticator scans; this test reads it
 * from the page exactly as a phone would and derives the same six digits. No
 * seed is read out of the database, so the test proves the screen hands over
 * something that actually works.
 */

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'an-end-to-end-fixture-password';

/** The six digits an authenticator would show for this otpauth URI, right now. */
function codeFor(otpauthUri: string): string {
  const secret = new URL(otpauthUri.replace('otpauth://', 'https://')).searchParams.get('secret');
  if (!secret) throw new Error('the enrolment URI carried no seed');

  // RFC 4648 base32 → bytes, then RFC 6238 with the defaults the service uses.
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of secret.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const digest = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

async function signUpVerifyAndSignIn(page: Page): Promise<string> {
  const email = `sec-e2e-${crypto.randomUUID().slice(0, 12)}@example.local`;

  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-up`);
  await expect(page.locator('[data-testid="signup-form"]')).toBeVisible();
  await page.fill('#name', 'Security Settings');
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.fill('#password-confirm', PASSWORD);
  await page.fill('#timezone', 'Europe/London');
  await page.press('#timezone', 'Enter');
  await page.check('[data-testid="accept-terms-of-service"] input[type="checkbox"]');
  await page.click('[data-testid="signup-submit"]');
  await expect(page.locator('[data-testid="signup-sent"]')).toBeVisible();

  // The mailbox is not the subject here, so the token is minted directly.
  const token = await withPlatformPrisma(async (prisma) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    const raw = crypto.randomBytes(32).toString('base64url');
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        tokenHash: crypto.createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    return raw;
  });

  await page.goto(`${DASHBOARD_BASE_URL}/en/verify?token=${encodeURIComponent(token)}`);
  await expect(page.locator('[data-testid="verify-success"]')).toBeVisible();

  await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(/\/en\/onboarding\/workspace$/, { timeout: 30_000 });
  return email;
}

async function createWorkspace(page: Page): Promise<string> {
  await expect(page.locator('[data-testid="create-workspace-form"]')).toBeVisible();
  await page.fill('#name', 'Security Workspace');
  const slug = `sec-${crypto.randomUUID().slice(0, 8)}`;
  await page.fill('#slug', slug);
  const countryName = new Intl.DisplayNames(['en'], { type: 'region' }).of('GB') ?? 'GB';
  await page.fill('[data-testid="country-select"]', countryName);
  await page.press('[data-testid="country-select"]', 'Enter');
  await page.selectOption('#defaultLocale', 'EN');
  await page.fill('[data-testid="timezone-select"]', 'Europe/London');
  await page.press('[data-testid="timezone-select"]', 'Enter');
  await page.fill('#billingEmail', `finance-${crypto.randomUUID().slice(0, 8)}@example.local`);
  await page.click('[data-testid="create-workspace-submit"]');
  await page.waitForURL(/\/en\/onboarding$/, { timeout: 30_000 });
  return slug;
}

test.describe('customer security settings', () => {
  test('A CUSTOMER CAN ENROL, SEE RECOVERY CODES, AND TURN IT OFF AGAIN', async ({ page }) => {
    const email = await signUpVerifyAndSignIn(page);
    const slug = await createWorkspace(page);

    // REACHED FROM THE PRODUCT, not by typing a URL nobody links to: the row is
    // in the settings section nav for every member.
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
    await page.getByRole('link', { name: 'Security' }).first().click();
    await page.waitForURL(/\/en\/settings\/security$/, { timeout: 30_000 });

    await expect(page.getByTestId('mfa-state')).toHaveText('Off');

    // ENROL. Before Phase 4 there was no control here at all.
    await page.getByTestId('mfa-begin').click();
    await page.waitForURL(/otpauth=/, { timeout: 30_000 });
    const otpauth = (await page.getByTestId('mfa-otpauth').textContent()) ?? '';
    expect(otpauth).toContain('otpauth://totp/');

    await page.fill('[data-testid="mfa-code"]', codeFor(otpauth));
    await page.getByTestId('mfa-confirm').click();
    await page.waitForURL(/ok=MFA_ENABLED/, { timeout: 30_000 });

    await expect(page.getByTestId('mfa-state')).toHaveText('On');

    // THE RECOVERY CODES, ONCE. Losing a phone without them is how optional MFA
    // becomes MFA nobody switches on.
    const codes = page.getByTestId('recovery-codes');
    await expect(codes).toBeVisible();
    const issued = (await codes.locator('code').allTextContents()).filter(Boolean);
    expect(issued.length).toBeGreaterThanOrEqual(4);

    // And the count the settings page shows — `remainingRecoveryCodes`, which
    // until now had no caller anywhere.
    await expect(page.getByTestId('recovery-remaining')).toContainText(String(issued.length));

    /*
     * THE SECOND FACTOR IS NOW REALLY REQUIRED. Signing out and back in must
     * stop at the challenge rather than landing in the product — which is what
     * makes this a security control rather than a checkbox.
     */
    // A FRESH BROWSER. Visiting the sign-in page while still holding a session
    // simply bounces back into the product, so the cookie goes first.
    await page.context().clearCookies();
    await page.goto(`${DASHBOARD_BASE_URL}/en/sign-in`);
    await page.fill('#email', email);
    await page.fill('#password', PASSWORD);
    await page.click('[data-testid="signin-submit"]');
    await page.waitForURL(/\/en\/mfa$/, { timeout: 30_000 });

    // A RECOVERY CODE GETS PAST IT, exactly once.
    await page.fill('#code', issued[0]!);
    await page.click('[data-testid="mfa-submit"]');
    // A FRESH SESSION HAS NO ACTIVE WORKSPACE, so the landing path is the
    // picker rather than the overview. Either is past the challenge, which is
    // what this asserts.
    await page.waitForURL(/\/en\/(overview|onboarding|workspaces)/, { timeout: 30_000 });

    /*
     * THE NEW SESSION HAS NO ACTIVE WORKSPACE, so it must choose one before a
     * settings page will render — which is the product working as designed, not
     * a quirk: `requireWorkspace` sends a session with no workspace to the
     * picker rather than guessing one for them.
     */
    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    await page.getByTestId(`choose-workspace-${slug}`).click();
    await page.waitForURL(/\/en\/overview$/, { timeout: 30_000 });

    // TURN IT OFF — which costs a working code, not merely a session.
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/security`);
    await page.fill('[data-testid="mfa-disable-code"]', 'not-a-code');
    await page.getByTestId('mfa-disable').click();
    await page.waitForURL(/error=/, { timeout: 30_000 });
    await expect(page.getByTestId('mfa-state')).toHaveText('On');

    await page.fill('[data-testid="mfa-disable-code"]', issued[1]!);
    await page.getByTestId('mfa-disable').click();
    await page.waitForURL(/ok=MFA_DISABLED/, { timeout: 30_000 });
    await expect(page.getByTestId('mfa-state')).toHaveText('Off');
  });
});
