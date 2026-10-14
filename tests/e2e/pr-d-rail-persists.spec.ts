import { expect, test, type Page } from '@playwright/test';
import { signIn } from './own-workspace';

/**
 * PR D — THE CUSTOMER RAIL STAYS MOUNTED ACROSS PAGE CHANGES, AND ITS PILL
 * GLIDES FROM THE PRESS.
 *
 * Every customer page renders its own shell, and a page change used to replace
 * the whole of it: a new `nav`, a new pill, and the glide restarted (or was
 * cut short) when the next page arrived. Settings → Home glided for under
 * 20 ms. The rail now lives in the layout's host, as the Control Center's does:
 *
 *   - the `nav` and the pill are the SAME elements before and after the move;
 *   - the press creates the pill's glide within 20 ms (its target set and its
 *     transition running, against the click's time stamp), and the browser
 *     starts it on its next frames — not on the arrival of the next page;
 *   - it is ONE glide: the arriving page neither restarts nor replaces it;
 *   - the glide runs its full course (the rail's 440 ms `.navInd`).
 *
 * THE FRAME CLOCK. An animation starts on a frame, so its start time can be no
 * earlier than the browser's next frame. This container rasterises in
 * software, and the shell's `backdrop-filter` blur costs it about 83 ms a frame
 * (16.7 ms without it; a GPU draws the blur at 60 frames a second). The test
 * page therefore turns the blur off — nothing in the rail's logic depends on
 * it — so the start time measures the rail, not the container's raster. The
 * glide's CREATION (the press setting its target) is measured as well, and
 * needs no frame at all.
 *
 * FROM THE PRESS'S PROCESSING, NOT ITS TIME STAMP (review of #75, owner
 * approved). A click's time stamp is when the input arrived; on a busy
 * machine it can wait in the queue behind other work before any script sees
 * it. The budget is the rail's, so it is measured from the moment the browser
 * starts processing the click — the first listener to run, a capture listener
 * on the window — to the glide's creation. The queueing before it is logged,
 * not budgeted. (That 20 ms budget is replaced by the next paragraph.)
 *
 * FINAL REVIEW (owner, item 6) — CREATED IN THE PRESS'S OWN TASK, NOT WITHIN
 * 20 MS OF WALL CLOCK. The 20 ms budget measured the machine as much as the
 * rail: the press runs the same few lines on every run, and under load
 * (CI's runner, or this suite next to a typecheck) the same lines took 32 ms
 * once and the test failed with nothing wrong in the rail. What the budget
 * stood for is that the press itself creates the glide — no frame, no fetch,
 * no other task in between. That is now asserted directly and the same way on
 * every machine: a listener on the window, which the click reaches after
 * React's own handler and before the event's task ends, finds the pill's new
 * target set and its transform transition already created. The milliseconds
 * are still measured and logged, never budgeted.
 */

async function settle(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector<HTMLElement>('[data-testid="sidebar"] .bsp-nav-ind')
            ?.getAnimations().length ?? -1,
      ),
    )
    .toBe(0);
}

/**
 * The page is at rest: ten frames in a row, each under 25 ms. A press that
 * lands while the page that just arrived is still hydrating or prefetching
 * waits for that work like any other script, and measures the page, not the
 * rail. People press a settled page; the test does too.
 */
