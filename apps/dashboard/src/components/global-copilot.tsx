'use client';

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import {
  StateMessage,
  useDismissOnOutsidePointer,
  useOverlayBehaviour,
  type CopilotLabels,
} from '@brandspace/ui';
import Link from 'next/link';
import { CopilotView } from '../app/[locale]/copilot/copilot-view';
import { OPEN_COPILOT_EVENT } from './copilot-link';
import { MoreDisclosure } from './more-disclosure';

/**
 * THE GLOBAL COPILOT (Phase 6 final, D-277 §37).
 *
 * The top bar's Copilot control now opens the Copilot OVER the screen the
 * person is on, in the demo's side drawer, instead of taking them away from
 * it. The conversation knows the workspace (the session), the brand (the
 * rail's), the screen (the surface) and — on a campaign, a post or an insight
 * — the object itself (D-280), and says so in its context line.
 *
 * PROGRESSIVE: the control is still the top bar's LINK to the full Copilot
 * screen. With script, a plain click opens the drawer; a modified click (new
 * tab, new window) and a no-script visit follow the link as before. The full
 * screen stays one click away inside the drawer.
 *
 * THE SAME CONVERSATION COMPONENT as the full screen — `CopilotView`, with its
 * plan / confirm / undo ceremony intact. Nothing is executed from here that
 * the full screen would not execute, and nothing without the same confirmation.
 */
export function GlobalCopilot({
  locale,
  children,
  href,
  brand,
  surface,
  subject,
  labels,
  rateMetricKeys = [],
  strings,
}: {
  readonly locale: string;
  /** The top bar's Copilot link, rendered on the server. */
  readonly children: ReactNode;
  /** The full Copilot screen, for this surface. */
  readonly href: string;
  readonly brand: { readonly id: string; readonly name: string } | null;
  readonly surface: string;
  readonly subject: {
    readonly type: 'CAMPAIGN' | 'CONTENT_ITEM' | 'INSIGHT';
    readonly id: string;
    readonly title: string;
  } | null;
  readonly labels: CopilotLabels;
  /** The metrics stored in parts per mille, from the server (Phase 2B-2b). */
  readonly rateMetricKeys?: readonly string[];
  readonly strings: {
    readonly openFull: string;
    readonly more: string;
    readonly chooseBrandTitle: string;
    readonly chooseBrandBody: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  // Focus in, Escape, focus back to the button that opened it (C8).
  const overlayId = useOverlayBehaviour({ open, onClose: close, containerRef: panelRef });
  useDismissOnOutsidePointer(wrapRef, open, close, overlayId);
  /*
   * A NEW CONVERSATION EACH TIME THE DRAWER OPENS on a different subject: the
   * key remounts `CopilotView`, whose session is fixed to what it was opened
   * with. Closing and reopening on the same screen keeps the conversation.
   */
  const [conversation, setConversation] = useState({ key: 0, context: '' });

  const [handedRequest, setHandedRequest] = useState('');
  const openHere = useCallback(
    (request = '') => {
      setHandedRequest(request);
      const context = `${brand?.id ?? ''}|${surface}|${subject?.id ?? ''}|${request}`;
      setConversation((current) =>
        current.context === context ? current : { key: current.key + 1, context },
      );
      setOpen(true);
    },
    [brand?.id, surface, subject?.id],
  );

  const intercept = useCallback(
    (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openHere('');
    },
    [openHere],
  );

  /*
   * D-294 — "Give to Copilot" and "Ask about this Brand" inside a page ask for
   * THIS drawer (`CopilotLink`), rather than navigating away from the screen
   * the question is about.
   */
  useEffect(() => {
    const onRequest = (event: Event) => {
      event.preventDefault();
      const detail = (event as CustomEvent<{ request?: unknown }>).detail;
      openHere(typeof detail?.request === 'string' ? detail.request : '');
    };
    window.addEventListener(OPEN_COPILOT_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_COPILOT_EVENT, onRequest);
  }, [openHere]);

  /*
   * THE PROTOTYPE'S COPILOT PANEL (`Main.dc.html` lines 1493–1525, D-468): a
   * 380px glass card at the bottom inline end, in the floating button's place
   * (the button steps aside while it is open), its head — the spark tile,
   * "Copilot" and where it is attached — then the conversation.
   */
  return (
    <span ref={wrapRef} className="bsp-cp-wrap" data-open={open ? 'true' : undefined}>
      <span
        onClickCapture={intercept}
        data-testid="global-copilot-trigger"
        style={{ display: 'contents' }}
      >
        {children}
      </span>
      {open ? (
        <aside
          ref={panelRef}
          role="dialog"
          aria-label={labels.title}
          data-testid="copilot-drawer"
          tabIndex={-1}
          // MO7: enters from its bottom end corner (340 ms).
          className="bs-copilot-in bsp-cp"
        >
          <div className="bsp-cp-head" data-testid="copilot-header">
            <span className="bsp-cp-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z" />
              </svg>
            </span>
            {/*
              Review of #67 — the prototype's head is the mark, the title and
              the close. The product's line on how the Copilot works and "Open
              the full Copilot", which it does not draw, are under "⋯".
            */}
            <span className="bsp-cp-t">
              <b>{labels.title}</b>
            </span>
            <MoreDisclosure label={strings.more} testId="global-copilot-more" align="end">
              <span className="bsp-cp-note">{labels.subtitle}</span>
              <Link
                href={href}
                className="bsp-btn bsp-sm bsp-ghost bsp-cp-full"
                data-testid="global-copilot-full"
              >
                {strings.openFull}
              </Link>
            </MoreDisclosure>
            <button
              type="button"
              className="bsp-cp-x"
              aria-label={labels.close}
              title={labels.close}
              data-testid="copilot-close"
              onClick={close}
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </div>
          <div className="bsp-cp-body">
            {brand ? (
              <CopilotView
                key={conversation.key}
                locale={locale}
                brand={brand}
                surface={surface}
                subject={subject}
                initialRequest={handedRequest}
                creditsLabel={null}
                labels={labels}
                rateMetricKeys={rateMetricKeys}
              />
            ) : (
              <StateMessage
                kind="empty"
                title={strings.chooseBrandTitle}
                description={strings.chooseBrandBody}
              />
            )}
          </div>
        </aside>
      ) : null}
    </span>
  );
}
