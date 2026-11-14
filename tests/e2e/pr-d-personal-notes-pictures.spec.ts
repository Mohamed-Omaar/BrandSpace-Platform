import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { withPlatformPrisma } from './platform-prisma';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';

/**
 * PR D (D-608) — MY NOTES, AVATARS AND THE WORKSPACE LOGO, in a browser.
 *
 *   1. My notes: write, search, pin, a reminder in the person's own zone,
 *      snooze, done, delete — in English and Arabic — and a teammate never
 *      sees the note.
 *   2. "Download my notes" returns the person's own notes only.
 *   3. A photo uploaded on the account page shows on the account card and on
 *      Team; a logo uploaded in Business settings shows on the business card;
 *      nobody outside a workspace can fetch its logo or a stranger's photo.
 */

// One owner account across these tests: run them in order, not side by side.
test.describe.configure({ mode: 'serial' });

/**
 * A GET from inside the page, so the browser sends the session cookie as it
 * would (the cookie is `Secure`, which the test runner's own HTTP client does
 * not send to plain-http localhost).
 */
async function fetchInPage(
  page: Page,
  url: string,
): Promise<{
  status: number;
  headers: Record<string, string>;
  text: string;
  square: boolean | null;
}> {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { credentials: 'same-origin', redirect: 'manual' });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const buffer = await response.arrayBuffer();
    const view = new DataView(buffer);
    // A PNG's IHDR: width at byte 16, height at byte 20.
    const square =
      buffer.byteLength > 24 && view.getUint32(0) === 0x89504e47
        ? view.getUint32(16) === view.getUint32(20)
        : null;
    return {
      status: response.status,
      headers,
      text: new TextDecoder().decode(buffer),
      square,
    };
  }, url);
}

function credentials(): E2eAdminCredentials {
  return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
}

type Who = 'owner' | 'viewer' | 'copywriter';
async function signInAs(page: Page, who: Who, locale: string): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  const account =
    who === 'owner'
      ? { email: customer.email, password: customer.password }
      : who === 'viewer'
        ? { email: customer.viewerEmail, password: customer.viewerPassword }
        : { email: customer.copywriterEmail, password: customer.copywriterPassword };
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

async function asTeammate(
  browser: Browser,
  locale: string,
  who: Who = 'copywriter',
): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signInAs(page, who, locale);
  return page;
}

