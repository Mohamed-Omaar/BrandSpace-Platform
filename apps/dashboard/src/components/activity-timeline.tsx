import { colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import type { TimelineEntry } from '../server/activity-timeline';

/**
 * A CONTEXTUAL MINI-TIMELINE (D-298): the event in words, then who and how
 * long ago, with the exact moment on the `time` element. The campaign room's
 * list, shared rather than copied.
 */
export function ActivityTimeline({
  entries,
  testId,
}: {
  readonly entries: readonly TimelineEntry[];
  readonly testId?: string | undefined;
}) {
  return (
    <ol
      data-testid={testId}
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'grid',
        gap: spacingTokens.sm,
      }}
    >
      {entries.map((entry) => (
        <li
          key={entry.id}
          data-testid={testId ? `${testId}-entry` : undefined}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.sm,
            alignItems: 'center',
          }}
        >
          <strong style={{ ...typographyTokens.bodySm, flex: '1 1 14rem' }}>{entry.label}</strong>
          <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
            {entry.actor} ·{' '}
            <time dateTime={entry.at.toISOString()} title={entry.at.toISOString()}>
              {entry.when}
            </time>
          </span>
        </li>
      ))}
    </ol>
  );
}
