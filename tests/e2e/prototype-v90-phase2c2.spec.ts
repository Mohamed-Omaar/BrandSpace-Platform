import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { useBrand } from './brand';
import { E2E_CREDENTIALS_FILE, brandFixtures, type E2eAdminCredentials } from './env';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v90, Phase 2C-2 — Brand Brain → Look & voice: colours, logo and
 * fonts, as a person meets them in a real browser.
 *
 * EVERY TEST CREATES ITS OWN WORKSPACE with one brand, and runs once (the
 * desktop project). Uploaded files go through the real upload path and the real
 * worker; the tests wait for the worker the way a person would, by reloading.
 * What the services enforce is proven against PostgreSQL in
 * tests/isolation/phase2c2-brand-fonts.test.ts.
 */

// Playwright runs from the repository root.
const ROOT = process.cwd();
const bundled = (file: string) =>
  readFileSync(path.join(ROOT, 'apps/dashboard/public/fonts', file));

function credentials(): E2eAdminCredentials {
  try {
    return JSON.parse(readFileSync(E2E_CREDENTIALS_FILE, 'utf8')) as E2eAdminCredentials;
  } catch {
    throw new Error('The end-to-end credentials file is missing. Run `pnpm e2e:seed` first.');
  }
}

async function signIn(page: Page, locale = 'en'): Promise<void> {
  const loaded = credentials();
  const { customer } = loaded;
  await useBrand(page, customer.workspaceId, brandFixtures(loaded).primaryBrandId);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/sign-in`);
  await page.fill('#email', customer.email);
  await page.fill('#password', customer.password);
  await page.click('[data-testid="signin-submit"]');
  await page.waitForURL(
    (url) => !url.pathname.endsWith('/sign-in') || url.searchParams.has('error'),
  );
  await page.click(`[data-testid="choose-workspace-${customer.workspaceSlug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

/** A workspace of its own, owned by the e2e customer, with one ACTIVE brand. */
async function ownWorkspace(
  label: string,
): Promise<{ slug: string; brandId: string; workspaceId: string }> {
  const { customer } = credentials();
  const slug = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  const brandId = randomUUID();
  const workspaceId = randomUUID();
  await withPlatformPrisma(async (prisma) => {
    const owner = await prisma.user.findFirstOrThrow({
      where: { email: customer.email },
      select: { id: true },
    });
    const role = await prisma.role.findFirstOrThrow({
      where: { key: 'workspace_owner', workspaceId: null },
      select: { id: true },
    });
    await prisma.workspace.create({
      data: {
        id: workspaceId,
        workspaceId,
        slug,
        name: `E2E ${label} ${slug.slice(-8)}`,
        ownerUserId: owner.id,
        status: 'ACTIVE',
        country: 'US',
        defaultLocale: 'EN',
        timezone: 'UTC',
        currency: 'USD',
      },
    });
    await prisma.membership.create({
      data: {
        workspaceId,
        userId: owner.id,
        roleId: role.id,
        status: 'ACTIVE',
        acceptedAt: new Date(),
      },
    });
    await prisma.brand.create({
      data: {
        id: brandId,
        workspaceId,
        slug: `${slug}-brand`,
        name: `${label} Brand`,
        status: 'ACTIVE',
      },
    });
  });
  return { slug, brandId, workspaceId };
}

async function enter(page: Page, slug: string, locale = 'en'): Promise<void> {
  await signIn(page, locale);
  await page.goto(`${DASHBOARD_BASE_URL}/${locale}/workspaces`);
  await page.click(`[data-testid="choose-workspace-${slug}"]`);
  await page.waitForURL(new RegExp(`/${locale}/overview$`));
}

const look = (page: Page, brandId: string, locale = 'en') =>
  page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain?brand=${brandId}&tab=look`);

/** Wait for the worker: reload until the asset is READY + CLEAN. */
async function waitForReady(assetWhere: { brandId: string; kind: 'IMAGE' | 'FONT' }) {
  await expect
    .poll(
      () =>
        withPlatformPrisma((prisma) =>
          prisma.asset.count({
            where: { ...assetWhere, status: 'READY', scanStatus: 'CLEAN', archivedAt: null },
          }),
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
}

async function noSeriousViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) =>
    ['serious', 'critical'].includes(v.impact ?? ''),
  );
  expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test.describe('Item 3 · Look & voice — navigation, both languages, keyboard', () => {
  for (const locale of ['en', 'ar'] as const) {
    test(`the Look card is on the Look & voice tab, accessible — ${locale}`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
      const { slug, brandId } = await ownWorkspace(`look-${locale}`);
      await enter(page, slug, locale);
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/brand-brain?brand=${brandId}`);
      // By keyboard: focus the selected tab and move with the arrow key to Look & voice.
      await page.getByTestId('tab-knowledge').focus();
      await page.keyboard.press(locale === 'ar' ? 'ArrowLeft' : 'ArrowRight');
      await expect(page.getByTestId('tab-look')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('look-card')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      await expect(page.getByTestId('look-fonts')).toBeVisible();
      await expect(page.getByTestId('look-uploaded')).toBeVisible();
      await noSeriousViolations(page);
    });
  }
});

