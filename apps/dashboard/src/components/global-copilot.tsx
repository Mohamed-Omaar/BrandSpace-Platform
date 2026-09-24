'use client';

import { useCallback, useState, type MouseEvent, type ReactNode } from 'react';
import {
  CopilotDrawer,
  StateMessage,
  buttonClass,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
  type CopilotLabels,
} from '@brandspace/ui';
import Link from 'next/link';
import { CopilotView } from '../app/[locale]/copilot/copilot-view';

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
  readonly strings: {
    readonly openFull: string;
    readonly chooseBrandTitle: string;
    readonly chooseBrandBody: string;
  };
}) {
  const [open, setOpen] = useState(false);
  /*
   * A NEW CONVERSATION EACH TIME THE DRAWER OPENS on a different subject: the
   * key remounts `CopilotView`, whose session is fixed to what it was opened
   * with. Closing and reopening on the same screen keeps the conversation.
   */
  const [conversation, setConversation] = useState({ key: 0, context: '' });

  const intercept = useCallback(
    (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const context = `${brand?.id ?? ''}|${surface}|${subject?.id ?? ''}`;
      setConversation((current) =>
        current.context === context ? current : { key: current.key + 1, context },
      );
      setOpen(true);
    },
    [brand?.id, surface, subject?.id],
  );

  return (
    <>
      <span
        onClickCapture={intercept}
        data-testid="global-copilot-trigger"
        style={{ display: 'contents' }}
      >
        {children}
      </span>
      <CopilotDrawer open={open} onClose={() => setOpen(false)} labels={labels}>
        <div style={{ display: 'grid', gap: spacingTokens.md }}>
          <Link
            href={href}
            data-testid="global-copilot-full"
            className={buttonClass('ghost')}
            style={{
              ...buttonStyle('ghost', 'sm'),
              justifySelf: 'start',
              color: colorTokens.textSecondary,
            }}
          >
            {strings.openFull}
          </Link>
          {brand ? (
            <CopilotView
              key={conversation.key}
              locale={locale}
              brand={brand}
              surface={surface}
              subject={subject}
              creditsLabel={null}
              labels={labels}
            />
          ) : (
            <div style={{ ...typographyTokens.bodySm }}>
              <StateMessage
                kind="empty"
                title={strings.chooseBrandTitle}
                description={strings.chooseBrandBody}
              />
            </div>
          )}
        </div>
      </CopilotDrawer>
    </>
  );
}
