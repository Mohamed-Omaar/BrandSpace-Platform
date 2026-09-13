'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { colorTokens, typographyTokens } from '@brandspace/ui';

/**
 * The Brand Brain orb.
 *
 * A particle sphere on a canvas, with knowledge-area nodes in orbit around it.
 * It is the demo's centrepiece, rebuilt as a React component rather than pasted
 * in as a standalone script.
 *
 * WHAT MAKES IT SAFE TO RUN IN A PRODUCT RATHER THAN A PROTOTYPE:
 *
 *   - ONE animation frame, cancelled on unmount and whenever the tab is
 *     hidden. A prototype leaks a `requestAnimationFrame` loop per mount; a
 *     dashboard left open overnight would then spin a core forever.
 *   - `prefers-reduced-motion` is honoured by drawing ONE STATIC FRAME rather
 *     than by hiding the visual. Someone who asked for less motion still gets
 *     the knowledge map — they just get it still.
 *   - NO CANVAS, NO PROBLEM. If `getContext('2d')` returns null the nodes are
 *     still rendered and still clickable: the canvas is decoration over a real
 *     control layer, not the control layer itself.
 *   - The nodes are BUTTONS in the DOM, positioned by CSS. They are reachable
 *     by keyboard and readable by a screen reader whether or not a pixel of the
 *     sphere ever paints.
 *   - Particle count scales with the stage size, so a phone does not run the
 *     desktop simulation.
 */

export interface OrbNode {
  readonly area: string;
  readonly label: string;
  readonly detail: string;
  readonly status: 'COMPLETE' | 'NEEDS_ATTENTION' | 'IN_PROGRESS' | 'EMPTY';
}

const PURPLE = colorTokens.brandPurple;
const YELLOW = colorTokens.brandYellow;
const INK = colorTokens.ink;

interface Particle {
  x: number;
  y: number;
  z: number;
  color: string;
  isInner: boolean;
  seed: number;
  energy: number;
}

/**
 * Points on a sphere via the golden-angle spiral.
 *
 * Deterministic: the same count always produces the same distribution, so the
 * orb does not reshuffle itself on every render or between two users looking at
 * the same screen.
 */
function buildParticles(count: number): Particle[] {
  const particles: Particle[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i += 1) {
    const isInner = i % 4 === 0;
    const radius = isInner ? 46 : 100;
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    particles.push({
      x: Math.cos(theta) * ringRadius * radius,
      y: y * radius,
      z: Math.sin(theta) * ringRadius * radius,
      color: isInner ? YELLOW : i % 7 === 0 ? INK : PURPLE,
      isInner,
      seed: (i % 17) / 17,
      energy: 0,
    });
  }
  return particles;
}

