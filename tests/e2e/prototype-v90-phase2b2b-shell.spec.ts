import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DASHBOARD_BASE_URL } from './apps';
import { statusMessage } from '../../apps/dashboard/src/i18n/messages';
import { toastDuration } from '../../packages/ui/src/toast-timing';
import { enter, ownWorkspace, signIn, type OwnWorkspace } from './own-workspace';
import { withPlatformPrisma } from './platform-prisma';

/**
 * Prototype v90, Phase 2B-2b (PR B) — the shell (C8), motion (§8) and the
 * calendar drag (§8.2), as a person meets them in a real browser.
 *
 * Tests that seed data create their own workspace and run once, on the desktop
 * project; the touch tests run on the mobile project, which is a real
 * touch-capable device context.
 */

/** A READY, clean file in `ws`, as the worker would have left it. */
async function seedAsset(ws: OwnWorkspace, name: string): Promise<string> {
  const id = randomUUID();
  await withPlatformPrisma((prisma) =>
    prisma.asset.create({
      data: {
        id,
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        name,
        kind: 'DOCUMENT',
        mimeType: 'application/pdf',
        sizeBytes: 1_024,
        storageKey: `e2e/${randomUUID()}`,
        checksumSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
        status: 'READY',
        scanStatus: 'CLEAN',
        source: 'UPLOAD',
        uploadedByUserId: ws.ownerId,
      } as never,
    }),
  );
  return id;
}

