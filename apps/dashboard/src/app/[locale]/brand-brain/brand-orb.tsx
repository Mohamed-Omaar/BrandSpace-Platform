'use client';

import { useCallback, useEffect, useRef } from 'react';
import { brandBrainTokens } from '@brandspace/ui';

/**
 * The Brand Brain orb — PORTED from the approved prototype (D-468).
 *
 * Source of truth: `docs/visual-reference/prototype-2026-09-27/Main.dc.html`,
 * `makeOrb(canvas, kind)` (the `orbRef('big')` canvas of the Knowledge hero,
 * line 768, and the `orbRef('small')` canvas of the chat header, line 901).
 * It replaces the `brand-brain-native.js` orb of the earlier demo.
 *
 * EVERY CONSTANT BELOW IS THE PROTOTYPE'S OWN: `S = 1.3`; spheres of 170 and 72
 * particles (60 and 24 small) built at `min(W, H) × 0.9` (× 1.25 small); links
 * measured at `min(W, H) × 0.82`; rotation 0.000055 (0.00032 while the small
 * orb's chat is busy); orbit 0.000012; perspective 700; a 90px pointer
 * repulsion of 24px; neighbour window 24; energy decay 0.965; no hole in the
 * middle; and the six nodes on an ellipse `R × 1.12` by `R × 0.86` where
 * `R = min(W, H) × 0.41 × S × 0.72`.
 *
 * WHAT IS A COMPONENT AND WHAT IS THE PROTOTYPE:
 *   - Typed props and callbacks are the component's. Real data reaches the orb
 *     at the prop boundary and changes NOTHING about how it is drawn.
 *   - Geometry, colour, motion, composition and interaction are the prototype's.
 *
 * TWO AUTHORISED DEPARTURES, both accessibility (D-468 (a), recorded earlier):
 *   - D-86: `prefers-reduced-motion` draws one static frame.
 *   - D-91: the prototype paints its six nodes on the canvas and hit-tests a
 *     click within 20px. Here each node is a real BUTTON — the same dot, label
 *     and count, at the same place, positioned per frame and quantised to whole
 *     pixels — so a keyboard and a screen reader can open an area, and a file
 *     can be dropped on one.
 */

export interface OrbNode {
  /** The product's area key, e.g. `IDENTITY`. */
  readonly area: string;
  /**
   * The orbit position's own name. The prototype colours the dots by position
   * (`[0, '#111114'], [1, '#7935fe'], [2, '#ffdd15'], …`): audience purple,
   * offers yellow, the rest ink — the stylesheet keys that on this attribute.
   */
  readonly slot: 'identity' | 'audience' | 'offers' | 'voice' | 'learnings' | 'strategy';
  /** The node's label — the area's name. */
  readonly label: string;
  /** The line under it — the area's "answered n of m". */
  readonly detail: string;
  /** Every key question answered: the prototype's green check dot. */
  readonly done: boolean;
}

/* --- the prototype's constants, transcribed ------------------------------- */

const S = 1.3;
const ANG = [3.55, 5.42, 0.3, 2.83, 1.62, 4.7] as const;

/*
 * THE PROTOTYPE'S COLOURS, THROUGH NAMED TOKENS THAT CARRY ITS EXACT VALUES
 * (`OUT = '#7935fe', INN = '#ffdd15', INK = '#111114'`, and `#ffffff` for a
 * flaring particle). The design system forbids hex literals in components.
 */
const OUT: string = brandBrainTokens.orbOuter;
const INN: string = brandBrainTokens.orbInner;
const INK: string = brandBrainTokens.orbInk;
const FLARE: string = brandBrainTokens.orbFlare;

/** The prototype's `rgba(hex, a)`. */
function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

interface Particle {
  x: number;
  y: number;
  z: number;
  c: string;
  inner: boolean;
  seed: number;
  e: number;
}

interface Projected {
  x: number;
  y: number;
  z: number;
  s: number;
  c: string;
  inner: boolean;
  e: number;
  seed: number;
}