export function BrandOrb({
  nodes,
  centerLabel,
  centerAriaLabel,
  hint,
  onSelectArea,
  onDropFile,
  canUpload,
}: {
  nodes: readonly OrbNode[];
  centerLabel: string;
  centerAriaLabel: string;
  hint: string;
  onSelectArea: (area: string) => void;
  onDropFile: (area: string | null, file: File) => void;
  canUpload: boolean;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragArea, setDragArea] = useState<string | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;

    const context = canvas.getContext('2d');
    // No 2D context — an old browser, a hardened one, or a headless run with
    // canvas disabled. The nodes below still render and still work.
    if (!context) return;

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let frame = 0;
    let running = true;
    const pointer = { x: -9999, y: -9999, inside: false };
    const tilt = { x: 0, y: 0, tx: 0, ty: 0 };
    let particles: Particle[] = [];
    let dpr = 1;

    const resize = () => {
      const rect = stage.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Fewer particles on a small stage: a phone must not run the desktop
      // simulation to draw a smaller picture.
      const unit = Math.min(rect.width, rect.height);
      particles = buildParticles(unit < 380 ? 200 : unit < 560 ? 320 : 460);
    };

    const draw = (time: number) => {
      if (!running || !stage.isConnected) return;
      const rect = stage.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const unit = Math.min(rect.width, rect.height);
      const scaleBase = unit * 0.0032;
      context.clearRect(0, 0, rect.width, rect.height);

      tilt.x += (tilt.tx - tilt.x) * 0.03;
      tilt.y += (tilt.ty - tilt.y) * 0.03;

      // A reduced-motion render is one still frame: no rotation term, no
      // pointer repulsion, no scheduled next frame.
      const spin = reduceMotion ? 0.6 : time * 0.000055 + tilt.x;
      const pitch = reduceMotion ? -0.08 : -0.08 + tilt.y;
      const cosX = Math.cos(pitch);
      const sinX = Math.sin(pitch);
      const cosY = Math.cos(spin);
      const sinY = Math.sin(spin);

      const projected = particles.map((p) => {
        if (!reduceMotion) {
          if (Math.random() < 0.0004) p.energy = 1;
          p.energy *= 0.965;
        }
        const rx = p.x * cosY - p.z * sinY;
        const rz = p.x * sinY + p.z * cosY;
        const ry = p.y * cosX - rz * sinX;
        const finalZ = p.y * sinX + rz * cosX;
        const depth = 700 / (700 + finalZ);
        // `scaleBase` already maps the particle's ±100 model space onto the
        // stage radius. Multiplying by 100 again put every point ~16,000px
        // off-screen and drew an empty canvas — invisible in a unit test,
        // obvious the moment the page was opened in a browser.
        let px = cx + rx * depth * scaleBase;
        let py = cy + ry * depth * scaleBase;

        if (!reduceMotion && !p.isInner && pointer.inside) {
          const dx = px - pointer.x;
          const dy = py - pointer.y;
          const distance = Math.hypot(dx, dy);
          const reach = unit * 0.22;
          if (distance < reach && distance > 0) {
            const force = ((reach - distance) / reach) ** 2 * unit * 0.06;
            px += (dx / distance) * force;
            py += (dy / distance) * force;
          }
        }
        // Spread FIRST, then the projected values: the other order silently
        // discarded the whole projection and drew the model-space points.
        return { ...p, x: px, y: py, z: finalZ, depth };
      });

      projected.sort((a, b) => b.z - a.z);

      context.lineCap = 'round';
      for (let i = 0; i < projected.length; i += 1) {
        const p1 = projected[i];
        if (!p1) continue;
        const maxDistance = (p1.isInner ? unit * 0.145 : unit * 0.11) * p1.depth;
        // Only the next few neighbours: an all-pairs pass is O(n^2) and is what
        // turns a pretty effect into a hot fan.
        for (let j = i + 1; j < Math.min(i + 18, projected.length); j += 1) {
          const p2 = projected[j];
          if (!p2 || p1.isInner !== p2.isInner) continue;
          const distance = Math.hypot(p1.x - p2.x, p1.y - p2.y);
          if (distance >= maxDistance) continue;
          const energy = Math.max(p1.energy, p2.energy);
          const alpha = Math.min(
            0.5,
            (1 - distance / maxDistance) * p1.depth * (p1.isInner ? 0.34 : 0.22) + energy * 0.2,
          );
          context.beginPath();
          context.moveTo(p1.x, p1.y);
          context.lineTo(p2.x, p2.y);
          context.strokeStyle = p1.isInner
            ? `rgba(255,221,21,${alpha})`
            : `rgba(121,53,254,${alpha})`;
          context.lineWidth = Math.max(0.3, (p1.isInner ? 1.2 : 0.8) * p1.depth);
          context.stroke();
        }
      }

      for (const p of projected) {
        const radius = Math.max(0.6, (p.isInner ? 2.6 : 1.9) * p.depth);
        const alpha = Math.min(1, Math.max(0.22, p.depth * 0.85 + p.energy * 0.35));
        context.beginPath();
        context.arc(p.x, p.y, radius, 0, Math.PI * 2);
        context.fillStyle =
          p.energy > 0.58
            ? `rgba(255,255,255,${alpha})`
            : p.color === PURPLE
              ? `rgba(121,53,254,${alpha})`
              : p.color === YELLOW
                ? `rgba(255,221,21,${alpha})`
                : `rgba(17,17,20,${alpha})`;
        context.fill();
      }

      // Punch a hole so the centre button reads as inside the sphere.
      context.save();
      context.globalCompositeOperation = 'destination-out';
      context.beginPath();
      context.arc(cx, cy, unit * 0.098, 0, Math.PI * 2);
      context.fill();
      context.restore();

      if (!reduceMotion) frame = requestAnimationFrame(draw);
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = stage.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
      pointer.inside = true;
      tilt.tx = ((pointer.x - rect.width / 2) / rect.width) * 0.6;
      tilt.ty = ((pointer.y - rect.height / 2) / rect.height) * 0.4;
    };
    const onPointerLeave = () => {
      pointer.inside = false;
      tilt.tx = 0;
      tilt.ty = 0;
    };

    /*
     * A HIDDEN TAB DRAWS NOTHING.
     *
     * Browsers already throttle rAF in a background tab, but they do not stop
     * it, and a dashboard is exactly the kind of page that stays open for days.
     * Cancelling outright is the difference between an idle tab and a warm
     * laptop.
     */
    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(frame);
      } else if (!running) {
        running = true;
        frame = requestAnimationFrame(draw);
      }
    };

    const observer = new ResizeObserver(() => {
      resize();
      if (reduceMotion) draw(0);
    });
    observer.observe(stage);
    resize();

    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', onVisibility);

    frame = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const handleDrop = useCallback(
    (area: string | null) => (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      setDragArea(null);
      if (!canUpload) return;
      const file = event.dataTransfer.files?.[0];
      if (file) onDropFile(area, file);
    },
    [canUpload, onDropFile],
  );

  const allowDrop = (event: React.DragEvent) => {
    if (!canUpload) return;
    event.preventDefault();
    setDragging(true);
  };

  return (
    <div
      ref={stageRef}
      data-testid="brand-orb"
      data-dragging={dragging ? 'true' : 'false'}
      onDragOver={allowDrop}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop(null)}
      style={{
        position: 'relative',
        // Taller relative to width on a phone: the orbit nodes are a fixed
        // minimum size, so a short stage crowds them against the core.
        minHeight: 'min(86vw, 500px)',
        borderRadius: '26px',
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
        background:
          'radial-gradient(circle at 30% 28%, rgba(121,53,254,.20), transparent 32%),' +
          'radial-gradient(circle at 72% 70%, rgba(255,221,21,.34), transparent 34%),' +
          `linear-gradient(145deg,${colorTokens.surfaceLavender},${colorTokens.surface})`,
        outline: dragging ? `2px dashed ${PURPLE}` : '2px dashed transparent',
        outlineOffset: '-10px',
        transition: 'outline-color .2s',
      }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />

      <button
        type="button"
        data-testid="orb-center"
        onClick={() => onSelectArea('__chat__')}
        style={{
          position: 'relative',
          zIndex: 3,
          width: 'min(26vw, 170px)',
          height: 'min(26vw, 170px)',
          borderRadius: '26%',
          border: 0,
          background: INK,
          color: colorTokens.surface,
          cursor: 'pointer',
          fontWeight: 800,
          fontSize: 'clamp(0.8rem, 2.4vw, 1.1rem)',
          lineHeight: 1.15,
          boxShadow: '0 30px 70px rgba(17,17,20,.25)',
        }}
      >
        <span aria-hidden="true">{centerLabel}</span>
        <span
          style={{
            position: 'absolute',
            width: 1,
            height: 1,
            overflow: 'hidden',
            clip: 'rect(0 0 0 0)',
            whiteSpace: 'nowrap',
          }}
        >
          {centerAriaLabel}
        </span>
      </button>

      {nodes.map((node, index) => (
        <button
          key={node.area}
          type="button"
          data-testid={`orb-node-${node.area}`}
          data-area={node.area}
          onClick={() => onSelectArea(node.area)}
          onDragOver={(event) => {
            allowDrop(event);
            setDragArea(node.area);
          }}
          onDragLeave={() => setDragArea(null)}
          onDrop={handleDrop(node.area)}
          style={{
            position: 'absolute',
            zIndex: 4,
            ...nodePosition(index, nodes.length),
            minWidth: 'clamp(88px, 24vw, 124px)',
            padding: '10px 12px',
            borderRadius: '16px',
            border:
              dragArea === node.area ? `2px solid ${PURPLE}` : '2px solid rgba(255,255,255,0)',
            background: 'rgba(255,255,255,.93)',
            boxShadow: '0 14px 36px rgba(39,26,74,.10)',
            font: 'inherit',
            fontSize: 'clamp(0.6rem, 1.7vw, 0.7rem)',
            fontWeight: 800,
            textAlign: 'start',
            cursor: 'pointer',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 8,
              height: 8,
              borderRadius: '50%',
              marginInlineEnd: 7,
              background:
                node.status === 'COMPLETE'
                  ? colorTokens.success
                  : node.status === 'NEEDS_ATTENTION'
                    ? colorTokens.warning
                    : PURPLE,
            }}
          />
          {node.label}
          <small
            style={{
              display: 'block',
              marginTop: 3,
              color: colorTokens.textMuted,
              fontSize: 'clamp(0.5rem, 1.4vw, 0.6rem)',
              fontWeight: 600,
            }}
          >
            {node.detail}
          </small>
        </button>
      ))}

      <p
        style={{
          position: 'absolute',
          insetInlineStart: '50%',
          transform: 'translateX(-50%)',
          bottom: 8,
          margin: 0,
          fontSize: typographyTokens.caption.fontSize,
          color: colorTokens.textMuted,
          textAlign: 'center',
          maxWidth: '80%',
        }}
      >
        {hint}
      </p>
    </div>
  );
}

/**
 * Node placement, in percentages.
 *
 * A ring rather than the demo's six hard-coded corners: the product has ten
 * areas and the demo showed six, so positions are computed and the layout does
 * not break when the number changes. Percentages keep it responsive without a
 * second set of values per breakpoint.
 */
function nodePosition(index: number, total: number): React.CSSProperties {
  const angle = (index / Math.max(1, total)) * Math.PI * 2 - Math.PI / 2;
  // 42% rather than 38%: far enough out that a node never sits on the core,
  // close enough in that it stays over the sphere it labels.
  const top = 50 + Math.sin(angle) * 42;
  const left = 50 + Math.cos(angle) * 42;
  return {
    top: `${Math.min(88, Math.max(2, top))}%`,
    left: `${Math.min(84, Math.max(2, left))}%`,
    transform: 'translate(-50%, -50%)',
  };
}