test.describe('C8 · one overlay stack', () => {
  test('a dialog asked from a sheet stacks on it: Escape closes the dialog only, then the sheet', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'one run creates its own workspace; the desktop run covers it');
    const ws = await ownWorkspace('overlay');
    const assetId = await seedAsset(ws, 'Stacked overlays.pdf');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets?asset=${assetId}`);

    const sheet = page.getByTestId('asset-detail');
    await expect(sheet).toBeVisible();
    const remove = sheet.getByTestId('asset-delete');
    await remove.click();
    const dialog = page.getByTestId('assets-delete-dialog');
    await expect(dialog).toBeVisible();
    await expect(sheet).toBeVisible();

    // The live bug: one Escape used to close BOTH, the sheet underneath included.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(sheet).toBeVisible();
    // Focus goes back to what opened the dialog, inside the sheet.
    await expect(remove).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(page).not.toHaveURL(/asset=/);
  });

  test('opened from outside, an overlay closes the one already open', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const create = page.getByTestId('topbar-create');
    await create.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('topbar-create-menu')).toBeVisible();

    // A keyboard user leaves the menu for the bell — no pointer, so nothing
    // "outside" was clicked. The stack closes the menu when the sheet opens.
    // The trigger's test id is on a `display: contents` wrapper; the bell
    // itself is the link inside it.
    const bell = page.getByTestId('notifications-bell-trigger').locator('a').first();
    await bell.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('notifications-feed')).toBeVisible();
    await expect(page.getByTestId('topbar-create-menu')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('notifications-feed')).toHaveCount(0);
    await expect(bell).toBeFocused();
  });

  test('a menu opened inside a sheet stacks, and Escape closes the menu first', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile !== true, 'the navigation drawer is the phone shell');
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.getByTestId('open-navigation').click();
    const drawer = page.getByTestId('navigation-drawer');
    await expect(drawer).toBeVisible();
    const trigger = drawer.getByTestId('brand-switcher');
    await trigger.click();
    await expect(drawer.getByTestId('brand-switcher-menu')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(drawer.getByTestId('brand-switcher-menu')).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });
});

/** Toggle the brand's AI suggestions and save: a real action that redirects with `?ok=SETTINGS_SAVED`. */
async function saveAiSettings(page: Page, brandId: string): Promise<void> {
  await page.getByTestId(`ai-suggestions-${brandId}`).click();
  await page.getByTestId(`ai-save-${brandId}`).click();
}

test.describe('C8 · the toast host', () => {
  test.skip(
    ({ isMobile }) => isMobile === true,
    'one run creates its own workspace; the desktop run covers it',
  );

  test('a save says so in a toast, the URL loses ok=, and a refresh does not replay it', async ({
    page,
  }) => {
    const ws = await ownWorkspace('toast');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);
    await saveAiSettings(page, ws.brandId);

    const toast = page.getByTestId('toast');
    await expect(toast).toContainText(statusMessage('SETTINGS_SAVED', 'en')!);
    // The success banner it replaces is gone from the page.
    await expect(page.getByTestId('ai-settings')).toBeVisible();
    await expect(page).toHaveURL(/\/en\/settings\/ai$/);

    await page.reload();
    await expect(page.getByTestId('ai-settings')).toBeVisible();
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('it stays its reading time, holds while hovered, and resumes with 2.2 s to go', async ({
    page,
  }) => {
    const ws = await ownWorkspace('toast-time');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);
    await saveAiSettings(page, ws.brandId);

    const toast = page.getByTestId('toast');
    const text = statusMessage('SETTINGS_SAVED', 'en')!;
    await expect(toast).toContainText(text);
    await expect(page.locator('[data-toast-duration]')).toHaveAttribute(
      'data-toast-duration',
      String(toastDuration(text)),
    );

    // Held: well past its own reading time, it is still there.
    await toast.hover();
    await page.waitForTimeout(toastDuration(text) + 1_000);
    await expect(toast).toBeVisible();

    // Released: it stays about 2.2 s more, then goes.
    const released = Date.now();
    await page.mouse.move(2, 2);
    await expect(toast).toBeHidden({ timeout: 6_000 });
    expect(Date.now() - released).toBeGreaterThanOrEqual(1_800);
  });

  test('dismiss closes it at once, and so does the next navigation', async ({ page }) => {
    const ws = await ownWorkspace('toast-close');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);

    await saveAiSettings(page, ws.brandId);
    await expect(page.getByTestId('toast')).toBeVisible();
    await page.getByTestId('toast-dismiss').click();
    await expect(page.getByTestId('toast')).toHaveCount(0);

    await saveAiSettings(page, ws.brandId);
    await expect(page.getByTestId('toast')).toBeVisible();
    // A client-side navigation, not a reload: the host itself stays mounted.
    await page.locator('a[href="/en/calendar"]').first().click();
    await page.waitForURL(/\/en\/calendar/);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('in Arabic the toast speaks Arabic', async ({ page }) => {
    const ws = await ownWorkspace('toast-ar');
    await enter(page, ws.slug, 'ar');
    await page.goto(`${DASHBOARD_BASE_URL}/ar/settings/ai`);
    await saveAiSettings(page, ws.brandId);
    await expect(page.getByTestId('toast')).toContainText(statusMessage('SETTINGS_SAVED', 'ar')!);
    await expect(page.getByTestId('toast-dismiss')).toHaveAttribute('aria-label', 'إغلاق الإشعار');
  });

  test('a page that still draws its own banner keeps ok= in its URL (not refactored here)', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/approvals?ok=SAVED`);
    await expect(page.getByText(statusMessage('SAVED', 'en')!).first()).toBeVisible();
    await expect(page).toHaveURL(/[?&]ok=SAVED/);
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});

test.describe('§8 motion — foundation (D-348)', () => {
  test('MO14: a pressed button does not move; a tile lifts 2 px on hover', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'hover is a pointer gesture');
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const create = page.getByTestId('topbar-create');
    const box = (await create.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // No press motion at all (owner answer 9): no transform while held.
    expect(await create.evaluate((el) => getComputedStyle(el).transform)).toBe('none');
    await page.mouse.up();
    await page.keyboard.press('Escape');

    await page.goto(`${DASHBOARD_BASE_URL}/en/workspaces`);
    const tile = page.locator('[data-testid^="choose-workspace-"]').first();
    await tile.hover();
    await expect
      .poll(() => tile.evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42))
      .toBe(-2);
  });

  test('reduced motion: nothing animates or transitions', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const styles = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('body *')].slice(0, 400).map((el) => {
        const style = getComputedStyle(el);
        return { animation: style.animationName, transition: style.transitionDuration };
      }),
    );
    expect(styles.filter((s) => s.animation !== 'none')).toEqual([]);
    expect(styles.filter((s) => s.transition.split(',').some((d) => parseFloat(d) > 0))).toEqual(
      [],
    );
  });
});