/**
 * `makeOrb` — the particle field, its rotation, links, flares and pointer
 * repulsion. `small` is the 52px chat-header orb; the big one also places the
 * node buttons each frame (`onNodes`).
 */
function useOrbCanvas(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  small: boolean,
  busyRef: React.RefObject<boolean>,
  onNodes: ((t: number, w: number, h: number) => void) | null,
): void {
  const nodesRef = useRef(onNodes);
  nodesRef.current = onNodes;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    // No 2D context — a hardened browser, or a headless run with canvas off.
    // The nodes and the centre are DOM buttons and still work.
    if (!ctx) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let W = 0;
    let H = 0;
    let parts: Particle[] = [];
    let raf = 0;
    let alive = true;
    const ptr = { x: -999, y: -999, in: false };
    const tilt = { x: 0, y: 0, tx: 0, ty: 0 };

    const sphere = (n: number, r: number, inner: boolean): void => {
      const g = (1 + Math.sqrt(5)) / 2;
      for (let i = 0; i < n; i += 1) {
        const t = i / (n - 1);
        const inc = Math.acos(1 - 2 * t);
        const az = 2 * Math.PI * g * i;
        let c = OUT;
        if (i % 3 === 0) c = INN;
        if (i % 7 === 0) c = INK;
        parts.push({
          x: r * Math.sin(inc) * Math.cos(az),
          y: r * Math.sin(inc) * Math.sin(az),
          z: r * Math.cos(inc),
          c,
          inner,
          // The prototype seeds each link's bend randomly; it shapes nothing else.
          seed: Math.random() * 6.28,
          e: 0,
        });
      }
    };

    const size = (): void => {
      const r = canvas.getBoundingClientRect();
      W = r.width || (small ? 52 : 450);
      H = r.height || (small ? 52 : 362);
      const d = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * d);
      canvas.height = Math.round(H * d);
      ctx.setTransform(d, 0, 0, d, 0, 0);
      const u = Math.min(W, H) * (small ? 1.25 : 0.9);
      parts = [];
      sphere(small ? 60 : 170, u * 0.32 * S, false);
      sphere(small ? 24 : 72, u * 0.15 * S, true);
    };

    const draw = (t: number): void => {
      if (!alive) return;
      const cx = W / 2;
      const cy = H / 2;
      const u = Math.min(W, H) * (small ? 1.25 : 0.82);
      ctx.clearRect(0, 0, W, H);
      tilt.x += (tilt.tx - tilt.x) * 0.025;
      tilt.y += (tilt.ty - tilt.y) * 0.025;
      const busy = small && busyRef.current === true;
      const speed = busy ? 0.00032 : 0.000055;
      const ay = t * speed + tilt.x;
      const ax = -0.08 + tilt.y;
      const cX = Math.cos(ax);
      const sX = Math.sin(ax);
      const cY = Math.cos(ay);
      const sY = Math.sin(ay);
      const pr: Projected[] = [];
      for (const p of parts) {
        if (Math.random() < (busy ? 0.004 : 0.00035)) p.e = 1;
        p.e *= 0.965;
        const rx = p.x * cY - p.z * sY;
        const rz = p.x * sY + p.z * cY;
        const ry = p.y * cX - rz * sX;
        const fz = p.y * sX + rz * cX;
        const sc = 700 / (700 + fz);
        let px = cx + rx * sc;
        let py = cy + ry * sc;
        const dx = px - ptr.x;
        const dy = py - ptr.y;
        const dist = Math.hypot(dx, dy);
        if (!small && !p.inner && ptr.in && dist < 90) {
          const f = ((90 - dist) / 90) ** 2 * 24;
          px += (dx / (dist || 1)) * f;
          py += (dy / (dist || 1)) * f;
        }
        pr.push({ x: px, y: py, z: fz, s: sc, c: p.c, inner: p.inner, e: p.e, seed: p.seed });
      }
      pr.sort((a, b) => b.z - a.z);
      ctx.lineCap = 'round';
      for (let i = 0; i < pr.length; i += 1) {
        const a = pr[i]!;
        const md = (a.inner ? u * 0.145 : u * 0.11) * S * a.s;
        for (let j = i + 1; j < Math.min(i + 24, pr.length); j += 1) {
          const b = pr[j]!;
          if (a.inner !== b.inner) continue;
          const d2 = Math.hypot(a.x - b.x, a.y - b.y);
          if (d2 >= md) continue;
          const al = Math.min(
            0.52,
            (1 - d2 / md) * a.s * (a.inner ? 0.38 : 0.25) + Math.max(a.e, b.e) * 0.2,
          );
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          if (a.inner) ctx.lineTo(b.x, b.y);
          else {
            const bend = Math.sin(a.seed) * 4;
            ctx.quadraticCurveTo((a.x + b.x) / 2 + bend, (a.y + b.y) / 2 - bend, b.x, b.y);
          }
          ctx.strokeStyle = rgba(a.inner ? INN : OUT, al);
          ctx.lineWidth = Math.max(0.3, (a.inner ? 1.25 : 0.8) * a.s * (small ? 0.6 : 1));
          ctx.stroke();
        }
      }
      for (const p of pr) {
        const r = Math.max(0.5, (p.inner ? 2.7 : 2) * p.s * (small ? 0.55 : 1));
        const al = Math.min(1, Math.max(0.24, p.s * 0.86 + p.e * 0.35));
        if (p.e > 0.1) {
          const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 4);
          g.addColorStop(0, rgba(p.c === INN ? INN : OUT, p.e * p.s * 0.42));
          g.addColorStop(1, rgba(OUT, 0));
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 4, 0, 6.283);
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, 6.283);
        ctx.fillStyle = p.e > 0.58 ? rgba(FLARE, al) : rgba(p.c, al);
        ctx.fill();
      }
      nodesRef.current?.(t, W, H);
      if (!reduce && !document.hidden) raf = requestAnimationFrame(draw);
      else if (!reduce) raf = 0;
    };

    const mv = (e: PointerEvent): void => {
      const r = canvas.getBoundingClientRect();
      ptr.x = e.clientX - r.left;
      ptr.y = e.clientY - r.top;
      ptr.in = true;
      tilt.tx = (ptr.x / W - 0.5) * 0.24;
      tilt.ty = (ptr.y / H - 0.5) * 0.16;
    };
    const lv = (): void => {
      ptr.in = false;
      tilt.tx = 0;
      tilt.ty = 0;
    };
    const vis = (): void => {
      if (!reduce && !document.hidden && alive && !raf) raf = requestAnimationFrame(draw);
    };

    // The pointer is read on the stage (the canvas's parent) so the node
    // buttons above the canvas still steer the tilt, as on the prototype.
    const host = small ? canvas : (canvas.parentElement ?? canvas);
    host.addEventListener('pointermove', mv);
    host.addEventListener('pointerleave', lv);
    document.addEventListener('visibilitychange', vis);
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      if (Math.abs(r.width - W) < 1 && Math.abs(r.height - H) < 1) return;
      size();
      if (reduce) draw(0);
    });
    ro.observe(canvas);
    size();
    // D-86: with motion reduced, ONE frame — the prototype's `draw(0)` — and no
    // loop, so the static orb is the same on every load.
    if (reduce) draw(0);
    else raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener('pointermove', mv);
      host.removeEventListener('pointerleave', lv);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [canvasRef, small, busyRef]);
}

