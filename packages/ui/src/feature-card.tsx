import type { ReactNode } from 'react';
import { colorTokens, radiusTokens, spacingTokens, typographyTokens } from './tokens';
import { cardStyle } from './surfaces';
import { IconTile } from './primitives';
import { StatusBadge } from './data';
import { LockIcon } from './icons';

/**
 * The Features Hub card.
 *
 * ENTITLEMENT IS THE POINT OF THIS COMPONENT. A feature is not simply present
 * or absent: it can be enabled, switched off by the workspace, locked by the
 * plan the platform assigned, or not built yet. Those four mean different
 * things to the reader and lead to different actions, so they are four distinct
 * states rather than one greyed-out card.
 *
 * WHAT IT REFUSES TO INVENT. There is no plan name, price, quota or allowance
 * anywhere in this component. `lockedReason` is a sentence the CALLER supplies
 * from resolved entitlement data, and `usage` renders only when a real figure
 * exists — the absence of usage renders nothing at all rather than a zero.
 */

export type FeatureState = 'enabled' | 'disabled' | 'locked' | 'coming-soon';

export interface FeatureCardLabels {
  readonly stateLabels: Record<FeatureState, string>;
}

export function FeatureCard({
  name,
  description,
  icon,
  state,
  labels,
  lockedReason,
  usage,
  action,
  testId,
}: {
  readonly name: string;
  readonly description: string;
  readonly icon: ReactNode;
  readonly state: FeatureState;
  readonly labels: FeatureCardLabels;
  /** Why it is locked, in words the caller resolved. Never a guessed plan name. */
  readonly lockedReason?: string | undefined;
  /** A real measured figure, or omitted entirely. Never a placeholder zero. */
  readonly usage?: { readonly label: string; readonly value: string } | undefined;
  /**
   * The primary action, rendered ONLY where the feature genuinely supports one.
   * A card in any state but `enabled` must not offer a button that would fail.
   */
  readonly action?: ReactNode;
  readonly testId?: string | undefined;
}) {
  const available = state === 'enabled';
  const tone =
    state === 'enabled'
      ? 'success'
      : state === 'locked'
        ? 'accent'
        : state === 'coming-soon'
          ? 'info'
          : 'neutral';

  return (
    <article
      data-testid={testId}
      data-feature-state={state}
      className={available ? 'bs-liftable' : undefined}
      style={{
        ...cardStyle({ tone: available ? 'plain' : 'soft' }),
        display: 'flex',
        flexDirection: 'column',
        gap: spacingTokens.sm,
        // An unavailable feature reads as quieter, never as broken: reduced
        // emphasis rather than a disabled-looking box.
        opacity: state === 'coming-soon' ? 0.85 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: spacingTokens.sm }}>
        <IconTile icon={icon} tone={available ? 'brand' : 'neutral'} />
        <div style={{ minInlineSize: 0, flex: 1 }}>
          <h3 style={{ ...typographyTokens.h3, color: colorTokens.textPrimary }}>{name}</h3>
        </div>
        <StatusBadge
          label={labels.stateLabels[state]}
          tone={tone}
          dot
          testId={testId ? `${testId}-state` : undefined}
        />
      </div>

      <p
        style={{
          margin: 0,
          ...typographyTokens.bodySm,
          color: colorTokens.textSecondary,
          flex: 1,
        }}
      >
        {description}
      </p>

      {lockedReason ? (
        <p
          data-testid={testId ? `${testId}-locked-reason` : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            margin: 0,
            paddingInline: spacingTokens.sm,
            paddingBlock: spacingTokens.xs,
            borderRadius: radiusTokens.sm,
            background: colorTokens.brandYellowTint,
            ...typographyTokens.caption,
            color: colorTokens.brandYellowText,
            fontWeight: 600,
          }}
        >
          <LockIcon size={14} />
          {lockedReason}
        </p>
      ) : null}

      {usage ? (
        <p
          data-testid={testId ? `${testId}-usage` : undefined}
          style={{
            margin: 0,
            ...typographyTokens.caption,
            color: colorTokens.textSecondary,
          }}
        >
          {usage.label}: <strong style={{ color: colorTokens.textPrimary }}>{usage.value}</strong>
        </p>
      ) : null}

      {/* An action exists only where the feature can actually be opened. A
          button on a locked card would claim an unsupported action. */}
      {available && action ? (
        <div style={{ marginBlockStart: spacingTokens.xs }}>{action}</div>
      ) : null}
    </article>
  );
}