test.describe('§8 motion — the shell (D-349)', () => {
  test.skip(({ isMobile }) => isMobile === true, 'the rail and its pill are the desktop shell');

  test('MO1: the first page does not enter; the next page’s blocks do, 45 ms apart', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const first = page.locator('.bs-page-flow .bs-section-stack > *').first();
    await expect(first).toBeVisible();
    expect(await first.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');

    await page.getByTestId('nav-calendar').click();
    await page.waitForURL(/\/en\/calendar/);
    const blocks = page.locator('.bs-page-flow:not([data-entered]) .bs-section-stack > *');
    await expect(blocks.first()).toBeVisible();
    const timing = await blocks.evaluateAll((els) =>
      els.map((el) => {
        const style = getComputedStyle(el);
        return `${style.animationName} ${style.animationDuration} ${style.animationDelay}`;
      }),
    );
    expect(timing[0]).toBe('bs-page-in 0.44s 0.045s');
    if (timing.length > 1) expect(timing[1]).toMatch(/^bs-page-in(-plain)? 0\.44s 0\.09s$/);
  });

  test('MO1: when sessionStorage is refused, nothing enters', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', {
        get() {
          throw new Error('storage refused');
        },
      });
    });
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.getByTestId('nav-calendar').click();
    await page.waitForURL(/\/en\/calendar/);
    const block = page.locator('.bs-page-flow .bs-section-stack > *').first();
    await expect(block).toBeVisible();
    expect(await block.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('MO2: one ink pill sits on the current item and glides to the next', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const offset = () =>
      page.evaluate(() => {
        const pill = document
          .querySelector('[data-testid="nav-pill-rail"]')!
          .getBoundingClientRect();
        const item = document
          .querySelector('[data-testid="sidebar"] a[aria-current="page"]')!
          .getBoundingClientRect();
        return (
          Math.abs(pill.x - item.x) +
          Math.abs(pill.y - item.y) +
          Math.abs(pill.width - item.width) +
          Math.abs(pill.height - item.height)
        );
      });
    const pill = page.getByTestId('nav-pill-rail');
    await expect(pill).toBeVisible();
    await expect.poll(offset).toBeLessThan(1);
    // The first placement has no transition; the item no longer paints its own ink.
    expect(await pill.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
    expect(await pill.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(17, 17, 20)',
    );
    // Polled, not read once: the item's own fill hands over with its existing
    // 140 ms background-colour state transition, so a read inside that window
    // sees the fade (rgba(17,17,20,.035) in CI). The end state is the rule.
    await expect
      .poll(() =>
        page
          .locator('[data-testid="sidebar"] a[aria-current="page"]')
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toBe('rgba(0, 0, 0, 0)');

    await page.getByTestId('nav-calendar').click();
    await page.waitForURL(/\/en\/calendar/);
    await expect(page.getByTestId('nav-calendar')).toHaveAttribute('aria-current', 'page');
    const moving = await page
      .getByTestId('nav-pill-rail')
      .evaluate((el) => [
        getComputedStyle(el).transitionProperty,
        getComputedStyle(el).transitionDuration,
      ]);
    expect(moving[0]).toContain('transform');
    expect(moving[1]).toContain('0.44s');
    await expect.poll(offset).toBeLessThan(1);
  });

  test('MO3: the state flips at once, labels leave before the column, and a stored collapse does not animate', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    const shell = page.getByTestId('app-shell');
    await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
    await page.evaluate(() => {
      const host = document.querySelector('[data-testid="app-shell"]')!;
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => seen.push(host.getAttribute('data-sidebar-state') ?? '')).observe(
        host,
        { attributes: true, attributeFilter: ['data-sidebar-state'] },
      );
    });
    const toggle = page.getByTestId('toggle-sidebar');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(shell).toHaveAttribute('data-sidebar-state', 'collapsed');
    expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen)).toEqual([
      'collapsing',
      'collapsed',
    ]);

    // Stored "collapsed", applied on load: no transition on the column.
    await page.reload();
    await expect(shell).toHaveAttribute('data-sidebar-state', 'collapsed');
    await expect(shell).not.toHaveAttribute('data-sidebar-motion', '');
    expect(
      await page.locator('.bs-shell').evaluate((el) => getComputedStyle(el).transitionDuration),
    ).toBe('0s');

    await toggle.click();
    await expect(shell).toHaveAttribute('data-sidebar-state', 'expanded');
  });

  test('MO4: the calendar’s view pill slides with clip-path to the chosen view', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    const group = page.getByTestId('calendar-view-month').locator('..');
    const pillFill = group.locator('.bs-seg-pill-fill');
    await expect(group).toHaveAttribute('data-seg', 'placed');
    await page.getByTestId('calendar-view-week').click();
    await expect(page.getByTestId('calendar-view-week')).toHaveAttribute('aria-pressed', 'true');
    const style = await pillFill.evaluate((el) => [
      getComputedStyle(el).transitionProperty,
      getComputedStyle(el).transitionDuration,
    ]);
    expect(style).toEqual(['clip-path', '0.38s']);
    // It ends exactly on the chosen view, and the view no longer paints its own fill.
    await expect
      .poll(() =>
        group.evaluate((box) => {
          const clip = getComputedStyle(box.querySelector('.bs-seg-pill-fill')!).clipPath;
          const week = box.querySelector<HTMLElement>('[data-testid="calendar-view-week"]')!;
          const inner = week.getBoundingClientRect();
          const outer = box.getBoundingClientRect();
          const left = inner.left - outer.left - box.clientLeft;
          const found = /inset\(\s*[\d.]+px\s+[\d.]+px\s+[\d.]+px\s+([\d.]+)px/.exec(clip);
          return found !== null && Math.abs(Number(found[1]) - left) < 1;
        }),
      )
      .toBe(true);
    expect(
      await page
        .getByTestId('calendar-view-week')
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe('rgba(0, 0, 0, 0)');
  });
});

