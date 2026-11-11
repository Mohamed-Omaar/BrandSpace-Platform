import type { Page } from '@playwright/test';

/**
 * PR E — CONTRAST MEASURED ON WHAT IS ACTUALLY PAINTED.
 *
 * axe's `color-contrast` rule cannot decide text that sits on a translucent
 * surface, a blur, a gradient or a picture: it reports it as "incomplete", not
 * as a failure. The product's frame is exactly that (glass, blur and the
 * ambient gradient), so on the dark pages axe passed with nothing measured.
 *
 * This measures the pixels instead. One screenshot is taken with every text
 * glyph, icon and caret made transparent — what is left is the background each
 * piece of text really sits on — and each element's colour is compared with
 * the pixels under it, in the browser, on a canvas:
 *
 *   - text: 4.5:1, or 3:1 when large (24px, or 18.66px at 700) — WCAG 1.4.3;
 *   - the icon of an icon-only control: 3:1 — WCAG 1.4.11;
 *   - a form field: its border OR its fill against what surrounds it, 3:1 —
 *     WCAG 1.4.11 (one of the two identifies the field).
 *
 * A disabled control is exempt, as WCAG exempts it, and so is text hidden from
 * assistive technology (decoration beside the real label). The ratio taken is the
 * 10th percentile over the sampled pixels, so a stray anti-aliased edge does
 * not decide it but a dark half of a gradient does.
 */
export interface PaintedFinding {
  readonly kind: 'text' | 'icon' | 'field';
  readonly where: string;
  readonly text: string;
  readonly ratio: number;
  readonly needed: number;
  readonly fg: string;
  readonly bg: string;
}

interface Candidate {
  readonly kind: PaintedFinding['kind'];
  readonly where: string;
  readonly text: string;
  readonly needed: number;
  /** r, g, b, a (0–1), the opacity of the element and its ancestors included. */
  readonly fg: readonly [number, number, number, number];
  /** Fill of a field (its own background), when it has one. */
  readonly fill?: readonly [number, number, number, number] | undefined;
  readonly rects: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
  /**
   * A field: the points just outside its box that are its own surroundings
   * (inside the element it sits in), sampled instead of the box.
   */
  readonly ring?: ReadonlyArray<readonly [number, number]>;
}

const HIDE_INK = `
  *, *::before, *::after {
    color: transparent !important;
    -webkit-text-fill-color: transparent !important;
    text-shadow: none !important;
    caret-color: transparent !important;
    transition: none !important;
    animation-play-state: paused !important;
  }
  svg { visibility: hidden !important; }
  ::placeholder { color: transparent !important; }
`;

