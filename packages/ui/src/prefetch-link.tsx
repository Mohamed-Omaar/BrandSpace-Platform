'use client';

import Link, { useLinkStatus } from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, type ComponentProps } from 'react';

/**
 * ROUND 5 (E) — A LINK THAT IS FETCHED WHILE THE HAND IS ON IT, AND SHOWS
 * THE PRESS AT ONCE.
 *
 * Every customer page is dynamic and has no `loading.js`, so `<Link>`'s own
 * viewport prefetch carries nothing a click can use: the click waited a full
 * round trip with nothing moving. Here hovering or focusing the link asks for
 * the whole page (`router.prefetch`), so the click often finds it already on
 * its way or in hand; and until the page arrives the link carries
 * `data-pending`, which the design system draws as a press.
 *
 * Only for links to pages that just read (the rail, the Create menu, "New
 * post"): a prefetch renders the page without anyone opening it.
 */
/**
 * `PrefetchKind.FULL`: the whole page, not the part above a `loading.js` the
 * routes do not have. The enum lives in Next's internals; its value is public.
 */
type PrefetchKind = NonNullable<Parameters<ReturnType<typeof useRouter>['prefetch']>[1]>['kind'];
const FULL = 'full' as PrefetchKind;

export function usePrefetchOnIntent(href: string): {
  readonly onPointerEnter: () => void;
  readonly onFocus: () => void;
} {
  const router = useRouter();
  const asked = useRef<string | null>(null);
  const ask = () => {
    if (asked.current === href) return;
    asked.current = href;
    router.prefetch(href, {
      kind: FULL,
      // When the copy goes stale, the next hover asks again.
      onInvalidate: () => {
        asked.current = null;
      },
    });
  };
  return { onPointerEnter: ask, onFocus: ask };
}

/** Marks the enclosing link `data-pending` while its navigation is under way. */
export function LinkPendingMark() {
  const { pending } = useLinkStatus();
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const link = ref.current?.closest('a');
    if (!link) return undefined;
    link.toggleAttribute('data-pending', pending);
    if (pending) link.setAttribute('aria-busy', 'true');
    else link.removeAttribute('aria-busy');
    return () => {
      link.removeAttribute('data-pending');
      link.removeAttribute('aria-busy');
    };
  }, [pending]);
  return <span ref={ref} style={{ display: 'none' }} />;
}

/** `<Link>` with the prefetch on intent and the pending press. */
export function PrefetchLink({
  href,
  children,
  onPointerEnter,
  onFocus,
  ...rest
}: Omit<ComponentProps<typeof Link>, 'href'> & { readonly href: string }) {
  const intent = usePrefetchOnIntent(href);
  return (
    <Link
      href={href}
      {...rest}
      onPointerEnter={(event) => {
        intent.onPointerEnter();
        onPointerEnter?.(event);
      }}
      onFocus={(event) => {
        intent.onFocus();
        onFocus?.(event);
      }}
    >
      {children}
      <LinkPendingMark />
    </Link>
  );
}
