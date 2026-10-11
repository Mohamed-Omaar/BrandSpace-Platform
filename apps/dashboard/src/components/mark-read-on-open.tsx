'use client';

import { useEffect, useRef, useTransition } from 'react';

/**
 * PR D (Notes 5) — OPENING A THREAD MARKS ITS MENTIONS READ, as the prototype
 * does when a thread is selected. Still an act, not a side effect of a page
 * render: the reader pressed the thread, and this sends the existing
 * "mark read" action once, from the browser, for that thread only. A page
 * loaded without that press (a reload of the inbox) shows no open thread.
 */
export function MarkReadOnOpen({
  action,
  locale,
  threadId,
  returnPath,
}: {
  readonly action: (formData: FormData) => Promise<void>;
  readonly locale: string;
  readonly threadId: string;
  readonly returnPath: string;
}) {
  const sent = useRef<string | null>(null);
  const [, startTransition] = useTransition();
  useEffect(() => {
    if (sent.current === threadId) return;
    sent.current = threadId;
    const data = new FormData();
    data.set('locale', locale);
    data.set('threadId', threadId);
    data.set('returnPath', returnPath);
    startTransition(() => {
      void action(data);
    });
  }, [action, locale, threadId, returnPath]);
  return null;
}
