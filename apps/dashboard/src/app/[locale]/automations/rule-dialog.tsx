'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useId, useRef, type ReactNode } from 'react';
import { useOverlayBehaviour } from '@brandspace/ui';

/**
 * THE RULE DIALOG — the prototype's rule builder, `Main.dc.html` lines
 * 1556–1569 (D-468): a 640px white card, 28px corners, `padding: 22px 24px`,
 * over a `rgba(17,17,20,.28)` veil.
 *
 * DRIVEN BY THE ADDRESS, like every other state on this screen: `?new=1` or
 * `?edit=<rule>` renders it on the server, so it opens without script and a
 * saved rule's redirect closes it. With script, Escape, the veil and ✕ go
 * back to the list; focus is trapped inside while it is open.
 */
export function RuleDialog({
  title,
  closeHref,
  closeLabel,
  testId,
  children,
}: {
  readonly title: string;
  readonly closeHref: string;
  readonly closeLabel: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const router = useRouter();
  const titleId = useId();
  const panelRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => router.push(closeHref), [router, closeHref]);
  useOverlayBehaviour({ open: true, onClose: close, containerRef: panelRef });

  return (
    <div
      className="bs-veil bsp-au-veil"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="bs-dialog-in bsp-au-dialog"
        data-testid={testId}
      >
        <div className="bsp-au-dialog-h">
          <h2 id={titleId} className="bsp-sech">
            {title}
          </h2>
          <Link
            href={closeHref}
            className="bsp-btn bsp-sm bsp-ghost"
            aria-label={closeLabel}
            data-testid="automation-dialog-close"
          >
            ✕
          </Link>
        </div>
        {children}
      </section>
    </div>
  );
}