test.describe('Item 3 · colours and logo', () => {
  test('colours are edited with a labelled colour input and saved to the brand palette', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId } = await ownWorkspace('colours');
    await enter(page, slug);
    await look(page, brandId);
    await page.getByTestId('look-colour-add').click();
    await page.getByTestId('look-colour-add').click();
    await expect(page.getByLabel('Colour 1', { exact: true })).toBeVisible();
    await page.getByTestId('look-colour-hex-0').fill('#123456');
    await page.getByTestId('look-colour-hex-1').fill('#FFDD15');
    await page.getByTestId('look-colours-save').click();
    await page.waitForURL(/ok=BRAND_COLOURS_SAVED/);
    await expect(page.getByTestId('look-colour-hex-0')).toHaveValue('#123456');
    const stored = await withPlatformPrisma((prisma) =>
      prisma.brand.findUniqueOrThrow({ where: { id: brandId }, select: { colorPalette: true } }),
    );
    expect(stored.colorPalette).toEqual(['#123456', '#FFDD15']);
  });

  test('a logo is replaced by uploading it, and becomes the logo once it is ready', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId } = await ownWorkspace('logo');
    await enter(page, slug);
    await look(page, brandId);
    await expect(page.getByTestId('look-logo-empty')).toBeVisible();
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(`logo-${randomUUID()}`),
    ]);
    await page
      .getByTestId('look-logo-file')
      .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });
    await page.getByTestId('look-logo-submit').click();
    await page.waitForURL(/ok=BRAND_LOGO_(SAVED|PROCESSING)/);
    await waitForReady({ brandId, kind: 'IMAGE' });
    await look(page, brandId);
    if (!(await page.getByTestId('look-logo-image').isVisible())) {
      // Gate 2b — the logo from the library is behind the logo card's "⋯".
      await page.getByTestId('look-logo-more').click();
      await page.getByTestId('look-logo-select').selectOption({ label: 'logo.png' });
      await page.getByTestId('look-logo-choose-save').click();
      await page.waitForURL(/ok=BRAND_LOGO_SAVED/);
    }
    await expect(page.getByTestId('look-logo-image')).toBeVisible();
  });
});