export async function paintedContrast(
  page: Page,
  options: {
    readonly scope?: string;
    /** A part of the page that is not under test (a box previewing light). */
    readonly exclude?: string;
  } = {},
): Promise<PaintedFinding[]> {
  const candidates = await page.evaluate(
    ({
      scope,
      exclude,
    }: {
      scope?: string | undefined;
      exclude?: string | undefined;
    }): Candidate[] => {
      const root = (scope ? document.querySelector(scope) : document.body) ?? document.body;
      const excluded = (el: Element) => exclude !== undefined && el.closest(exclude) !== null;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const probe = document.createElement('canvas').getContext('2d')!;
      const rgba = (value: string): [number, number, number, number] => {
        probe.clearRect(0, 0, 1, 1);
        probe.fillStyle = '#000';
        probe.fillStyle = value;
        const parsed = String(probe.fillStyle);
        const m = /rgba?\(([^)]+)\)/.exec(parsed);
        if (m) {
          const [r, g, b, a] = m[1]!.split(',').map((x) => Number(x.trim()));
          return [r!, g!, b!, a ?? 1];
        }
        const hex = /^#([0-9a-f]{6})$/i.exec(parsed);
        if (hex) {
          const n = parseInt(hex[1]!, 16);
          return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
        }
        return [0, 0, 0, 0];
      };
      const opacityOf = (el: Element): number => {
        let o = 1;
        for (let node: Element | null = el; node; node = node.parentElement) {
          const s = getComputedStyle(node);
          o *= Number(s.opacity);
          if (s.visibility === 'hidden' || s.display === 'none') return 0;
        }
        return o;
      };
      const disabled = (el: Element) =>
        excluded(el) ||
        el.closest('[disabled], [aria-disabled="true"], [inert], fieldset[disabled]') !== null;
      const label = (el: Element): string => {
        const id = el.getAttribute('data-testid');
        if (id) return `[data-testid="${id}"]`;
        const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 2);
        const up = el.closest('[data-testid]');
        const near = up ? ` in [data-testid="${up.getAttribute('data-testid')}"]` : '';
        return `${el.tagName.toLowerCase()}${cls.map((c) => `.${c}`).join('')}${near}`;
      };
      const visibleRect = (r: DOMRect) => {
        const x = Math.max(0, r.left);
        const y = Math.max(0, r.top);
        const w = Math.min(vw, r.right) - x;
        const h = Math.min(vh, r.bottom) - y;
        return w >= 2 && h >= 2 ? { x, y, w, h } : null;
      };
      // Painted where it is: the topmost element at the box's centre is this
      // element or inside it. Text in a closed section, clipped by a collapsed
      // parent or covered by an open dialog has a box but no pixels.
      const onTop = (el: Element, r: { x: number; y: number; w: number; h: number }) => {
        const hit = document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2);
        return hit !== null && (el === hit || el.contains(hit));
      };
      const out: Candidate[] = [];

      // Text: every element that holds text of its own.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const seen = new Map<Element, Text[]>();
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n as Text;
        if (!text.data.trim()) continue;
        const el = text.parentElement;
        // Text hidden from assistive technology is decoration beside the real
        // label (an avatar's initials next to the name): WCAG 1.4.3 exempts it.
        if (
          !el ||
          el.closest('script, style, noscript, template, svg, option, [aria-hidden="true"]')
        )
          continue;
        if (!seen.has(el)) seen.set(el, []);
        seen.get(el)!.push(text);
      }
      for (const [el, texts] of seen) {
        if (disabled(el)) continue;
        const opacity = opacityOf(el);
        if (opacity < 0.05) continue;
        const style = getComputedStyle(el);
        const fg = rgba(style.color);
        if (fg[3] === 0) continue; // gradient-clipped text paints no colour of its own
        const rects: Candidate['rects'][number][] = [];
        for (const t of texts) {
          const range = document.createRange();
          range.selectNodeContents(t);
          for (const r of Array.from(range.getClientRects())) {
            const v = visibleRect(r);
            if (v && onTop(el, v)) rects.push(v);
          }
        }
        if (rects.length === 0) continue;
        const size = parseFloat(style.fontSize);
        const bold = Number(style.fontWeight) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        out.push({
          kind: 'text',
          where: label(el),
          text: texts
            .map((t) => t.data.trim())
            .join(' ')
            .slice(0, 40),
          needed: large ? 3 : 4.5,
          fg: [fg[0], fg[1], fg[2], fg[3] * opacity],
          rects,
        });
      }

      // The icon of an icon-only control.
      for (const control of Array.from(root.querySelectorAll('button, a[href], [role="button"]'))) {
        if (disabled(control) || (control.textContent ?? '').trim() !== '') continue;
        const svg = control.querySelector('svg');
        if (!svg) continue;
        const opacity = opacityOf(svg);
        if (opacity < 0.05) continue;
        const r = visibleRect(svg.getBoundingClientRect());
        if (!r || !onTop(control, r)) continue;
        const s = getComputedStyle(svg);
        const paint = s.stroke && s.stroke !== 'none' ? s.stroke : s.fill;
        const fg = rgba(paint === 'none' || !paint ? s.color : paint);
        if (fg[3] === 0) continue;
        out.push({
          kind: 'icon',
          where: label(control),
          text: control.getAttribute('aria-label') ?? '',
          needed: 3,
          fg: [fg[0], fg[1], fg[2], fg[3] * opacity],
          rects: [r],
        });
      }

      // Form fields: the border, or the fill, against what is around them.
      const fields = root.querySelectorAll(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), select, textarea',
      );
      for (const field of Array.from(fields)) {
        if (disabled(field) || opacityOf(field) < 0.05) continue;
        const r = visibleRect(field.getBoundingClientRect());
        if (!r || r.w < 16 || r.h < 12 || !onTop(field, r)) continue;
        const s = getComputedStyle(field);
        // A field drawn only by its wrapper (a search box's frame): judge the wrapper.
        const borderWidth = parseFloat(s.borderBottomWidth) + parseFloat(s.borderTopWidth);
        const own = rgba(s.backgroundColor);
        if (borderWidth === 0 && own[3] === 0) continue;
        const border = rgba(s.borderBottomColor);
        // The ring 3px outside the box, where the field's own container is on
        // top — never the window's edge or the frame's margin beyond it.
        const ring: Array<readonly [number, number]> = [];
        const frame = field.closest('main, [role="main"], [role="dialog"], dialog, .bsp-auth');
        const d = 3;
        const steps = 16;
        for (let i = 0; i <= steps; i++) {
          const x = r.x + (r.w * i) / steps;
          const y = r.y + (r.h * i) / steps;
          for (const [px, py] of [
            [x, r.y - d],
            [x, r.y + r.h + d],
            [r.x - d, y],
            [r.x + r.w + d, y],
          ] as const) {
            if (px < 0 || py < 0 || px >= vw || py >= vh) continue;
            const hit = document.elementFromPoint(px, py);
            if (
              hit &&
              hit !== field &&
              hit.contains(field.parentElement) &&
              (frame === null || frame.contains(hit))
            ) {
              ring.push([px, py]);
            }
          }
        }
        if (ring.length < 8) continue;
        out.push({
          kind: 'field',
          where: label(field),
          text: (field.getAttribute('aria-label') ?? field.getAttribute('name') ?? '').slice(0, 40),
          needed: 3,
          fg: borderWidth > 0 ? border : [0, 0, 0, 0],
          fill: own,
          rects: [r],
          ring,
        });
      }
      return out;
    },
    { scope: options.scope, exclude: options.exclude },
  );

  if (candidates.length === 0) return [];

  const style = await page.addStyleTag({ content: HIDE_INK });
  const shot = await page.screenshot({ type: 'png', scale: 'css' });
  await style.evaluate((node) => (node as Element).remove());

  return page.evaluate(
    async ({ png, list }: { png: string; list: Candidate[] }): Promise<PaintedFinding[]> => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const k = img.naturalWidth / window.innerWidth;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const px = (x: number, y: number): [number, number, number] => {
        const cx = Math.min(canvas.width - 1, Math.max(0, Math.round(x * k)));
        const cy = Math.min(canvas.height - 1, Math.max(0, Math.round(y * k)));
        const i = (cy * canvas.width + cx) * 4;
        return [data[i]!, data[i + 1]!, data[i + 2]!];
      };
      const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      const lum = (c: readonly number[]) =>
        0.2126 * lin(c[0]!) + 0.7152 * lin(c[1]!) + 0.0722 * lin(c[2]!);
      const ratio = (a: readonly number[], b: readonly number[]) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x! + 0.05) / (y! + 0.05);
      };
      const over = (fg: readonly number[], bg: readonly number[]) => {
        const a = fg[3]!;
        return [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a));
      };
      const hex = (c: readonly number[]) =>
        `#${c
          .slice(0, 3)
          .map((v) => Math.round(v).toString(16).padStart(2, '0'))
          .join('')}`;
      const sample = (
        rects: Candidate['rects'],
        ring: Candidate['ring'],
      ): Array<[number, number, number]> => {
        if (ring) return ring.map(([x, y]) => px(x, y));
        const points: Array<[number, number, number]> = [];
        for (const r of rects) {
          const nx = Math.min(24, Math.max(3, Math.round(r.w / 4)));
          const ny = Math.min(6, Math.max(2, Math.round(r.h / 5)));
          for (let i = 0; i < nx; i++) {
            for (let j = 0; j < ny; j++) {
              points.push(px(r.x + ((i + 0.5) * r.w) / nx, r.y + ((j + 0.5) * r.h) / ny));
            }
          }
        }
        return points;
      };
      const out: PaintedFinding[] = [];
      for (const c of list) {
        const bgs = sample(c.rects, c.ring);
        if (bgs.length === 0) continue;
        const measure = (fg: readonly number[]) => {
          const scored = bgs
            .map((bg) => ({ bg, r: ratio(over(fg, bg), bg) }))
            .sort((a, b) => a.r - b.r);
          return scored[Math.floor(scored.length * 0.1)]!;
        };
        let worst = measure(c.fg);
        if (c.kind === 'field' && c.fill && c.fill[3] > 0) {
          const byFill = measure(c.fill);
          if (byFill.r > worst.r) worst = byFill;
        }
        if (worst.r + 1e-6 < c.needed) {
          out.push({
            kind: c.kind,
            where: c.where,
            text: c.text,
            ratio: Math.round(worst.r * 100) / 100,
            needed: c.needed,
            fg: hex(over(c.kind === 'field' && c.fill ? c.fill : c.fg, worst.bg)),
            bg: hex(worst.bg),
          });
        }
      }
      return out;
    },
    { png: shot.toString('base64'), list: candidates },
  );
}