async function quiet(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = performance.now();
        let calm = 0;
        const started = last;
        const gaps: number[] = [];
        const step = (now: number) => {
          const gap = now - last;
          calm = gap < 25 ? calm + 1 : 0;
          gaps.push(gap);
          last = now;
          if (calm >= 10 || now - started > 10_000) {
            const recent = gaps.slice(-10).sort((a, b) => a - b);
            resolve(recent[Math.floor(recent.length / 2)] ?? 16.7);
          } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
}

for (const locale of ['en', 'ar'] as const) {
  test(`Settings → Home glides from the press on the same rail (${locale})`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile === true, 'the phone layout is post-launch (D-468 (b))');
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, locale);
    const rail = page.getByTestId('sidebar');
    await rail.getByTestId('nav-settings').click();
    await expect(rail.locator('[aria-current="page"]')).toHaveAttribute(
      'data-testid',
      'nav-settings',
    );
    await settle(page);
    await page.addStyleTag({
      content: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',
    });

    await page.evaluate(() => {
      const w = window as unknown as {
        __rail: {
          nav: Element | null;
          pill: Element | null;
          pressedAt: number | null;
          processingAt: number | null;
          createdAt: number | null;
          glides: Animation[];
          inPressTask: { target: string; gliding: boolean } | null;
          from: string;
        };
      };
      const nav = document.querySelector('[data-testid="sidebar"] nav');
      const pill = nav?.querySelector<HTMLElement>('.bsp-nav-ind') ?? null;
      w.__rail = {
        nav: nav ?? null,
        pill,
        pressedAt: null,
        processingAt: null,
        createdAt: null,
        glides: [],
        inPressTask: null,
        from: pill?.style.transform ?? '',
      };
      // The window, bubbling: after React's handler, still inside the press's task.
      window.addEventListener(
        'click',
        (event) => {
          if (!(event.target as Element | null)?.closest('[data-testid="nav-overview"]')) return;
          w.__rail.inPressTask = {
            target: pill?.style.transform ?? '',
            gliding:
              pill
                ?.getAnimations()
                .some((a) => (a as CSSTransition).transitionProperty === 'transform') ?? false,
          };
        },
        { once: true },
      );
      if (pill) {
        const watch = new MutationObserver(() => {
          if (w.__rail.processingAt === null || w.__rail.createdAt !== null) return;
          if (
            pill
              .getAnimations()
              .some((a) => (a as CSSTransition).transitionProperty === 'transform')
          ) {
            w.__rail.createdAt = performance.now();
            watch.disconnect();
          }
        });
        watch.observe(pill, { attributes: true, attributeFilter: ['style'] });
      }
      window.addEventListener(
        'click',
        (event) => {
          if ((event.target as Element | null)?.closest('[data-testid="nav-overview"]')) {
            w.__rail.pressedAt = event.timeStamp;
            // The browser has started processing the click: the first listener runs now.
            w.__rail.processingAt = performance.now();
          }
        },
        { capture: true, once: true },
      );
      pill?.addEventListener('transitionrun', (event) => {
        if (event.propertyName !== 'transform') return;
        for (const animation of pill.getAnimations()) {
          if (
            (animation as CSSTransition).transitionProperty === 'transform' &&
            !w.__rail.glides.includes(animation)
          ) {
            w.__rail.glides.push(animation);
          }
        }
      });
    });

    const frame = await quiet(page);
    await rail.getByTestId('nav-overview').click();
    await expect(rail.locator('[aria-current="page"]')).toHaveAttribute(
      'data-testid',
      'nav-overview',
    );
    await page.waitForURL(new RegExp(`/${locale}/overview$`));
    await settle(page);

    const result = await page.evaluate(() => {
      const w = window as unknown as {
        __rail: {
          nav: Element | null;
          pill: Element | null;
          pressedAt: number | null;
          processingAt: number | null;
          createdAt: number | null;
          glides: Animation[];
          inPressTask: { target: string; gliding: boolean } | null;
          from: string;
        };
      };
      const nav = document.querySelector('[data-testid="sidebar"] nav');
      const glide = w.__rail.glides[0];
      return {
        sameNav: nav !== null && nav === w.__rail.nav,
        samePill: nav?.querySelector('.bsp-nav-ind') === w.__rail.pill,
        glides: w.__rail.glides.length,
        queued:
          w.__rail.processingAt !== null && w.__rail.pressedAt !== null
            ? w.__rail.processingAt - w.__rail.pressedAt
            : null,
        createdAfter:
          w.__rail.createdAt !== null && w.__rail.processingAt !== null
            ? w.__rail.createdAt - w.__rail.processingAt
            : null,
        startedAfter:
          glide && typeof glide.startTime === 'number' && w.__rail.processingAt !== null
            ? glide.startTime - w.__rail.processingAt
            : null,
        ran:
          glide?.effect?.getComputedTiming().endTime !== undefined
            ? Number(glide.effect.getComputedTiming().endTime)
            : null,
        finished: glide?.playState === 'finished',
        inPressTask: w.__rail.inPressTask,
        from: w.__rail.from,
      };
    });
    expect(result.sameNav, 'the rail’s nav is the same element after the move').toBe(true);
    expect(result.samePill, 'the pill is the same element after the move').toBe(true);
    expect(result.glides, 'one glide: the arriving page does not restart it').toBe(1);
    console.log(
      `rail glide (${locale}): created ${result.createdAfter?.toFixed(1)} ms, started ${result.startedAfter?.toFixed(1)} ms after the press was processed (queued ${result.queued?.toFixed(1)} ms before it)`,
    );
    expect(result.createdAfter, 'the press creates the glide').not.toBeNull();
    // The press creates the glide in its own task: target set, transition running.
    expect(result.inPressTask, 'the press was seen by the window').not.toBeNull();
    expect(result.inPressTask?.gliding, 'the glide exists before the press task ends').toBe(true);
    expect(result.inPressTask?.target, 'aimed somewhere new: Home, not Settings').not.toBe(
      result.from,
    );
    expect(result.startedAfter, 'the glide starts from the press').not.toBeNull();
    // The browser starts an animation on its next frames (the start is the
    // compositor's), never sooner: within three of this page's own frames of
    // the press creating it — never on the next page's arrival.
    expect(result.startedAfter ?? Infinity).toBeLessThanOrEqual(
      (result.createdAfter ?? 0) + 3 * frame,
    );
    expect(result.finished, 'the glide ran to its end').toBe(true);
    expect(result.ran ?? 0, 'the glide runs its full course').toBeGreaterThanOrEqual(400);
  });
}
