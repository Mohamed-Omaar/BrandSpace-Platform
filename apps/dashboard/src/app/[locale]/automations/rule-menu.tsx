'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * THE ROW'S ⋯ MENU (D-468): a native disclosure, so it opens without script
 * and from the keyboard as it is. With script it also behaves like the
 * prototype's menu: it closes when one of its links is followed, on a press
 * outside it and on Escape — and so it never comes back open after Edit.
 */
export function RuleMenu({
  label,
  testId,
  children,
}: {
  readonly label: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const menu = ref.current;
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        menu.open = false;
        menu.querySelector('summary')?.focus();
        return;
      }
      if (!menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details
      ref={ref}
      className="bsp-au-more"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a') && ref.current) ref.current.open = false;
      }}
    >
      <summary className="bsp-ibtn bsp-au-dots" aria-label={label} data-testid={testId}>
        ⋯
      </summary>
      {children}
    </details>
  );
}