/** A 6×4 purple PNG: a real picture the browser can decode and crop square. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAIAAAAiZtkUAAAAEUlEQVR4nGOoNP2HhhjIFQIA6N8oISqZw7QAAAAASUVORK5CYII=',
  'base64',
);

/** Tomorrow at 10:00 as a `datetime-local` value (the field is the person's own zone). */
function tomorrowAtTen(): string {
  const at = new Date(Date.now() + 86_400_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T10:00`;
}

test.afterAll(async () => {
  const loaded = credentials();
  await withPlatformPrisma(async (prisma) => {
    await prisma.user.updateMany({
      where: { email: loaded.customer.email },
      data: { avatarKey: null, avatarUpdatedAt: null },
    });
    await prisma.workspace.updateMany({
      where: { id: loaded.customer.workspaceId },
      data: { logoKey: null, logoUpdatedAt: null },
    });
  });
});

for (const locale of ['en', 'ar'] as const) {
  test(`My notes: write, search, pin, remind, snooze, done, delete; private to the writer (${locale})`, async ({
    page,
    browser,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the desktop run covers it; the phone layout is the screenshot');
    test.setTimeout(180_000);
    const title = `Private ${locale} ${randomUUID().slice(0, 6)}`;

    await signInAs(page, 'owner', locale);
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/notes`);
    // The team tab stays the default; "My notes" is beside it.
    await expect(page.getByTestId('notes-tab-team')).toHaveAttribute('aria-current', 'page');
    await page.getByTestId('notes-tab-mine').click();
    await expect(page).toHaveURL(/tab=mine/);
    await expect(page.getByTestId('notes-tab-mine')).toHaveAttribute('aria-current', 'page');

    // Write one.
    await page.getByTestId('my-notes-new').click();
    await page.getByTestId('my-note-title').fill(title);
    await page.getByTestId('my-note-body').fill('Line one\nLine two');
    await page.getByTestId('my-note-save').click();
    await expect(page).toHaveURL(/outcome=note-saved/);
    const row = page.locator('[data-testid^="my-note-"]').filter({ hasText: title }).first();
    await expect(row).toBeVisible();
    const noteId = new URL(page.url()).searchParams.get('note')!;
    expect(noteId).toMatch(/^[0-9a-f-]{36}$/);

    // Search finds it; a search for nothing does not.
    await page.getByTestId('my-notes-search').fill(title.slice(-6));
    await page.getByTestId('my-notes-search').press('Enter');
    await expect(page.getByTestId(`my-note-${noteId}`)).toBeVisible();
    await page.getByTestId('my-notes-search').fill(`zz-${randomUUID()}`);
    await page.getByTestId('my-notes-search').press('Enter');
    await expect(page.getByTestId('my-notes-empty')).toBeVisible();

    // Pin it.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/notes?tab=mine&note=${noteId}`);
    await page.getByTestId(`my-note-pin-${noteId}`).click();
    await expect(page.getByTestId(`my-note-${noteId}`).locator('.bsp-pill').first()).toBeVisible();

    // A reminder, in the browser's own zone.
    await expect(page.getByTestId('my-note-zone')).not.toHaveValue('');
    await page.getByTestId('my-note-remind-at').fill(tomorrowAtTen());
    await page.getByTestId('my-note-remind-set').click();
    await expect(page).toHaveURL(/outcome=reminder-set/);
    await expect(page.getByTestId('my-note-remind-at')).toHaveValue(tomorrowAtTen());

    // Snooze to tomorrow at 9:00, then done.
    await page.getByTestId('my-note-snooze-tomorrow').click();
    await expect(page).toHaveURL(/outcome=reminder-snoozed/);
    await page.getByTestId('my-note-done').click();
    await expect(page).toHaveURL(/outcome=reminder-done/);
    await expect(page.getByTestId('my-note-snooze-hour')).toHaveCount(0);

    // A teammate sees none of it — not the note, not its title, not a count.
    const viewer = await asTeammate(browser, locale);
    await viewer.goto(`${DASHBOARD_BASE_URL}/${locale}/notes?tab=mine`);
    await expect(viewer.getByTestId('my-notes')).toBeVisible();
    await expect(viewer.getByText(title)).toHaveCount(0);
    // Asking for it by id opens nothing.
    await viewer.goto(`${DASHBOARD_BASE_URL}/${locale}/notes?tab=mine&note=${noteId}`);
    await expect(viewer.getByTestId(`my-note-pane-${noteId}`)).toHaveCount(0);
    await expect(viewer.getByText(title)).toHaveCount(0);
    // And their download holds none of it.
    const theirs = await fetchInPage(viewer, `/${locale}/notes/export`);
    expect(theirs.status).toBe(200);
    expect(theirs.text).not.toContain(title);
    await viewer.context().close();

    // The writer's download holds it.
    const mine = await fetchInPage(page, `/${locale}/notes/export`);
    expect(mine.status).toBe(200);
    expect(mine.headers['content-disposition']).toMatch(
      /^attachment; filename="brandspace-my-notes-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const file = JSON.parse(mine.text) as { notes: { title: string; pinned: boolean }[] };
    expect(file.notes.find((n) => n.title === title)?.pinned).toBe(true);

    // Delete.
    await page.goto(`${DASHBOARD_BASE_URL}/${locale}/notes?tab=mine&note=${noteId}`);
    await page.getByTestId(`my-note-delete-${noteId}`).click();
    await expect(page).toHaveURL(/outcome=note-deleted/);
    await expect(page.getByTestId(`my-note-${noteId}`)).toHaveCount(0);
  });
}

