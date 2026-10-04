'use client';

import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from './motion';

/**
 * HOME'S HERO BACKGROUND, PORTED FROM `prototype-2026-09-27` (D-468):
 * `makeHero` in `Main.dc.html` (lines 1993–2028), transcribed.
 *
 * A `#f9f7ff` ground and four soft elliptical blobs — butter, blush, lilac and
 * violet — each drifting on its own slow sine path and breathing ±9 %. Every
 * constant below is the prototype's: the colours and alphas, the centres and
 * radii as fractions of the canvas, the drift amplitudes and periods, the
 * phase offsets and the gradient's four stops.
 *
 * Reduced motion draws one still frame (t = 0), as the prototype does; a hidden
 * tab stops drawing and resumes on return. The canvas is decorative: it is
 * `aria-hidden` and takes no pointer events.
 */

interface Blob {
  readonly c: readonly [number, number, number];
  readonly a: number;
  readonly x: number;
  readonly y: number;
  readonly rx: number;
  readonly ry: number;
  readonly ax: number;
  readonly ay: number;
  readonly px: number;
  readonly py: number;
  readonly ph: number;
}

const GROUND = '#f9f7ff';

const BLOBS: readonly Blob[] = [
  {
    c: [251, 224, 104],
    a: 0.8,
    x: 0.27,
    y: 0.78,
    rx: 0.3,
    ry: 0.62,
    ax: 0.11,
    ay: 0.14,
    px: 14000,
    py: 17000,
    ph: 0,
  },
  {
    c: [248, 186, 212],
    a: 0.6,
    x: 0.68,
    y: 0.28,
    rx: 0.25,
    ry: 0.62,
    ax: 0.12,
    ay: 0.16,
    px: 16000,
    py: 13000,
    ph: 1.7,
  },
  {
    c: [222, 212, 255],
    a: 0.55,
    x: 0.1,
    y: 0.1,
    rx: 0.24,
    ry: 0.5,
    ax: 0.08,
    ay: 0.12,
    px: 18000,
    py: 15000,
    ph: 3.1,
  },
  {
    c: [196, 172, 255],
    a: 0.34,
    x: 0.5,
    y: 0.55,
    rx: 0.2,
    ry: 0.55,
    ax: 0.18,
    ay: 0.1,
    px: 21000,
    py: 16000,
    ph: 4.4,
  },
];

export function PrototypeHeroCanvas({ className }: { readonly className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const reduce = prefersReducedMotion();
    let width = 0;
    let height = 0;
    let raf = 0;
    let alive = true;
    const size = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width || 1100;
      height = rect.height || 360;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const draw = (t: number) => {
      if (!alive) return;
      const now = canvas.getBoundingClientRect();
      if (Math.abs(now.width - width) > 1 || Math.abs(now.height - height) > 1) size();
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = GROUND;
      ctx.fillRect(0, 0, width, height);
      for (const b of BLOBS) {
        const cx = (b.x + Math.sin((t / b.px) * 6.283 + b.ph) * b.ax) * width;
        const cy = (b.y + Math.cos((t / b.py) * 6.283 + b.ph) * b.ay) * height;
        const breathe = 1 + Math.sin((t / (b.px * 0.9)) * 6.283 + b.ph) * 0.09;
        const rx = b.rx * width * breathe;
        const ry = b.ry * height * breathe;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(1, ry / rx);
        const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        const c = b.c.join(',');
        gradient.addColorStop(0, `rgba(${c},${b.a})`);
        gradient.addColorStop(0.35, `rgba(${c},${b.a * 0.72})`);
        gradient.addColorStop(0.7, `rgba(${c},${b.a * 0.25})`);
        gradient.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(0, 0, rx, 0, 6.283);
        ctx.fill();
        ctx.restore();
      }
      raf = !reduce && !document.hidden ? requestAnimationFrame(draw) : 0;
    };
    const visible = () => {
      if (!reduce && !document.hidden && alive && !raf) raf = requestAnimationFrame(draw);
    };
    document.addEventListener('visibilitychange', visible);
    size();
    if (reduce) draw(0);
    else raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return <canvas ref={ref} aria-hidden="true" className={className} />;
}