test.describe('§8 motion — overlays (D-350)', () => {
  test.skip(({ isMobile }) => isMobile === true, 'the top bar menus are the desktop shell');

  const anim = (el: Element) => {
    const style = getComputedStyle(el);
    return `${style.animationName} ${style.animationDuration} ${style.animationDelay}`;
  };

  test('MO5: a menu is glass, pops in as the prototype’s does, and it leaves inert', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.getByTestId('topbar-create').click();
    const menu = page.getByTestId('topbar-create-menu');
    await expect(menu).toBeVisible();
    // D-468: `[role="menu"]{animation:bsPop .18s cubic-bezier(.16,1,.3,1) both}`
    // and `backdrop-filter: blur(22px) saturate(180%)` (Main.dc.html); the
    // prototype's menus do not stagger their rows, so the rows carry no entrance.
    expect(await menu.evaluate(anim)).toBe('bsp-pop 0.18s 0s');
    expect(await menu.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe(
      'blur(22px) saturate(1.8)',
    );
    const rows = await menu
      .locator(':scope > *')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).animationName));
    expect(rows.every((name) => name === 'none')).toBe(true);

    // Closing is immediate; only its picture leaves, and nothing in it is usable.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('topbar-create')).toBeFocused();
    await expect(menu).toHaveCount(0);
  });

  test('MO6: a modal grows in over a veil whose blur goes to 3 px', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'one run creates its own workspace');
    const ws = await ownWorkspace('dialog-motion');
    const assetId = await seedAsset(ws, 'Dialog motion.pdf');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/assets?asset=${assetId}`);
    await page.getByTestId('asset-detail').getByTestId('asset-delete').click();
    const dialog = page.getByTestId('assets-delete-dialog');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(anim)).toBe('bs-dialog-in 0.3s 0s');
    const veil = page.getByTestId('assets-delete-dialog-scrim');
    expect(await veil.evaluate(anim)).toBe('bs-veil-in 0.26s 0s');
    await expect
      .poll(() => veil.evaluate((el) => getComputedStyle(el).backdropFilter))
      .toBe('blur(3px)');
  });

  test('MO7: the Copilot panel rises from its bottom end corner', async ({ page }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/overview`);
    await page.getByTestId('topbar-copilot').click();
    const panel = page.getByTestId('copilot-drawer');
    await expect(panel).toBeVisible();
    expect(await panel.evaluate(anim)).toBe('bs-copilot-in 0.34s 0s');
    const origin = await panel.evaluate((el) => {
      const [x, y] = getComputedStyle(el).transformOrigin.split(' ').map(parseFloat);
      // Layout size, not the painted box: mid-entrance the panel is scaled.
      const { offsetWidth: width, offsetHeight: height } = el as HTMLElement;
      return { right: Math.abs(x! - width) < 1, bottom: Math.abs(y! - height) < 1 };
    });
    expect(origin).toEqual({ right: true, bottom: true });
  });
});