/** The Knowledge hero's orb: `canvas` + the 96px centre button + six nodes. */
export function BrandOrb({
  nodes,
  centerAriaLabel,
  stageAriaLabel,
  onSelectArea,
  onOpenChat,
  onDropFile,
  canUpload,
}: {
  nodes: readonly OrbNode[];
  /** The centre button's accessible name — "Open Brand Brain chat". */
  centerAriaLabel: string;
  /** The stage's own name — a knowledge map. */
  stageAriaLabel: string;
  onSelectArea: (area: string) => void;
  onOpenChat: () => void;
  onDropFile: (area: string | null, file: File) => void;
  canUpload: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const idle = useRef(false);

  /*
   * The prototype's node pass, on buttons: `a = ANG[i] + t × 0.000012`,
   * `x = cx + cos(a) × R × 1.12`, `y = cy + sin(a) × R × 0.86`, `z = (sin(a) +
   * 1) / 2`, scale `0.82 + z × 0.22`, alpha `0.72 + z × 0.28`. Whole pixels and
   * two decimals of scale (D-91), so a target holds still between the frames
   * in which it has not really moved.
   */
  const placeNodes = useCallback((t: number, w: number, h: number) => {
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.41 * S * 0.72;
    const orbit = t * 0.000012;
    nodeRefs.current.forEach((node, i) => {
      if (!node) return;
      const a = (ANG[i] ?? 0) + orbit;
      const x = cx + Math.cos(a) * R * 1.12;
      const y = cy + Math.sin(a) * R * 0.86;
      const z = (Math.sin(a) + 1) / 2;
      const sc = 0.82 + z * 0.22;
      node.style.left = `${Math.round(x)}px`;
      node.style.top = `${Math.round(y)}px`;
      node.style.opacity = (0.72 + z * 0.28).toFixed(2);
      node.style.transform = `translate(-50%,-50%) scale(${sc.toFixed(2)})`;
      node.style.zIndex = String(2 + Math.round(z * 3));
    });
  }, []);

  useOrbCanvas(canvasRef, false, idle, placeNodes);

  const handleDrop = useCallback(
    (area: string | null) => (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.remove('dragging');
      if (!canUpload) return;
      const file = event.dataTransfer.files?.[0];
      if (file) onDropFile(area, file);
    },
    [canUpload, onDropFile],
  );
  const allowDrop = useCallback(
    (event: React.DragEvent) => {
      if (!canUpload) return;
      event.preventDefault();
      event.currentTarget.classList.add('dragging');
    },
    [canUpload],
  );

  return (
    <div
      className="bsp-bb-stage"
      data-testid="brand-orb"
      role="group"
      aria-label={stageAriaLabel}
      onDragEnter={allowDrop}
      onDragOver={allowDrop}
      onDragLeave={(e) => e.currentTarget.classList.remove('dragging')}
      onDrop={handleDrop(null)}
    >
      <canvas ref={canvasRef} className="bsp-bb-canvas" aria-hidden="true" />
      <button
        type="button"
        className="bsp-bb-centre"
        data-testid="orb-center"
        aria-label={centerAriaLabel}
        onClick={onOpenChat}
      />
      {nodes.map((node, index) => (
        <button
          key={node.area}
          type="button"
          className="bsp-bb-node"
          data-testid={`orb-node-${node.area}`}
          data-slot={node.slot}
          data-done={node.done ? 'true' : undefined}
          data-area-key={node.area}
          ref={(element) => {
            nodeRefs.current[index] = element;
          }}
          onClick={() => onSelectArea(node.area)}
          onDragOver={allowDrop}
          onDragLeave={(e) => e.currentTarget.classList.remove('dragging')}
          onDrop={handleDrop(node.area)}
        >
          <i aria-hidden="true" />
          <b>{node.label}</b>
          <small>{node.detail}</small>
        </button>
      ))}
    </div>
  );
}

/**
 * The chat header's 52px orb (`orbRef('small')`): the same field, no nodes, and
 * spinning faster while an answer is being written (`_orbBusy`).
 */
export function MiniOrb({ busy }: { busy: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useOrbCanvas(canvasRef, true, busyRef, null);
  return <canvas ref={canvasRef} className="bsp-bb-mini" aria-hidden="true" />;
}
