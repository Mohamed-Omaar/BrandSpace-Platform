'use client';

import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  LONG_PRESS_MS,
  LONG_PRESS_TOLERANCE_PX,
  MOUSE_DRAG_THRESHOLD_PX,
  dropOutcome,
  travelled,
  type DropState,
} from './calendar-drag';
import { prefersReducedMotion } from './motion';
import { motionMs, zIndexTokens } from './tokens';

/**
 * §8.2 (Phase 2B-2b) — THE CALENDAR'S POINTER DRAG.
 *
 * Replaces native HTML drag and drop, which a finger cannot do. Anything inside
 * `root` carrying `data-drag-payload` can be lifted; anything carrying
 * `data-drop-day` (with `data-drop-state` = ok | past | none) can take it.
 *
 *   START    mouse: after 5 px of movement — a plain click still opens the
 *            post. Touch: a 380 ms long-press without moving more than 8 px —
 *            moving earlier scrolls the page. Once lifted, the page does not
 *            scroll and the context menu is suppressed.
 *   LIFT     a floating copy follows the pointer (scale 1.04, rotate −1.5°,
 *            deeper shadow, 180 ms); the original stays as a dashed placeholder.
 *   OVER     a day that can take it turns light purple, dashed; a past day
 *            grey with a red dashed outline; the label under the copy says
 *            which ("Wed 21 · 18:00", or that it cannot be used). Days
 *            outside the month take nothing.
 *   DROP     `onDrop` is the ONE place a move is committed. Nothing is called
 *            while the pointer moves, hovers or previews. After it, the copy
 *            flies into the post's new place (360 ms, a slight overshoot) and
 *            every other post that moved slides there (300 ms).
 *   CANCEL   outside a day, on a past day, on the same day, or Escape: the copy
 *            glides back (300 ms) and nothing changes.
 *
 * Keyboard users are untouched: nothing here listens to a key but Escape
 * during a drag, and the post's own drawer is still how it moves without a
 * pointer (WCAG 2.5.7). Reduced motion: the same drag, without animation.
 */
export interface CalendarDragOptions {
  /**
   * A committed drop on a day that takes it. Return `moved` when the post now
   * shows in its new place (the copy flies there), `opened` when something
   * else took over — the schedule dialog for a draft from the tray — or
   * `ignored`.
   */
  readonly onDrop: (payload: string, dayKey: string) => 'moved' | 'opened' | 'ignored';
  /** A release over a day that has passed (F2): nothing moves; say why. */
  readonly onRefused?: ((payload: string, dayKey: string) => void) | undefined;
  /** The words under the copy while it is over a day. */
  readonly describe: (payload: string, dayKey: string, state: DropState) => string;
}

interface Gesture {
  readonly payload: string;
  readonly source: HTMLElement;
  readonly pointer: 'mouse' | 'touch';
  readonly startX: number;
  readonly startY: number;
  readonly fromDay: string | null;
  lifted: boolean;
  timer?: number | undefined;
  copy?: HTMLElement | undefined;
  label?: HTMLElement | undefined;
  over?: HTMLElement | null | undefined;
  x: number;
  y: number;
}

const OVERSHOOT = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const EASE_OUT = 'cubic-bezier(0.16, 1, 0.3, 1)';

/**
 * The posts that are actually drawn. The month grid and the phone's list are
 * both in the page, one of them hidden by the breakpoint, so a payload can
 * appear twice; only the visible one has a place to measure or land on.
 */
function drawnSources(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-drag-payload]')].filter(
    (element) => element.getClientRects().length > 0,
  );
}

function payloadRects(root: HTMLElement): Map<string, DOMRect> {
  const rects = new Map<string, DOMRect>();
  for (const element of drawnSources(root)) {
    rects.set(element.dataset['dragPayload'] ?? '', element.getBoundingClientRect());
  }
  return rects;
}

