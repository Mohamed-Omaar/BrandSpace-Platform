import Link from 'next/link';
import {
  Card,
  StateMessage,
  StatusBadge,
  buttonClass,
  colorTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
} from '@brandspace/ui';

/**
 * CREATE POST — THE TWO PICKERS BEHIND THE STUDIO'S "OR START FROM" CHIPS
 * (Phase 6 final, D-277 §17, D-283; review of #67). The prototype's "New post"
 * opens the Studio directly, so the old "What would you like to create?" step
 * is gone; starting from an idea and repurposing a post are its chips, and each
 * opens one of these, as an address (`?mode=`).
 *
 * AN APPROVED DESIGN-SYSTEM EXTENSION: `Card`s in a responsive grid, the icon
 * tiles and button variants the product already uses. Server-rendered.
 */
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
              <span
                style={{
                  display: 'grid',
                  gap: spacingTokens['3xs'],
                  flex: '1 1 var(--bsp-rem-14)',
                }}
              >
                <strong dir="auto" style={typographyTokens.bodySm}>
                  {idea.title}
                </strong>
                <span style={captionStyle}>{idea.reason}</span>
              </span>
              <Link
                href={idea.href}
                className={buttonClass('brand', 'sm')}

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
        className={buttonClass('ghost', 'sm')}
        style={{ marginBlockStart: spacingTokens.sm }}
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
        <button type="submit" className={buttonClass('neutral', 'sm')}>
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
              <span
                style={{
                  display: 'grid',
                  gap: spacingTokens['3xs'],
                  flex: '1 1 var(--bsp-rem-14)',
                }}
              >
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
                className={buttonClass('brand', 'sm')}

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
        className={buttonClass('ghost', 'sm')}
        style={{ marginBlockStart: spacingTokens.sm }}
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
