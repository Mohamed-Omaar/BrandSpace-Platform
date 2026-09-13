'use client';

import { useCallback, useEffect, useRef } from 'react';
import { brandBrainTokens } from '@brandspace/ui';

/**
 * The Brand Brain orb — PORTED VERBATIM from the approved demo.
 *
 * Source of truth: `demo/brand-brain-native.js` in Mohamed-Omaar/Brandspace-Landing-page
 * at commit b01d94738672c64f651098512c03faf4554ebb97
 * SHA-256 dc91db029fb8388aece3b47cdb00de05b654002f2c1df8efd458803722591085
 * Snapshot: docs/visual-reference/brand-brain-native/brand-brain-native.js
 *
 * EVERY CONSTANT BELOW IS THE DEMO'S OWN. `orbScale` is 1.3 because the demo says
 * 1.3; the rotation coefficient is 0.000055 because the demo says 0.000055; the
 * neighbour window is 24 because the demo says 24. `docs/UI-FIDELITY-CONTRACT.md`
 * makes this a specification rather than a reference: the previous version of
 * this file re-interpreted it — a lavender container, a black rounded square,
 * white cards instead of dots — and passed every automated check while being
 * wrong.
 *
 * WHAT IS A COMPONENT AND WHAT IS THE DEMO:
 *   - Typed props and callbacks are the component's (rule 5). Real data reaches
 *     the orb at the prop boundary and changes NOTHING about how it is drawn.
 *   - Geometry, colour, motion, composition and interaction are the demo's.
 *
 * The single authorised deviation is D-86: `prefers-reduced-motion` draws one
 * static frame rather than animating. The demo has no reduced-motion path at all,
 * and CLAUDE.md §4 requires WCAG 2.2 AA. The orb is still shown.
 */

export interface OrbNode {
  /** The product's area key, e.g. `IDENTITY`. */
  readonly area: string;
  /**
   * The demo's own slot name for this position — `identity`, `audience`,
   * `offers`, `voice`, `learnings`, `strategy`.
   *
   * It is a separate field from `area` on purpose. The demo's stylesheet colours
   * the dots with attribute selectors (`[data-area="audience"]` is purple,
   * `[data-area="offers"]` is yellow, the rest are ink), so the attribute has to
   * carry the demo's vocabulary, not the product's. Mapping the product key onto
   * it would silently change which dots are which colour — the exact class of
   * "approximate substitution" the fidelity contract forbids.
   */
  readonly slot: 'identity' | 'audience' | 'offers' | 'voice' | 'learnings' | 'strategy';
  /** The demo's `<b>` label — "Identity", "Audience", … */
  readonly label: string;
  /** The demo's `<small>` tooltip. Real counts replace the demo's literals. */
  readonly detail: string;
}

/* --- the demo's constants, transcribed ----------------------------------- */

const ORB_SCALE = 1.3;

/*
 * THE DEMO'S COLOURS, THROUGH NAMED TOKENS THAT CARRY THE DEMO'S EXACT VALUES.
 *
 * `brandBrainTokens` exists for precisely this: the design system forbids hex
 * literals in application source, and the obvious fix — reach for `brandPurple`
 * — is the substitution the fidelity contract forbids. The tokens are
 * transcriptions, asserted equal to the vendored snapshot by
 * tests/unit/ui-fidelity-manifest.test.ts.
 */
const OUTER_COLOUR: string = brandBrainTokens.orbOuter;
const INNER_COLOUR: string = brandBrainTokens.orbInner;
const INK_COLOUR: string = brandBrainTokens.orbInk;
const FLARE_COLOUR: string = brandBrainTokens.orbFlare;

/**
 * `rgba()` from one of the tokens above.
 *
 * The demo writes its translucent fills as literal `rgba(121,53,254,a)` next to
 * the opaque `#7935fe` it assigns to the same particle. Deriving them here
 * instead makes the two impossible to drift apart, and the numbers it produces
 * are the demo's own.
 */