export function useCalendarDrag(
  rootRef: RefObject<HTMLElement | null>,
  options: CalendarDragOptions,
): { readonly dragging: boolean } {
  const [dragging, setDragging] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    let gesture: Gesture | null = null;
    const still = () => prefersReducedMotion();

    const sourceOf = (target: EventTarget | null): HTMLElement | null => {
      const element =
        target instanceof Element ? target.closest<HTMLElement>('[data-drag-payload]') : null;
      return element && root.contains(element) ? element : null;
    };

    const lift = () => {
      const g = gesture;
      if (!g || g.lifted) return;
      g.lifted = true;
      const rect = g.source.getBoundingClientRect();
      const copy = g.source.cloneNode(true) as HTMLElement;
      copy.removeAttribute('id');
      copy.setAttribute('aria-hidden', 'true');
      copy.setAttribute('data-testid', 'calendar-drag-copy');
      copy.removeAttribute('data-drag-payload');
      copy.classList.add('bs-drag-copy');
      Object.assign(copy.style, {
        position: 'fixed',
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        margin: '0',
        zIndex: String(zIndexTokens.tooltip),
      });
      const label = document.createElement('span');
      label.className = 'bs-drag-label';
      label.setAttribute('data-testid', 'calendar-drag-label');
      label.setAttribute('role', 'status');
      copy.appendChild(label);
      document.body.appendChild(copy);
      g.copy = copy;
      g.label = label;
      g.source.classList.add('bs-drag-origin');
      root.setAttribute('data-dragging', '');
      document.documentElement.style.userSelect = 'none';
      // The lift itself animates (180 ms) in CSS, from its resting look.
      requestAnimationFrame(() => copy.classList.add('bs-drag-lifted'));
      setDragging(true);
    };

    const move = (x: number, y: number) => {
      const g = gesture;
      if (!g?.copy) return;
      g.x = x;
      g.y = y;
      g.copy.style.translate = `${x - g.startX}px ${y - g.startY}px`;
      const day = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-day]') ?? null;
      if (day !== g.over) {
        g.over?.removeAttribute('data-drop-over');
        g.over = day;
      }
      const state = (day?.dataset['dropState'] ?? 'none') as DropState;
      if (day && state !== 'none') {
        day.setAttribute('data-drop-over', state);
        if (g.label) {
          g.label.textContent = optionsRef.current.describe(
            g.payload,
            day.dataset['dropDay'] ?? '',
            state,
          );
          g.label.dataset['state'] = state;
        }
      } else if (g.label) {
        g.label.textContent = '';
        delete g.label.dataset['state'];
      }
    };

    const glideBack = (g: Gesture) => {
      const copy = g.copy;
      const done = () => {
        copy?.remove();
        g.source.classList.remove('bs-drag-origin');
      };
      if (!copy || still()) return done();
      copy.classList.remove('bs-drag-lifted');
      copy
        .animate([{ translate: copy.style.translate || '0 0' }, { translate: '0 0' }], {
          duration: motionMs.settle,
          easing: EASE_OUT,
          fill: 'forwards',
        })
        .finished.then(done, done);
    };

    const flyIn = (g: Gesture, before: Map<string, DOMRect>) => {
      const copy = g.copy;
      // The move rendered on the next frames; land the copy on the post's new
      // place and slide every post whose place changed (FLIP).
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const drawn = drawnSources(root);
          const landed = drawn.find((element) => element.dataset['dragPayload'] === g.payload);
          if (!still()) {
            for (const element of drawn) {
              if (element === landed) continue;
              const was = before.get(element.dataset['dragPayload'] ?? '');
              if (!was) continue;
              const now = element.getBoundingClientRect();
              const dx = was.left - now.left;
              const dy = was.top - now.top;
              if (Math.abs(dx) + Math.abs(dy) < 1) continue;
              element.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0 0' }], {
                duration: motionMs.settle,
                easing: EASE_OUT,
              });
            }
          }
          if (!copy) return;
          if (!landed || still()) {
            copy.remove();
            return;
          }
          const origin = { left: parseFloat(copy.style.left), top: parseFloat(copy.style.top) };
          const target = landed.getBoundingClientRect();
          landed.style.visibility = 'hidden';
          copy.classList.remove('bs-drag-lifted');
          const finish = () => {
            copy.remove();
            landed.style.visibility = '';
          };
          copy
            .animate(
              [
                { translate: copy.style.translate || '0 0' },
                { translate: `${target.left - origin.left}px ${target.top - origin.top}px` },
              ],
              { duration: motionMs.drop, easing: OVERSHOOT, fill: 'forwards' },
            )
            .finished.then(finish, finish);
        }),
      );
    };

    const end = (commit: boolean) => {
      // The drop is where the pointer IS at release, not where it last moved:
      // the page may have moved under a still finger (the phone's strip slides
      // up beneath it), so look again before deciding.
      if (commit && gesture?.lifted) move(gesture.x, gesture.y);
      const g = gesture;
      gesture = null;
      if (!g) return;
      window.clearTimeout(g.timer);
      if (!g.lifted) return;
      root.removeAttribute('data-dragging');
      document.documentElement.style.userSelect = '';
      g.over?.removeAttribute('data-drop-over');
      setDragging(false);
      const target = g.over
        ? {
            dayKey: g.over.dataset['dropDay'] ?? '',
            state: (g.over.dataset['dropState'] ?? 'none') as DropState,
          }
        : null;
      const outcome = commit ? dropOutcome(target, g.fromDay) : 'cancel';
      if (outcome === 'move' && target) {
        const before = payloadRects(root);
        const result = optionsRef.current.onDrop(g.payload, target.dayKey);
        if (result === 'moved') {
          g.source.classList.remove('bs-drag-origin');
          flyIn(g, before);
        } else {
          g.copy?.remove();
          g.source.classList.remove('bs-drag-origin');
        }
        return;
      }
      if (outcome === 'refuse' && target) optionsRef.current.onRefused?.(g.payload, target.dayKey);
      glideBack(g);
    };

    // ---- mouse ------------------------------------------------------------
    const onPointerMove = (event: PointerEvent) => {
      const g = gesture;
      if (!g || g.pointer !== 'mouse') return;
      if (!g.lifted) {
        if (!travelled(event.clientX - g.startX, event.clientY - g.startY, MOUSE_DRAG_THRESHOLD_PX))
          return;
        lift();
      }
      move(event.clientX, event.clientY);
    };
    const onPointerUp = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      const wasDrag = gesture?.lifted === true;
      end(true);
      if (wasDrag) {
        // The click that follows a drag must not open the post it moved.
        const swallow = (click: Event) => {
          click.stopPropagation();
          click.preventDefault();
        };
        document.addEventListener('click', swallow, { capture: true, once: true });
        window.setTimeout(() => document.removeEventListener('click', swallow, true), 0);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || event.button !== 0 || gesture) return;
      const source = sourceOf(event.target);
      if (!source) return;
      gesture = {
        payload: source.dataset['dragPayload'] ?? '',
        source,
        pointer: 'mouse',
        startX: event.clientX,
        startY: event.clientY,
        fromDay: source.dataset['dragDay'] ?? null,
        lifted: false,
        x: event.clientX,
        y: event.clientY,
      };
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    };

    // ---- touch ------------------------------------------------------------
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || gesture) return;
      const source = sourceOf(event.target);
      const touch = event.touches[0];
      if (!source || !touch) return;
      gesture = {
        payload: source.dataset['dragPayload'] ?? '',
        source,
        pointer: 'touch',
        startX: touch.clientX,
        startY: touch.clientY,
        fromDay: source.dataset['dragDay'] ?? null,
        lifted: false,
        x: touch.clientX,
        y: touch.clientY,
      };
      gesture.timer = window.setTimeout(() => {
        lift();
        if (gesture) move(gesture.x, gesture.y);
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (event: TouchEvent) => {
      const g = gesture;
      const touch = event.touches[0];
      if (!g || g.pointer !== 'touch' || !touch) return;
      if (!g.lifted) {
        g.x = touch.clientX;
        g.y = touch.clientY;
        // Moving before the long-press is a scroll: let the page have it.
        if (
          travelled(touch.clientX - g.startX, touch.clientY - g.startY, LONG_PRESS_TOLERANCE_PX)
        ) {
          window.clearTimeout(g.timer);
          gesture = null;
        }
        return;
      }
      event.preventDefault();
      move(touch.clientX, touch.clientY);
    };
    const onTouchEnd = (event: TouchEvent) => {
      const g = gesture;
      if (!g || g.pointer !== 'touch') return;
      if (g.lifted) event.preventDefault(); // no click on the post it moved
      end(true);
    };
    const onTouchCancel = () => end(false);

    // ---- guards -----------------------------------------------------------
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture?.lifted) {
        event.stopPropagation();
        end(false);
      }
    };
    const onContextMenu = (event: Event) => {
      if (gesture) event.preventDefault();
    };
    const onNativeDragStart = (event: DragEvent) => {
      if (sourceOf(event.target)) event.preventDefault();
    };

    // Armed: the page can be dragged from now on (and tests wait for it).
    root.setAttribute('data-drag-ready', '');
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchmove', onTouchMove, { passive: false });
    root.addEventListener('touchend', onTouchEnd, { passive: false });
    root.addEventListener('touchcancel', onTouchCancel);
    root.addEventListener('contextmenu', onContextMenu);
    root.addEventListener('dragstart', onNativeDragStart);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      end(false);
      root.removeAttribute('data-drag-ready');
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      root.removeEventListener('touchcancel', onTouchCancel);
      root.removeEventListener('contextmenu', onContextMenu);
      root.removeEventListener('dragstart', onNativeDragStart);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [rootRef]);

  return { dragging };
}
