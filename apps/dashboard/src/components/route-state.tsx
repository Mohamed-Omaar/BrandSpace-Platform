import type { ReactNode } from 'react';
import { StateMessage, colorTokens, spacingTokens } from '@brandspace/ui';

/**
 * THE FRAME FOR A WHOLE-SCREEN STATE — a route that failed or does not exist
 * (Phase 6 final, D-277 §51, D-299). The shell is part of each page, so when a
 * page cannot render there is no shell to sit in; this centres the same
 * `StateMessage` every panel uses on the shell's own surface.
 */
export function RouteState({
  kind,
  title,
  description,
  action,
  testId,
  footnote,
}: {
  readonly kind: 'error' | 'forbidden' | 'empty';
  readonly title: string;
  readonly description: string;
  readonly action: ReactNode;
  readonly testId: string;
  readonly footnote?: ReactNode;
}) {
  return (
    <main
      data-testid={testId}
      style={{
        minBlockSize: '100vh',
        display: 'grid',
        placeItems: 'center',
        padding: spacingTokens.lg,
        background: colorTokens.shellSurface,
      }}
    >
      <div
        style={{
          maxInlineSize: '32rem',
          inlineSize: '100%',
          display: 'grid',
          gap: spacingTokens.sm,
        }}
      >
        <StateMessage kind={kind} title={title} description={description} action={action} />
        {footnote}
      </div>
    </main>
  );
}