test.describe('Item 3 · fonts', () => {
  test('built-in fonts for the four slots: chosen, saved, previewed in their own font, and self-hosted', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId } = await ownWorkspace('fonts-builtin');
    await enter(page, slug);
    await look(page, brandId);

    // Nothing stored: Inter and Cairo.
    await expect(page.getByTestId('look-slot-preview-en-heading')).toHaveAttribute(
      'data-font-family',
      'bsf-inter',
    );
    await expect(page.getByTestId('look-slot-preview-ar-body')).toHaveAttribute(
      'data-font-family',
      'bsf-cairo',
    );

    // Gate 2b — each slot is the prototype's row of chips (native radios).
    const pick = (slot: string, name: string) =>
      page
        .getByTestId(`look-slot-select-${slot}`)
        .getByRole('radio', { name, exact: true })
        .check();
    await pick('en-heading', 'Playfair Display');
    await pick('en-body', 'Lora');
    await pick('ar-heading', 'Amiri');
    await pick('ar-body', 'Tajawal');
    await expect(page.getByTestId('look-slot-preview-en-heading')).toHaveAttribute(
      'data-font-family',
      'bsf-playfair-display',
    );
    await page.getByTestId('look-fonts-save').click();
    await page.waitForURL(/ok=BRAND_FONTS_SAVED/);

    const stored = await withPlatformPrisma((prisma) =>
      prisma.brand.findUniqueOrThrow({ where: { id: brandId }, select: { typography: true } }),
    );
    expect(stored.typography).toEqual({
      en: {
        heading: { kind: 'catalogue', key: 'playfair-display' },
        body: { kind: 'catalogue', key: 'lora' },
      },
      ar: {
        heading: { kind: 'catalogue', key: 'amiri' },
        body: { kind: 'catalogue', key: 'tajawal' },
      },
    });
    await expect(page.getByTestId('look-slot-preview-ar-heading')).toHaveAttribute(
      'data-font-family',
      'bsf-amiri',
    );

    // Self-hosted, same-origin, with the security headers, never redirected.
    const file = await page.request.get(
      `${DASHBOARD_BASE_URL}/fonts/playfair-display/${encodeURIComponent('PlayfairDisplay[wght].ttf')}`,
      { maxRedirects: 0 },
    );
    expect(file.status()).toBe(200);
    expect(file.headers()['x-content-type-options']).toBe('nosniff');
    expect(file.headers()['content-security-policy']).toContain("font-src 'self' data:");
    const faces = await page.getByTestId('brand-look-fonts').innerHTML();
    expect(faces).toContain('/fonts/playfair-display/');
    expect(faces).not.toMatch(/https?:\/\//);
  });

  test('an uploaded font: added, served only to its reader, renamed, replaced, removed — and the slot falls back', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId } = await ownWorkspace('fonts-upload');
    await enter(page, slug);
    await look(page, brandId);

    await expect(page.getByTestId('look-uploaded-empty-ar')).toBeVisible();
    await page.getByTestId('look-font-file-ar').setInputFiles({
      name: 'Tajawal-Regular.ttf',
      mimeType: '',
      buffer: bundled('tajawal/Tajawal-Regular.ttf'),
    });
    await page.getByTestId('look-font-name-ar').fill('Our Arabic');
    await page.getByTestId('look-font-add-submit-ar').click();
    await page.waitForURL(/ok=BRAND_FONT_ADDED/);
    await waitForReady({ brandId, kind: 'FONT' });
    await look(page, brandId);

    const font = await withPlatformPrisma((prisma) =>
      prisma.brandFont.findFirstOrThrow({
        where: { brandId, archivedAt: null },
        select: { id: true, assetId: true },
      }),
    );
    await expect(page.getByTestId(`look-font-status-${font.id}`)).toHaveText('Ready');

    // Use it for Arabic headings.
    await page
      .getByTestId('look-slot-select-ar-heading')
      .getByRole('radio', { name: 'Our Arabic (uploaded)', exact: true })
      .check();
    await page.getByTestId('look-fonts-save').click();
    await page.waitForURL(/ok=BRAND_FONTS_SAVED/);
    await expect(page.getByTestId('look-slot-preview-ar-heading')).toHaveAttribute(
      'data-font-family',
      `bsf-u-${font.id}`,
    );

    // Served only through the authenticated, same-origin font route.
    const faces = await page.getByTestId('brand-look-fonts').innerHTML();
    const url = /url\('(\/en\/assets\/font\/[^']+)'\)/.exec(faces)?.[1];
    expect(url).toBeTruthy();
    // Fetched from the page itself: the session cookie is a `Secure` `__Host-`
    // cookie, which the browser sends to 127.0.0.1 and an API request over http
    // does not.
    const served = await page.evaluate(async (path) => {
      const response = await fetch(path, { credentials: 'same-origin', redirect: 'manual' });
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        nosniff: response.headers.get('x-content-type-options'),
        cache: response.headers.get('cache-control'),
      };
    }, url!);
    expect(served.status).toBe(200);
    expect(served.type).toBe('font/ttf');
    expect(served.nosniff).toBe('nosniff');
    expect(served.cache).toMatch(/^private, max-age=\d+$/);
    // Without the session, nothing.
    const anonymous = await page.context().browser()!.newContext();
    const refused = await anonymous.request.get(`${DASHBOARD_BASE_URL}${url}`, { maxRedirects: 0 });
    expect(refused.status()).not.toBe(200);
    await anonymous.close();

    // Rename.
    await page.getByTestId(`look-font-rename-input-${font.id}`).fill('Our Arabic Display');
    await page.getByTestId(`look-font-rename-${font.id}`).click();
    await page.waitForURL(/ok=BRAND_FONT_RENAMED/);
    await expect(page.getByTestId(`look-font-${font.id}`)).toContainText('Our Arabic Display');

    // Replace the file: the same font, a new asset; the old file archived.
    await page.getByTestId(`look-font-replace-file-${font.id}`).setInputFiles({
      name: 'Almarai-Regular.ttf',
      mimeType: 'application/octet-stream',
      buffer: bundled('almarai/Almarai-Regular.ttf'),
    });
    await page.getByTestId(`look-font-replace-${font.id}`).click();
    await page.waitForURL(/ok=BRAND_FONT_REPLACED/);
    const after = await withPlatformPrisma(async (prisma) => ({
      row: await prisma.brandFont.findUniqueOrThrow({ where: { id: font.id } }),
      old: await prisma.asset.findUniqueOrThrow({ where: { id: font.assetId } }),
      active: await prisma.brandFont.count({ where: { brandId, archivedAt: null } }),
    }));
    expect(after.row.assetId).not.toBe(font.assetId);
    expect(after.old.status).toBe('ARCHIVED');
    expect(after.active).toBe(1);

    // Remove, confirmed in a dialog — and the slot falls back to Cairo.
    await look(page, brandId);
    await page.getByTestId(`look-font-remove-${font.id}`).click();
    await expect(page.getByTestId(`look-font-remove-dialog-${font.id}`)).toBeVisible();
    await page.getByTestId(`look-font-remove-confirm-${font.id}`).click();
    await page.waitForURL(/ok=BRAND_FONT_REMOVED/);
    await expect(page.getByTestId(`look-font-${font.id}`)).toHaveCount(0);
    await expect(page.getByTestId('look-slot-preview-ar-heading')).toHaveAttribute(
      'data-font-family',
      'bsf-cairo',
    );
    await expect(page.getByTestId('look-slot-fallback-ar-heading')).toBeVisible();
  });
});

