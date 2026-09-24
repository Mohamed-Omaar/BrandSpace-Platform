'use client';

import Link from 'next/link';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';

/**
 * "GIVE TO COPILOT" THAT OPENS THE COPILOT WHERE YOU ARE (Phase 6 final, D-277 §37, D-294).
 *
 * A link to the full Copilot screen, exactly as before — and, with script, a
 * plain click asks the shell's `GlobalCopilot` to open its drawer over the
 * current screen instead. The drawer derives its surface from the route and
 * its brand from the rail, so the conversation carries the same context the
 * link did. A modified click (new tab) and a visit without script follow the
 * link. If no drawer is listening (a screen without the shell), the event is
 * unanswered and the link is followed.
 */
export const OPEN_COPILOT_EVENT = 'brandspace:open-copilot';

export function CopilotLink({
  href,
  children,
  className,
  style,
  testId,
  'data-testid': dataTestId,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly testId?: string;
  readonly 'data-testid'?: string;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    const request = new CustomEvent(OPEN_COPILOT_EVENT, { cancelable: true });
    // The drawer calls preventDefault on the event when it opens.
    if (!window.dispatchEvent(request)) event.preventDefault();
  };
  return (
    <Link
      href={href}
      className={className}
      style={style}
      data-testid={testId ?? dataTestId}
      onClick={onClick}
    >
      {children}
    </Link>
  );
}
