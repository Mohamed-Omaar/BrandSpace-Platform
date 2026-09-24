import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  Banner,
  Card,
  SectionHeader,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  type BadgeTone,
} from '@brandspace/ui';
import { fill, simpleCopy, type SimpleKey } from '../i18n/simple';
import type { AreaState, ReadinessArea } from '../server/owner-readiness';

/**
 * SIMPLE-MODE BUILDING BLOCKS — composed, not invented (CLAUDE.md §4.2 rule 4).
 *
 * Every piece here is an existing design-system component (`Card`,
 * `StatusBadge`, `Banner`, the button styles) arranged for the owner's
 * screens. No new colour, shadow, font or interaction model: Simple mode is
 * the same Control Center written for a different reader.
 */

const STATE_TONE: Record<AreaState, BadgeTone> = {
  ready: 'success',
  test_double: 'info',
  needs_attention: 'warning',
  setup_required: 'neutral',
  disabled: 'neutral',
  withheld: 'neutral',
};

export function stateLabel(locale: string, state: AreaState, plans = false): string {
  const copy = simpleCopy(locale);
  if (state === 'ready') return copy(plans ? 'state.readyPlans' : 'state.ready');
  return copy(`state.${state}` as SimpleKey);
}

export function reasonText(locale: string, area: Pick<ReadinessArea, 'reason' | 'key'>): string {
  const copy = simpleCopy(locale);
  if (area.reason === 'ok') return copy(area.key === 'plans' ? 'reason.okPlans' : 'reason.ok');
  return copy(`reason.${area.reason}` as SimpleKey);
}

export function AreaBadge({
  locale,
  state,
  plans = false,
  testId,
}: {
  readonly locale: string;
  readonly state: AreaState;
  readonly plans?: boolean;
  readonly testId?: string;
}) {
  return (
    <StatusBadge
      label={stateLabel(locale, state, plans)}
      tone={STATE_TONE[state]}
      dot
      testId={testId}
    />
  );
}

/** A link that looks like a button — the console's existing idiom. */
export function ActionLink({
  href,
  children,
  variant = 'neutral',
  testId,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly variant?: 'primary' | 'neutral' | 'ghost' | 'brand';
  readonly testId?: string;
}) {
  return (
    <Link
      href={href}
      className={buttonClass(variant)}
      style={{ ...buttonStyle(variant, 'sm'), textDecoration: 'none' }}
      data-testid={testId}
    >
      {children}
    </Link>
  );
}

/** One readiness area as a card: what it is for, its state, why, and where to fix it. */
export function ReadinessCard({
  locale,
  area,
}: {
  readonly locale: string;
  readonly area: ReadinessArea;
}) {
  const copy = simpleCopy(locale);
  const provider = area.provider ? (locale === 'ar' ? area.provider.ar : area.provider.en) : null;
  const action =
    area.state === 'withheld'
      ? null
      : area.state === 'ready' || area.state === 'test_double'
        ? copy('common.manage')
        : copy('common.setUp');
  return (
    <Card testId={`readiness-${area.key}`}>
      <div style={{ display: 'grid', gap: spacingTokens.xs }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: spacingTokens.xs,
          }}
        >
          <h3 style={{ margin: 0, ...typographyTokens.h3 }}>
            {copy(`area.${area.key}` as SimpleKey)}
          </h3>
          <AreaBadge
            locale={locale}
            state={area.state}
            plans={area.key === 'plans'}
            testId={`readiness-${area.key}-state`}
          />
        </div>
        <p style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textMuted }}>
          {area.required ? copy('common.required') : copy('common.optional')}
          {' · '}
          {copy(`area.${area.key}.about` as SimpleKey)}
        </p>
        {provider ? (
          <p style={{ margin: 0, ...typographyTokens.bodySm, fontWeight: 600 }}>{provider}</p>
        ) : null}
        <p style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
          {reasonText(locale, area)}
        </p>
        {action ? (
          <div>
            <ActionLink
              href={`/${locale}/console${area.href}`}
              variant={area.state === 'ready' ? 'ghost' : 'neutral'}
              testId={`readiness-${area.key}-action`}
            >
              {action}
            </ActionLink>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export interface AttentionItem {
  readonly id: string;
  readonly severity: 'critical' | 'warning' | 'info';
  readonly title: string;
  readonly detail: string;
  /** Full path including locale. */
  readonly href: string;
  readonly actionLabel: string;
}

const SEVERITY_TONE: Record<AttentionItem['severity'], BadgeTone> = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
};

/** "What needs your attention" — each item names the place that resolves it. */
export function AttentionList({
  locale,
  items,
}: {
  readonly locale: string;
  readonly items: readonly AttentionItem[];
}) {
  const copy = simpleCopy(locale);
  if (items.length === 0) {
    return (
      <p
        data-testid="attention-none"
        style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
      >
        {copy('home.attentionNone')}
      </p>
    );
  }
  const severityWord: Record<AttentionItem['severity'], string> = {
    critical: copy('severity.critical'),
    warning: copy('severity.warning'),
    info: copy('severity.info'),
  };
  return (
    <ul
      data-testid="attention-list"
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: spacingTokens.sm }}
    >
      {items.map((item) => (
        <li
          key={item.id}
          data-testid={`attention-${item.id}`}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: spacingTokens.sm,
            padding: spacingTokens.md,
            borderRadius: radiusTokens.rail,
            background: colorTokens.surface,
            border: `1px solid ${colorTokens.hairline}`,
          }}
        >
          <StatusBadge label={severityWord[item.severity]} tone={SEVERITY_TONE[item.severity]} />
          <div style={{ flex: '1 1 16rem', display: 'grid', gap: '2px' }}>
            <strong style={{ ...typographyTokens.bodySm, fontWeight: 700 }}>{item.title}</strong>
            <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {item.detail}
            </span>
          </div>
          <ActionLink href={item.href} testId={`attention-${item.id}-action`}>
            {item.actionLabel}
          </ActionLink>
        </li>
      ))}
    </ul>
  );
}

/**
 * The outcome of the action that brought the reader here, from the redirect's
 * `ok` / `error` / `ref` parameters. Codes only — nothing user-typed is ever
 * reflected from a URL.
 */
export function ActionOutcome({
  locale,
  ok,
  error,
  reference,
  okText,
  errorText,
}: {
  readonly locale: string;
  readonly ok: string | null;
  readonly error: string | null;
  readonly reference?: string | null;
  readonly okText?: (code: string) => string | null;
  readonly errorText?: (code: string) => string | null;
}) {
  const copy = simpleCopy(locale);
  if (error) {
    const specific = errorText?.(error) ?? null;
    return (
      <Banner tone="error" testId="simple-error">
        {specific ??
          (reference
            ? fill(copy('common.failed'), { ref: reference })
            : copy('common.failedNoRef'))}
      </Banner>
    );
  }
  if (ok) {
    return (
      <Banner tone="success" testId="simple-ok">
        {okText?.(ok) ?? copy('common.done')}
      </Banner>
    );
  }
  return null;
}

/** A titled block of a Simple screen. */
export function SimpleSection({
  title,
  description,
  actions,
  children,
  testId,
}: {
  readonly title: string;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <section data-testid={testId}>
      <SectionHeader title={title} description={description} actions={actions} />
      {children}
    </section>
  );
}

/** A plain query-string reader for the three flash parameters. */
export function flash(query: Record<string, string | string[] | undefined>): {
  ok: string | null;
  error: string | null;
  ref: string | null;
} {
  const one = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : null);
  return { ok: one('ok'), error: one('error'), ref: one('ref') };
}