test('Settings → Data offers "Download my notes" to every member', async ({ page, isMobile }) => {
  test.skip(isMobile === true, 'the desktop run covers it');
  await signInAs(page, 'owner', 'en');
  await page.goto(`${DASHBOARD_BASE_URL}/en/settings/data`);
  await expect(page.getByTestId('data-download-myNotes')).toHaveAttribute(
    'href',
    '/en/notes/export',
  );
});

test('A photo and a logo: uploaded, shown, and only to members', async ({
  page,
  browser,
  isMobile,
}) => {
  test.skip(isMobile === true, 'the desktop run covers it');
  test.setTimeout(180_000);
  const loaded = credentials();
  await signInAs(page, 'owner', 'en');

  // The photo, on the person's own account page.
  await page.goto(`${DASHBOARD_BASE_URL}/en/settings/security`);
  await expect(page.locator('.bsp-ucard-mark img')).toHaveCount(0);
  await page.getByTestId('avatar-upload-file').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  // The browser cropped it square: the preview is the new picture.
  await expect(page.getByTestId('avatar-upload').locator('img')).toBeVisible();
  await page.getByTestId('avatar-upload-save').click();
  await expect(page).toHaveURL(/ok=picture-saved/);
  const avatar = page.getByTestId('profile-avatar');
  await expect(avatar).toBeVisible();
  const src = (await avatar.getAttribute('src'))!;
  expect(src).toMatch(/^\/en\/people\/[0-9a-f-]{36}\/avatar\?v=\d+$/);
  const served = await fetchInPage(page, src);
  expect(served.status).toBe(200);
  expect(served.headers['content-type']).toBe('image/png');
  expect(served.headers['x-content-type-options']).toBe('nosniff');
  // Cropped square by the browser before it was sent (the original is 6 × 4).
  expect(served.square).toBe(true);

  // A teammate sees it on Team, beside the name.
  const viewer = await asTeammate(browser, 'en');
  await viewer.goto(`${DASHBOARD_BASE_URL}/en/members`);
  await expect(
    viewer.getByTestId(`member-${loaded.customer.email}`).locator('img.bsp-pic'),
  ).toBeVisible();

  // The logo, in Business settings, then on the business card.
  await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
  await page.getByTestId('workspace-logo-upload-file').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await page.getByTestId('workspace-logo-upload-save').click();
  await expect(page).toHaveURL(/ok=picture-saved/);
  // On the business list (and, where the rail card is the business, on the card).
  await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
  await expect(page.getByTestId(`workspace-logo-${loaded.customer.workspaceSlug}`)).toBeVisible();
  await page.goto(`${DASHBOARD_BASE_URL}/en/settings`);
  await expect(page.getByTestId('workspace-logo-upload').locator('img')).toBeVisible();

  // Refused on the server: bytes that are not the picture they claim to be (the
  // browser cannot draw them, so they are sent as they are).
  await page.getByTestId('workspace-logo-upload-file').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: Buffer.from('this is not a picture'),
  });
  await page.getByTestId('workspace-logo-upload-save').click();
  await expect(page).toHaveURL(/error=picture-type/);

  // Nobody outside a workspace reaches its logo, or a stranger's photo.
  const second = await withPlatformPrisma((prisma) =>
    prisma.workspace.findFirstOrThrow({
      where: { slug: loaded.customer.secondWorkspaceSlug },
      select: { id: true },
    }),
  );
  const viewerIsMember = await withPlatformPrisma((prisma) =>
    prisma.membership.count({
      where: { workspaceId: second.id, user: { email: loaded.customer.copywriterEmail } },
    }),
  );
  if (viewerIsMember === 0) {
    const logo = await fetchInPage(viewer, `/en/workspace-logo/${second.id}`);
    expect(logo.status).toBe(404);
  }
  const stranger = await fetchInPage(viewer, `/en/people/${randomUUID()}/avatar`);
  expect(stranger.status).toBe(404);
  await viewer.context().close();

  // Removed: the initials come back.
  await page.goto(`${DASHBOARD_BASE_URL}/en/settings/security`);
  await page.getByTestId('avatar-upload-remove').click();
  await expect(page).toHaveURL(/ok=picture-removed/);
  await expect(page.getByTestId('profile-avatar')).toHaveCount(0);
});