test.describe('§8 motion — feedback, charts and figures (D-351)', () => {
  test.skip(({ isMobile }) => isMobile === true, 'one run creates its own workspace');

  const anim = (el: Element) => {
    const style = getComputedStyle(el);
    return `${style.animationName} ${style.animationDuration} ${style.animationDelay}`;
  };

  test('MO8: the toast rises in, its check draws, and dismissing it leaves nothing usable', async ({
    page,
  }) => {
    const ws = await ownWorkspace('toast-motion');
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/settings/ai`);
    await saveAiSettings(page, ws.brandId);
    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();
    expect(await toast.evaluate(anim)).toBe('bs-toast-in 0.42s 0s');
    expect(await toast.locator('[data-toast-check] path').first().evaluate(anim)).toBe(
      'bs-check-draw 0.42s 0.16s',
    );
    await page.getByTestId('toast-dismiss').click();
    // Closed at once; its picture leaves inert, then is gone.
    await expect(page.getByTestId('toast')).toHaveCount(0);
    await expect(page.locator('[data-toast-duration]')).toHaveCount(0);
  });

  test('MO11 and MO12: charts draw in and figures count up to the exact server value', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics`);
    const figure = page.getByTestId('count-up').first();
    await expect(figure).toBeVisible();
    const finalText = await figure.locator('.bs-count-final').textContent();
    // The element's text is the server value from the first frame to the last.
    await expect(figure).toHaveText(finalText!);
    await expect(figure).not.toHaveAttribute('data-counting', '');
    await expect(figure).toHaveText(finalText!);

    // The seeded analytics have one trend line and one comparison bar; the
    // 35 ms bar stagger itself is pinned in tests/unit/motion-feedback.test.ts.
    const line = page.locator('.bs-chart-line').first();
    await expect(line).toBeAttached();
    expect(await line.evaluate(anim)).toBe('bs-line-draw 1s 0s');
    const bar = page.locator('.bs-chart-bar').first();
    await expect(bar).toBeAttached();
    expect(await bar.evaluate(anim)).toBe('bs-bar-grow 0.8s 0s');
    const dot = page.locator('.bs-chart-dot').first();
    await expect(dot).toBeAttached();
    expect(await dot.evaluate(anim)).toMatch(/^bs-dot-pop 0\.36s 1(\.\d+)?s$/);
  });

  test('MO12 under reduced motion: no counting at all', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page);
    await page.goto(`${DASHBOARD_BASE_URL}/en/analytics`);
    const figure = page.getByTestId('count-up').first();
    await expect(figure).toBeVisible();
    expect(await figure.getAttribute('data-counting')).toBeNull();
  });
});

/**
 * A second, ACTIVE member of `ws`, and a note by `authorId` about a post,
 * naming `mentionedId` — the rows `NotesService` itself writes.
 */