function withAlpha(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

/** The demo's six orbit angles, in its own order. */
const NODE_ANGLES = [3.55, 5.42, 0.3, 2.83, 1.62, 4.7] as const;

interface Particle {
  x: number;
  y: number;
  z: number;
  color: string;
  isInner: boolean;
  seed: number;
  energy: number;
}

export function BrandOrb({
  nodes,
  centerLabel,
  centerAriaLabel,
  stageAriaLabel,
  hint,
  onSelectArea,
  onOpenChat,
  onDropFile,
  canUpload,
}: {
  nodes: readonly OrbNode[];
  /** Rendered in the centre. The demo shows "Brand Brain", never a brand name. */
  readonly centerLabel: readonly string[];
  /** The centre button's accessible name — "Open Brand Brain chat". */
  centerAriaLabel: string;
  /** The stage's own name — the demo labels it as a knowledge map. */
  stageAriaLabel: string;
  hint: string;
  onSelectArea: (area: string) => void;
  onOpenChat: () => void;
  onDropFile: (area: string | null, file: File) => void;
  canUpload: boolean;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodeRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;

    const ctx = canvas.getContext('2d');
    // No 2D context — a hardened browser, or a headless run with canvas off. The
    // nodes and the centre are DOM buttons and still work.
    if (!ctx) return;

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let active = true;
    let raf = 0;
    const pointer = { x: -999, y: -999, inside: false };
    const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
    let particles: Particle[] = [];

    /* --- buildSphere: the demo's Fibonacci sphere, unchanged --------------- */
    function buildSphere(count: number, radius: number, isInner: boolean): void {
      const golden = (1 + Math.sqrt(5)) / 2;
      for (let i = 0; i < count; i += 1) {
        const ratio = i / (count - 1);
        const inclination = Math.acos(1 - 2 * ratio);
        const azimuth = 2 * Math.PI * golden * i;
        let color = OUTER_COLOUR;
        if (i % 3 === 0) color = INNER_COLOUR;
        if (i % 7 === 0) color = INK_COLOUR;
        particles.push({
          x: radius * Math.sin(inclination) * Math.cos(azimuth),
          y: radius * Math.sin(inclination) * Math.sin(azimuth),
          z: radius * Math.cos(inclination),
          color,
          isInner,
          // The demo seeds the curve bend randomly. Kept, because it is what the
          // approved motion looks like; it affects only the bend of a link.
          seed: Math.random() * Math.PI * 2,
          energy: 0,
        });
      }
    }

    function buildParticles(): void {
      const r = stage!.getBoundingClientRect();
      const unit = Math.min(r.width, r.height);
      particles = [];
      buildSphere(r.width < 650 ? 130 : 180, unit * 0.32 * ORB_SCALE, false);
      buildSphere(r.width < 650 ? 55 : 78, unit * 0.15 * ORB_SCALE, true);
    }

    function size(): void {
      if (!active || !stage!.isConnected) return;
      const r = stage!.getBoundingClientRect();
      const d = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.round(r.width * d);
      canvas!.height = Math.round(r.height * d);
      canvas!.style.width = `${r.width}px`;
      canvas!.style.height = `${r.height}px`;
      ctx!.setTransform(d, 0, 0, d, 0, 0);
      buildParticles();
    }

    function glow(x: number, y: number, radius: number, color: string, intensity: number): void {
      if (intensity < 0.06) return;
      const hue = color === INNER_COLOUR ? INNER_COLOUR : OUTER_COLOUR;
      const g = ctx!.createRadialGradient(x, y, 0, x, y, radius * 4);
      g.addColorStop(0, withAlpha(hue, intensity * 0.42));
      g.addColorStop(1, withAlpha(hue, 0));
      ctx!.fillStyle = g;
      ctx!.beginPath();
      ctx!.arc(x, y, radius * 4, 0, Math.PI * 2);
      ctx!.fill();
    }

    /* --- positionNodes: the demo's orbit ----------------------------------- */
    /*
     * ONE DEPARTURE, AND IT IS SUB-PIXEL: the position and scale are QUANTISED.
     *
     * The demo writes fractional pixels, so a 12px dot's box changes on every
     * single frame even though it crosses a whole pixel only about three times
     * a second. That is invisible to a reader and consequential to everyone
     * else: a target that never holds still for two consecutive frames cannot be
     * clicked reliably by assistive tooling, cannot be hit by a browser's own
     * click stabilisation, and — the way it surfaced here — cannot be clicked by
     * Playwright at all, which is how the orb's own nodes went untested.
     *
     * Rounding to whole pixels and to two decimal places of scale leaves the
     * rendered result identical at any zoom a person uses, and makes the dot
     * hold still between the frames in which it has not actually moved.
     * Recorded as D-91.
     */
    function positionNodes(t: number): void {
      const rect = stage!.getBoundingClientRect();
      const radius = Math.min(rect.width, rect.height) * 0.41 * ORB_SCALE;
      const rx = radius * 0.72;
      const ry = radius * 0.72;
      const orbit = t * 0.000012;
      nodeRefs.current.forEach((node, i) => {
        if (!node) return;
        const a = (NODE_ANGLES[i] ?? 0) + orbit;
        const x = rect.width / 2 + Math.cos(a) * rx;
        const y = rect.height / 2 + Math.sin(a) * ry;
        const z = (Math.sin(a) + 1) / 2;
        const scale = 0.82 + z * 0.22;
        node.style.left = `${Math.round(x)}px`;
        node.style.top = `${Math.round(y)}px`;
        node.style.opacity = String(0.7 + z * 0.3);
        node.style.transform = `translate(-50%,-50%) scale(${scale.toFixed(2)})`;
        node.style.zIndex = String(5 + Math.round(z * 3));
      });
    }

    /* --- draw: the demo's frame, unchanged --------------------------------- */
    function draw(t: number): void {
      if (!active || !stage!.isConnected) return;
      const rect = stage!.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const unit = Math.min(rect.width, rect.height);
      const outerRadius = unit * 0.32 * ORB_SCALE;
      const holeRadius = outerRadius * 0.27;
      ctx!.clearRect(0, 0, rect.width, rect.height);
      tilt.x += (tilt.tx - tilt.x) * 0.025;
      tilt.y += (tilt.ty - tilt.y) * 0.025;
      const ay = t * 0.000055 + tilt.x;
      const ax = -0.08 + tilt.y;
      const cosX = Math.cos(ax);
      const sinX = Math.sin(ax);
      const cosY = Math.cos(ay);
      const sinY = Math.sin(ay);
      const projected: {
        x: number;
        y: number;
        z: number;
        scale: number;
        color: string;
        isInner: boolean;
        energy: number;
        seed: number;
      }[] = [];

      for (const p of particles) {
        if (Math.random() < 0.00035) p.energy = 1;
        p.energy *= 0.965;
        const rx = p.x * cosY - p.z * sinY;
        const rz = p.x * sinY + p.z * cosY;
        const ry = p.y * cosX - rz * sinX;
        const finalZ = p.y * sinX + rz * cosX;
        const scale = 700 / (700 + finalZ);
        let px = cx + rx * scale;
        let py = cy + ry * scale;
        const dx = px - pointer.x;
        const dy = py - pointer.y;
        const dist = Math.hypot(dx, dy);
        if (!p.isInner && pointer.inside && dist < 105 * ORB_SCALE) {
          const force = ((105 * ORB_SCALE - dist) / (105 * ORB_SCALE)) ** 2 * 28 * ORB_SCALE;
          px += (dx / (dist || 1)) * force;
          py += (dy / (dist || 1)) * force;
        }
        projected.push({
          x: px,
          y: py,
          z: finalZ,
          scale,
          color: p.color,
          isInner: p.isInner,
          energy: p.energy,
          seed: p.seed,
        });
      }

      projected.sort((a, b) => b.z - a.z);
      ctx!.lineCap = 'round';
      ctx!.lineJoin = 'round';

      for (let i = 0; i < projected.length; i += 1) {
        const p1 = projected[i];
        if (!p1) continue;
        const maxDistance = (p1.isInner ? unit * 0.145 : unit * 0.11) * ORB_SCALE * p1.scale;
        for (let j = i + 1; j < Math.min(i + 24, projected.length); j += 1) {
          const p2 = projected[j];
          if (!p2 || p1.isInner !== p2.isInner) continue;
          const distance = Math.hypot(p1.x - p2.x, p1.y - p2.y);
          if (distance >= maxDistance) continue;
          const energy = Math.max(p1.energy, p2.energy);
          const alpha = Math.min(
            0.52,
            (1 - distance / maxDistance) * p1.scale * (p1.isInner ? 0.38 : 0.25) + energy * 0.2,
          );
          ctx!.beginPath();
          ctx!.moveTo(p1.x, p1.y);
          if (p1.isInner) {
            ctx!.lineTo(p2.x, p2.y);
          } else {
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            const bend = Math.sin(p1.seed) * 4;
            ctx!.quadraticCurveTo(mx + bend, my - bend, p2.x, p2.y);
          }
          ctx!.strokeStyle = withAlpha(p1.isInner ? INNER_COLOUR : OUTER_COLOUR, alpha);
          ctx!.lineWidth = Math.max(0.3, (p1.isInner ? 1.25 : 0.8) * p1.scale);
          ctx!.stroke();
        }
      }

      for (const p of projected) {
        const radius = Math.max(0.65, (p.isInner ? 2.7 : 2) * p.scale);
        const alpha = Math.min(1, Math.max(0.24, p.scale * 0.86 + p.energy * 0.35));
        if (p.energy > 0.1) glow(p.x, p.y, radius, p.color, p.energy * p.scale);
        ctx!.beginPath();
        ctx!.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx!.fillStyle =
          p.energy > 0.58 ? withAlpha(FLARE_COLOUR, alpha) : withAlpha(p.color, alpha);
        ctx!.fill();
      }

      // The demo punches a hole so the centre label sits inside the sphere.
      ctx!.save();
      ctx!.globalCompositeOperation = 'destination-out';
      ctx!.beginPath();
      ctx!.arc(cx, cy, holeRadius, 0, Math.PI * 2);
      ctx!.fill();
      ctx!.restore();

      positionNodes(t);
      // D-86: one frame when motion is reduced. Everything above already ran, so
      // the orb is drawn — it simply does not advance.
      if (!reduceMotion) raf = requestAnimationFrame(draw);
    }

    function localPointer(e: PointerEvent): void {
      const r = stage!.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      pointer.inside = true;
      tilt.tx = (pointer.x / r.width - 0.5) * 0.24;
      tilt.ty = (pointer.y / r.height - 0.5) * 0.16;
    }
    function leave(): void {
      pointer.inside = false;
      tilt.tx = 0;
      tilt.ty = 0;
    }

    /*
     * A HIDDEN TAB DRAWS NOTHING. Not in the demo, which is a page somebody looks
     * at for a minute; a dashboard stays open for days, and browsers throttle
     * `requestAnimationFrame` in a background tab without stopping it. This
     * changes no pixel of the visible result, so it is not a visual deviation.
     */
    function onVisibility(): void {
      if (reduceMotion) return;
      if (document.hidden) {
        cancelAnimationFrame(raf);
      } else if (active) {
        raf = requestAnimationFrame(draw);
      }
    }

    stage.addEventListener('pointermove', localPointer);
    stage.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', onVisibility);

    const ro = new ResizeObserver(() => {
      size();
      if (reduceMotion) draw(0);
    });
    ro.observe(stage);
    size();
    raf = requestAnimationFrame(draw);

    return () => {
      active = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      stage.removeEventListener('pointermove', localPointer);
      stage.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const handleDrop = useCallback(
    (area: string | null) => (event: React.DragEvent) => {
      event.preventDefault();
      event.currentTarget.classList.remove('dragging');
      stageRef.current?.classList.remove('dragging');
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
      ref={stageRef}
      className="bb-orb-stage"
      data-testid="brand-orb"
      aria-label={stageAriaLabel}
      onDragEnter={allowDrop}
      onDragOver={allowDrop}
      onDragLeave={(e) => e.currentTarget.classList.remove('dragging')}
      onDrop={handleDrop(null)}
    >
      <canvas ref={canvasRef} className="bb-orb-canvas" aria-hidden="true" />

      <button type="button" className="bb-orb-center" data-testid="orb-center" onClick={onOpenChat}>
        <span className="bb-orb-label" aria-hidden="true">
          {centerLabel.map((line) => (
            <span key={line} style={{ display: 'block' }}>
              {line}
            </span>
          ))}
        </span>
        <span className="bb-sr-only">{centerAriaLabel}</span>
      </button>

      <span className="bb-orb-hint">{hint}</span>

      {nodes.map((node, index) => (
        <button
          key={node.area}
          type="button"
          className="bb-orbit-node"
          data-testid={`orb-node-${node.area}`}
          data-area={node.slot}
          data-area-key={node.area}
          ref={(element) => {
            nodeRefs.current[index] = element;
          }}
          onClick={() => onSelectArea(node.area)}
          onDragOver={allowDrop}
          onDragLeave={(e) => e.currentTarget.classList.remove('dragging')}
          onDrop={handleDrop(node.area)}
        >
          <b>{node.label}</b>
          <small>{node.detail}</small>
        </button>
      ))}
    </div>
  );
}