test.describe('Item 3 · where the fonts apply', () => {
  test('the Creative identity card shows all four slots in their own fonts, in both languages', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId } = await ownWorkspace('fonts-creative');
    await withPlatformPrisma((prisma) =>
      prisma.brand.update({
        where: { id: brandId },
        data: {
          typography: {
            en: {
              heading: { kind: 'catalogue', key: 'montserrat' },
              body: { kind: 'catalogue', key: 'poppins' },
            },
            ar: {
              heading: { kind: 'catalogue', key: 'almarai' },
              body: { kind: 'catalogue', key: 'ibm-plex-sans-arabic' },
            },
          },
        },
      }),
    );
    await enter(page, slug);
    for (const locale of ['en', 'ar'] as const) {
      await page.goto(`${DASHBOARD_BASE_URL}/${locale}/creative?brand=${brandId}`);
      // Review of #67 — the card opens from the purple line.
      await page.getByTestId('creative-uses').click();
      const card = page.getByTestId('creative-identity');
      await expect(card).toBeVisible();
      await expect(page.getByTestId('creative-identity-font-en-heading')).toHaveAttribute(
        'data-font-family',
        'bsf-montserrat',
      );
      await expect(page.getByTestId('creative-identity-font-en-body')).toHaveAttribute(
        'data-font-family',
        'bsf-poppins',
      );
      await expect(page.getByTestId('creative-identity-font-ar-heading')).toHaveAttribute(
        'data-font-family',
        'bsf-almarai',
      );
      await expect(page.getByTestId('creative-identity-font-ar-body')).toHaveAttribute(
        'data-font-family',
        'bsf-ibm-plex-sans-arabic',
      );
      // Only the used families are declared on this page.
      const faces = await page.getByTestId('creative-identity-font-faces').innerHTML();
      expect(faces).toContain('/fonts/montserrat/');
      expect(faces).not.toContain('/fonts/lora/');
      await noSeriousViolations(page);
    }
  });

  test('Settings → Brand names the four slots and links to Look & voice', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const { slug, brandId } = await ownWorkspace('fonts-settings');
    await enter(page, slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/brand?brand=${brandId}`);
    await expect(page.getByTestId('brand-profile-fonts')).toContainText('Inter / Inter');
    await expect(page.getByTestId('brand-profile-fonts')).toContainText('Cairo / Cairo');
    await expect(page.locator('#brand-heading-font')).toHaveCount(0);
    await page.getByTestId('brand-profile-fonts-open').click();
    await expect(page.getByTestId('look-card')).toBeVisible();
  });
});