async function seedMention(
  ws: OwnWorkspace,
  input: { authorName: string; self?: boolean },
): Promise<{ threadId: string; itemId: string; authorId: string }> {
  let authorId = ws.ownerId;
  let threadId = '';
  let itemId = '';
  await withPlatformPrisma(async (prisma) => {
    if (!input.self) {
      const author = await prisma.user.create({
        data: {
          email: `mention-${randomUUID()}@example.test`,
          name: input.authorName,
          status: 'ACTIVE',
          timezone: 'UTC',
        },
        select: { id: true },
      });
      authorId = author.id;
      const role = await prisma.role.findFirstOrThrow({
        where: { key: 'workspace_owner', workspaceId: null },
        select: { id: true },
      });
      await prisma.membership.create({
        data: {
          workspaceId: ws.workspaceId,
          userId: authorId,
          roleId: role.id,
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });
    }
    const item = await prisma.contentItem.create({
      data: {
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        title: `Mentioned post ${randomUUID().slice(0, 6)}`,
        contentType: 'POST',
        primaryLocale: 'EN',
        status: 'DRAFT',
        createdByUserId: ws.ownerId,
      } as never,
      select: { id: true },
    });
    itemId = item.id;
    const thread = await prisma.noteThread.create({
      data: {
        workspaceId: ws.workspaceId,
        brandId: ws.brandId,
        subjectType: 'CONTENT_ITEM',
        contentItemId: item.id,
        createdByUserId: authorId,
      },
      select: { id: true },
    });
    threadId = thread.id;
    const note = await prisma.note.create({
      data: {
        workspaceId: ws.workspaceId,
        threadId: thread.id,
        authorUserId: authorId,
        body: 'Can you check the caption before Friday?',
      },
      select: { id: true },
    });
    await prisma.noteMention.create({
      data: { workspaceId: ws.workspaceId, noteId: note.id, mentionedUserId: ws.ownerId },
    });
  });
  return { threadId, itemId, authorId };
}

test.describe('MO10 · an incoming mention from another person (option A)', () => {
  test.skip(({ isMobile }) => isMobile === true, 'one run creates its own workspace');

  test('shows on the next page, once per tab, with the sender, the context and Open', async ({
    page,
  }) => {
    const ws = await ownWorkspace('incoming');
    const { threadId, itemId } = await seedMention(ws, { authorName: 'Sam Rivera' });
    // The first page after the mention was written is where it arrives:
    // `enter` lands on the overview.
    await enter(page, ws.slug);

    const notice = page.getByTestId('incoming-mention');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Sam Rivera mentioned you');
    await expect(notice).toContainText('Mentioned post');
    await expect(notice.locator('[aria-hidden="true"]').first()).toHaveText('S');
    expect(await notice.evaluate((el) => getComputedStyle(el).animationName)).toBe('bs-toast-in');
    await expect(page.getByTestId('incoming-mention-open')).toHaveAttribute(
      'href',
      `/en/content/compose?item=${itemId}&thread=${threadId}#thread-${threadId}`,
    );
    // It stays in the Notes count (D-468: the rail's count beside Notes).
    await expect(page.getByTestId('nav-notes-count')).toBeVisible();

    // Once per mention per tab: the next page does not announce it again.
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('incoming-mention')).toHaveCount(0);
  });

  test('naming yourself is never incoming, and the Notes dot does not count it', async ({
    page,
  }) => {
    const ws = await ownWorkspace('self-mention');
    await seedMention(ws, { authorName: 'me', self: true });
    await enter(page, ws.slug);
    await page.goto(`${DASHBOARD_BASE_URL}/en/calendar`);
    await expect(page.getByTestId('app-shell')).toBeVisible();
    await expect(page.getByTestId('incoming-mention')).toHaveCount(0);
    await expect(page.getByTestId('app-shell').getByTestId('nav-notes')).toBeVisible();
    await expect(page.getByTestId('nav-notes-count')).toHaveCount(0);
  });

  test('in Arabic, the notice speaks Arabic', async ({ page }) => {
    const ws = await ownWorkspace('incoming-ar');
    await seedMention(ws, { authorName: 'سارة' });
    await enter(page, ws.slug, 'ar');
    const notice = page.getByTestId('incoming-mention');
    await expect(notice).toContainText('أشار إليك سارة');
    await expect(page.getByTestId('incoming-mention-open')).toHaveText('فتح');
  });
});
