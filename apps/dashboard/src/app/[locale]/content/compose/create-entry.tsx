import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Card,
  PencilIcon,
  SparkIcon,
  StateMessage,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
  LayersIcon,
  ListIcon,
} from '@brandspace/ui';
import type { CreateMode } from '../../../../server/create-post';

/**
 * CREATE POST — THE ENTRY (Phase 6 final, D-277 §17, D-283).
 *
 * "What would you like to create?" before any field: generate with AI, write
 * it yourself, start from an idea, or repurpose something that exists. Each is
 * an ADDRESS (`?mode=`), so the choice survives a reload and the context the
 * reader arrived with (a campaign, a brand) travels with it.
 *
 * AN APPROVED DESIGN-SYSTEM EXTENSION: `Card`s in a responsive grid, the icon
 * tiles and button variants the product already uses. Server-rendered.
 */
export function CreateEntry({
  locale,
  t,
  carry,
  planned = null,
}: {
  readonly locale: string;
  readonly t: (key: string) => string;
  /** Query parameters that travel with every choice (campaign, brand, date). */
  readonly carry: Readonly<Record<string, string>>;
  /** G6 (D-329): the ★ day the calendar opened the Studio for, said before the choice. */
  readonly planned?: string | null;
}) {
  const href = (mode: CreateMode) =>
    `/${locale}/content/compose?${new URLSearchParams({ ...carry, mode }).toString()}`;
  const paths: readonly { mode: CreateMode; icon: ReactNode }[] = [
    { mode: 'ai', icon: <SparkIcon size={20} /> },
    { mode: 'write', icon: <PencilIcon size={20} /> },
    { mode: 'idea', icon: <ListIcon size={20} /> },
    { mode: 'repurpose', icon: <LayersIcon size={20} /> },
  ];
  return (
    <section data-testid="create-entry" style={{ display: 'grid', gap: spacingTokens.lg }}>
      <h2 style={{ margin: 0, ...typographyTokens.h2 }}>{t('create.entry.title')}</h2>
      {planned ? (
        <div className="cs-notice info" role="note" data-testid="composer-planned-date">
          <b>{planned}</b>
        </div>
      ) : null}
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gap: spacingTokens.md,
          gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
        }}
      >
        {paths.map((path) => (
          <li key={path.mode}>
            <Link
              href={href(path.mode)}
              data-testid={`create-mode-${path.mode}`}
              className="bs-pressable"
              style={{
                display: 'grid',
                gap: spacingTokens.sm,
                blockSize: '100%',
                padding: spacingTokens.lg,
                borderRadius: radiusTokens['2xl'],
                background: colorTokens.surfaceCardAlpha,
                border: `1px solid ${colorTokens.cardBorder}`,
                color: colorTokens.textPrimary,
                textDecoration: 'none',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: 'inline-grid',
                  placeItems: 'center',
                  inlineSize: '2.5rem',
                  blockSize: '2.5rem',
                  borderRadius: radiusTokens.lg,
                  background: colorTokens.brandPurpleTint,
                  color: colorTokens.brandPurplePressed,
                }}
              >
                {path.icon}
              </span>
              <strong style={typographyTokens.body}>{t(`create.mode.${path.mode}`)}</strong>
              <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
                {t(`create.mode.${path.mode}.body`)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface IdeaOption {
  readonly key: string;
  readonly title: string;
  readonly reason: string;
  /** Where "Use this idea" goes: the AI composer with the idea as the brief. */
  readonly href: string;
}

/** START FROM AN IDEA — grounded ideas only, or an honest empty state. */
export function IdeaPicker({
  locale,
  t,
  ideas,
}: {
  readonly locale: string;
  readonly t: (key: string) => string;
  readonly ideas: readonly IdeaOption[];
}) {
  return (
    <Card title={t('create.idea.title')} description={t('create.idea.body')} testId="create-ideas">
      {ideas.length === 0 ? (
        <StateMessage title={t('create.idea.noneTitle')} description={t('create.idea.noneBody')} />
      ) : (
        <ul style={listStyle}>
          {ideas.map((idea) => (
            <li key={idea.key} data-testid={`create-idea-${idea.key}`} style={rowStyle}>
              <span style={{ display: 'grid', gap: spacingTokens['3xs'], flex: '1 1 14rem' }}>
                <strong dir="auto" style={typographyTokens.bodySm}>
                  {idea.title}
                </strong>
                <span style={captionStyle}>{idea.reason}</span>
              </span>
              <Link
                href={idea.href}
                className={buttonClass('brand')}
                style={buttonStyle('brand', 'sm')}
                data-testid={`create-idea-use-${idea.key}`}
              >
                {t('create.idea.use')}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link
        href={`/${locale}/content/compose`}
        className={buttonClass('ghost')}
        style={{ ...buttonStyle('ghost', 'sm'), marginBlockStart: spacingTokens.sm }}
      >
        {t('create.back')}
      </Link>
    </Card>
  );
}

export interface RepurposeOption {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly contentType: string;
  readonly updatedLabel: string;
}

/** REPURPOSE — pick a real post; its words become the new draft's source. */
export function RepurposePicker({
  locale,
  t,
  options,
  search,
  carry,
}: {
  readonly locale: string;
  readonly t: (key: string) => string;
  readonly options: readonly RepurposeOption[];
  readonly search: string;
  readonly carry: Readonly<Record<string, string>>;
}) {
  const use = (id: string) =>
    `/${locale}/content/compose?${new URLSearchParams({ ...carry, mode: 'ai', source: id }).toString()}`;
  return (
    <Card
      title={t('create.repurpose.title')}
      description={t('create.repurpose.body')}
      testId="create-repurpose"
    >
      <form
        method="get"
        action={`/${locale}/content/compose`}
        style={{
          display: 'flex',
          gap: spacingTokens.xs,
          flexWrap: 'wrap',
          marginBlockEnd: spacingTokens.md,
        }}
      >
        <input type="hidden" name="mode" value="repurpose" />
        {Object.entries(carry).map(([key, value]) => (
          <input key={key} type="hidden" name={key} value={value} />
        ))}
        <label className="bs-sr-only" htmlFor="repurpose-search">
          {t('content.search')}
        </label>
        <input
          id="repurpose-search"
          type="search"
          name="q"
          defaultValue={search}
          placeholder={t('content.search')}
          className="bs-control"
          style={inputStyle({ size: 'sm' })}
        />
        <button
          type="submit"
          className={buttonClass('neutral')}
          style={buttonStyle('neutral', 'sm')}
        >
          {t('content.filter.apply')}
        </button>
      </form>
      {options.length === 0 ? (
        <StateMessage
          title={t('create.repurpose.noneTitle')}
          description={t('create.repurpose.noneBody')}
        />
      ) : (
        <ul style={listStyle}>
          {options.map((option) => (
            <li key={option.id} data-testid={`create-source-${option.id}`} style={rowStyle}>
              <span style={{ display: 'grid', gap: spacingTokens['3xs'], flex: '1 1 14rem' }}>
                <strong dir="auto" style={typographyTokens.bodySm}>
                  {option.title}
                </strong>
                <span style={captionStyle}>
                  {t(`content.type.${option.contentType}`)} · {option.updatedLabel}
                </span>
              </span>
              <StatusBadge
                label={t(`content.status.${option.status}`)}
                tone={statusTone(option.status)}
              />
              <Link
                href={use(option.id)}
                className={buttonClass('brand')}
                style={buttonStyle('brand', 'sm')}
                data-testid={`create-source-use-${option.id}`}
              >
                {t('create.repurpose.use')}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link
        href={`/${locale}/content/compose`}
        className={buttonClass('ghost')}
        style={{ ...buttonStyle('ghost', 'sm'), marginBlockStart: spacingTokens.sm }}
      >
        {t('create.back')}
      </Link>
    </Card>
  );
}

const listStyle = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'grid',
  gap: spacingTokens.sm,
} as const;
const rowStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: spacingTokens.sm,
  alignItems: 'center',
  padding: spacingTokens.sm,
  borderRadius: radiusTokens.lg,
  background: colorTokens.surfaceSoft,
} as const;
const captionStyle = { ...typographyTokens.caption, color: colorTokens.textSecondary } as const;
