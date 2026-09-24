import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  AssetMedia,
  Card,
  LinkTabs,
  NoteIcon,
  PlayIcon,
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
} from '@brandspace/ui';
import { duplicateContentAction, submitForReviewAction } from './actions';

/**
 * THE CONTENT LIBRARY (Phase 6 final, D-277 §15, D-282) — media-first.
 *
 * It replaces the demo port's generic gradient cards, which drew the same
 * abstract art whether or not a post had a picture. Now a card shows the
 * post's REAL first image (an expiring grant, like the Asset Library), a
 * video tile for a video, and — for a text-only post — the caption itself on
 * a neutral surface. Nothing is invented to fill the square.
 *
 * AN APPROVED DESIGN-SYSTEM EXTENSION (CLAUDE.md §4.2): `LinkTabs` for status,
 * a GET form of the ordinary controls for filters (works without script, and
 * the URL is the view), `Card`, `StatusBadge`, `AssetMedia` and the button
 * variants. Server-rendered: every quick action is a link or a server action.
 */

export type LibraryStatus =
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'PARTIALLY_PUBLISHED'
  | 'FAILED'
  | 'ARCHIVED';

export interface LibraryCard {
  readonly id: string;
  readonly title: string;
  readonly status: LibraryStatus;
  readonly contentType: string;
  readonly locale: 'AR' | 'EN';
  readonly platforms: readonly string[];
  readonly campaignName: string | null;
  readonly brandName: string | null;
  readonly updatedLabel: string;
  readonly updatedAt: string;
  readonly openNotes: number;
  readonly ownerName: string | null;
  /** The first image, as a grant URL, or a video/none marker. */
  readonly media:
    | { readonly kind: 'image'; readonly src: string; readonly count: number }
    | { readonly kind: 'video'; readonly count: number }
    | { readonly kind: 'none' };
  /** The caption, for a text-only card. */
  readonly excerpt: string;
}

export interface LibraryIdea {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly action: string;
}

export interface LibraryFilterOption {
  readonly value: string;
  readonly label: string;
}

export function ContentLibrary({
  locale,
  t,
  cards,
  tabs,
  currentStatus,
  filters,
  options,
  view,
  ideas,
  can,
  duplicateToken,
}: {
  readonly locale: string;
  readonly t: (key: string) => string;
  readonly cards: readonly LibraryCard[];
  readonly tabs: readonly { id: string; href: string; label: string; badge: string }[];
  readonly currentStatus: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly options: {
    readonly brands: readonly LibraryFilterOption[];
    readonly campaigns: readonly LibraryFilterOption[];
    readonly platforms: readonly LibraryFilterOption[];
    readonly formats: readonly LibraryFilterOption[];
    readonly languages: readonly LibraryFilterOption[];
  };
  readonly view: 'grid' | 'list';
  readonly ideas: readonly LibraryIdea[];
  readonly can: { readonly create: boolean; readonly submit: boolean };
  /** A per-render key so a double-clicked Duplicate makes one copy. */
  readonly duplicateToken: string;
}) {
  const viewHref = (next: 'grid' | 'list') => {
    const params = new URLSearchParams({ ...filters, view: next });
    return `/${locale}/content?${params.toString()}`;
  };
  const filtered = Object.keys(filters).some((key) => key !== 'view' && key !== 'status');

  const select = (name: string, label: string, list: readonly LibraryFilterOption[]) =>
    list.length === 0 ? null : (
      <label key={name} style={filterLabelStyle}>
        <span style={captionStyle}>{label}</span>
        <select
          name={name}
          defaultValue={filters[name] ?? ''}
          className="bs-control bs-select"
          style={inputStyle({ size: 'sm' })}
          data-testid={`content-${name}`}
        >
          <option value="">{t('content.filter.any')}</option>
          {list.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );

  const actions = (card: LibraryCard): ReactNode => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens['3xs'] }}>
      <Link
        href={`/${locale}/content/compose?item=${card.id}`}
        className={buttonClass('neutral')}
        style={buttonStyle('neutral', 'sm')}
        data-testid={`content-edit-${card.id}`}
      >
        {t(
          card.status === 'PUBLISHED' || card.status === 'ARCHIVED'
            ? 'content.action.open'
            : 'content.action.edit',
        )}
      </Link>
      {can.submit && (card.status === 'DRAFT' || card.status === 'CHANGES_REQUESTED') ? (
        <form action={submitForReviewAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="itemId" value={card.id} />
          <input type="hidden" name="returnTo" value="/content" />
          <button
            type="submit"
            className={buttonClass('ghost')}
            style={buttonStyle('ghost', 'sm')}
            data-testid={`content-request-approval-${card.id}`}
          >
            {t('content.action.requestApproval')}
          </button>
        </form>
      ) : null}
      {card.status === 'APPROVED' || card.status === 'DRAFT' ? (
        <Link
          href={`/${locale}/calendar?item=${card.id}`}
          className={buttonClass('ghost')}
          style={buttonStyle('ghost', 'sm')}
          data-testid={`content-schedule-${card.id}`}
        >
          {t('content.action.schedule')}
        </Link>
      ) : null}
      {can.create ? (
        <form action={duplicateContentAction}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="itemId" value={card.id} />
          <input type="hidden" name="token" value={`${duplicateToken}:${card.id}`} />
          <button
            type="submit"
            className={buttonClass('ghost')}
            style={buttonStyle('ghost', 'sm')}
            data-testid={`content-duplicate-${card.id}`}
          >
            {t('content.action.duplicate')}
          </button>
        </form>
      ) : null}
    </div>
  );

  const meta = (card: LibraryCard) => (
    <span style={captionStyle}>
      {[
        t(`content.type.${card.contentType}`),
        card.platforms.map((platform) => t(`content.platform.${platform}`)).join(', ') || null,
        card.campaignName,
        card.locale === 'AR' ? t('content.language.AR') : t('content.language.EN'),
      ]
        .filter(Boolean)
        .join(' · ')}
    </span>
  );

  const footer = (card: LibraryCard) => (
    <span
      style={{
        ...captionStyle,
        display: 'inline-flex',
        gap: spacingTokens.xs,
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <time dateTime={card.updatedAt}>{card.updatedLabel}</time>
      {card.ownerName ? <span>· {card.ownerName}</span> : null}
      {card.openNotes > 0 ? (
        <span
          style={{ display: 'inline-flex', alignItems: 'center', gap: spacingTokens['3xs'] }}
          data-testid={`content-notes-${card.id}`}
        >
          · <NoteIcon size={12} aria-hidden="true" />
          {t('content.openNotes').replace('{count}', String(card.openNotes))}
        </span>
      ) : null}
    </span>
  );

  const media = (card: LibraryCard) => (
    <Link
      href={`/${locale}/content/compose?item=${card.id}`}
      aria-label={card.title}
      tabIndex={-1}
      style={{
        position: 'relative',
        display: 'block',
        aspectRatio: '1 / 1',
        borderRadius: radiusTokens.lg,
        overflow: 'hidden',
        background: colorTokens.surfaceSoft,
        textDecoration: 'none',
      }}
    >
      {card.media.kind === 'image' ? (
        <AssetMedia src={card.media.src} alt="" />
      ) : card.media.kind === 'video' ? (
        <span style={centeredStyle}>
          <PlayIcon size={32} aria-hidden="true" />
        </span>
      ) : (
        /* A TEXT-ONLY POST SHOWS ITS WORDS, on a neutral surface (§15). */
        <span
          dir="auto"
          data-testid={`content-text-${card.id}`}
          style={{
            position: 'absolute',
            inset: 0,
            padding: spacingTokens.md,
            ...typographyTokens.bodySm,
            color: colorTokens.textSecondary,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 7,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {card.excerpt || card.title}
        </span>
      )}
      {card.media.kind !== 'none' && card.media.count > 1 ? (
        <span style={countChipStyle}>
          {t('content.mediaCount').replace('{count}', String(card.media.count))}
        </span>
      ) : null}
    </Link>
  );

  return (
    <div
      data-testid="content-library"
      data-view={view}
      style={{ display: 'grid', gap: spacingTokens.lg }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: spacingTokens.sm,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <LinkTabs
          label={t('content.title')}
          tabs={tabs}
          currentId={currentStatus}
          testId="content-tabs"
        />
        {can.create ? (
          <Link
            href={`/${locale}/content/compose`}
            className={buttonClass('brand')}
            style={buttonStyle('brand')}
            data-testid="content-create"
          >
            {t('content.create')}
          </Link>
        ) : null}
      </div>

      {ideas.length > 0 ? (
        <Card
          title={t('content.ideas.title')}
          description={t('content.ideas.body')}
          testId="content-ideas"
        >
          <ul
            style={{
              ...listReset,
              display: 'grid',
              gap: spacingTokens.sm,
              gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
            }}
          >
            {ideas.map((idea) => (
              <li
                key={idea.key}
                data-testid={`content-idea-${idea.key}`}
                style={{
                  display: 'grid',
                  gap: spacingTokens.xs,
                  padding: spacingTokens.md,
                  borderRadius: radiusTokens.lg,
                  background: colorTokens.surfaceSoft,
                }}
              >
                <strong style={typographyTokens.bodySm}>{idea.title}</strong>
                <span style={captionStyle}>{idea.body}</span>
                <Link
                  href={idea.href}
                  className={buttonClass('neutral')}
                  style={{ ...buttonStyle('neutral', 'sm'), justifySelf: 'start' }}
                >
                  {idea.action}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <form
        method="get"
        action={`/${locale}/content`}
        data-testid="content-filters"
        style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm, alignItems: 'flex-end' }}
      >
        {filters['status'] ? <input type="hidden" name="status" value={filters['status']} /> : null}
        <input type="hidden" name="view" value={view} />
        <label style={filterLabelStyle}>
          <span style={captionStyle}>{t('content.search')}</span>
          <input
            type="search"
            name="q"
            defaultValue={filters['q'] ?? ''}
            placeholder={t('content.search')}
            className="bs-control"
            style={inputStyle({ size: 'sm' })}
            data-testid="content-search"
          />
        </label>
        {select('brand', t('content.filter.brand'), options.brands)}
        {select('campaign', t('content.filter.campaign'), options.campaigns)}
        {select('platform', t('content.filter.platform'), options.platforms)}
        {select('format', t('content.filter.format'), options.formats)}
        {select('language', t('content.filter.language'), options.languages)}
        <button
          type="submit"
          className={buttonClass('primary')}
          style={buttonStyle('primary', 'sm')}
          data-testid="content-apply"
        >
          {t('content.filter.apply')}
        </button>
        <span style={{ marginInlineStart: 'auto' }}>
          <LinkTabs
            label={t('content.view.label')}
            tabs={[
              { id: 'grid', href: viewHref('grid'), label: t('content.view.grid') },
              { id: 'list', href: viewHref('list'), label: t('content.view.list') },
            ]}
            currentId={view}
            testId="content-view"
          />
        </span>
      </form>

      {cards.length === 0 ? (
        <div data-testid="content-empty">
          <StateMessage
            title={filtered ? t('content.emptyFilteredTitle') : t('content.emptyTitle')}
            description={filtered ? t('content.emptyFilteredBody') : t('content.emptyBody')}
            action={
              !filtered && can.create ? (
                <Link
                  href={`/${locale}/content/compose`}
                  className={buttonClass('brand')}
                  style={buttonStyle('brand', 'sm')}
                  data-testid="content-empty-create"
                >
                  {t('content.emptyAction')}
                </Link>
              ) : undefined
            }
          />
        </div>
      ) : view === 'grid' ? (
        <ul
          style={{
            ...listReset,
            display: 'grid',
            gap: spacingTokens.md,
            gridTemplateColumns: 'repeat(auto-fill, minmax(15rem, 1fr))',
          }}
        >
          {cards.map((card) => (
            <li key={card.id} data-testid="content-card" data-item-id={card.id} style={cardStyle}>
              {media(card)}
              <div style={{ display: 'grid', gap: spacingTokens['3xs'] }}>
                <div
                  style={{
                    display: 'flex',
                    gap: spacingTokens.xs,
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                  }}
                >
                  <Link
                    href={`/${locale}/content/compose?item=${card.id}`}
                    dir="auto"
                    style={titleStyle}
                  >
                    {card.title}
                  </Link>
                  <StatusBadge
                    label={t(`content.status.${card.status}`)}
                    tone={statusTone(card.status)}
                  />
                </div>
                {meta(card)}
                {footer(card)}
              </div>
              {actions(card)}
            </li>
          ))}
        </ul>
      ) : (
        <ul style={{ ...listReset, display: 'grid', gap: spacingTokens.xs }}>
          {cards.map((card) => (
            <li
              key={card.id}
              data-testid="content-card"
              data-item-id={card.id}
              style={{
                ...cardStyle,
                gridTemplateColumns: '4rem minmax(0, 1fr)',
                alignItems: 'center',
              }}
            >
              <div style={{ inlineSize: '4rem' }}>{media(card)}</div>
              <div style={{ display: 'grid', gap: spacingTokens['3xs'], minInlineSize: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    gap: spacingTokens.xs,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <Link
                    href={`/${locale}/content/compose?item=${card.id}`}
                    dir="auto"
                    style={titleStyle}
                  >
                    {card.title}
                  </Link>
                  <StatusBadge
                    label={t(`content.status.${card.status}`)}
                    tone={statusTone(card.status)}
                  />
                </div>
                {meta(card)}
                {footer(card)}
                {actions(card)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const listReset = { listStyle: 'none', margin: 0, padding: 0 } as const;
const captionStyle = { ...typographyTokens.caption, color: colorTokens.textSecondary } as const;
const filterLabelStyle = { display: 'grid', gap: spacingTokens['3xs'] } as const;
const titleStyle = {
  ...typographyTokens.bodySm,
  fontWeight: 700,
  color: colorTokens.textPrimary,
  textDecoration: 'none',
  minInlineSize: 0,
  overflowWrap: 'anywhere',
} as const;
const cardStyle = {
  display: 'grid',
  gap: spacingTokens.sm,
  padding: spacingTokens.sm,
  borderRadius: radiusTokens['2xl'],
  background: colorTokens.surfaceCardAlpha,
  border: `1px solid ${colorTokens.cardBorder}`,
} as const;
const centeredStyle = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  color: colorTokens.textSecondary,
} as const;
const countChipStyle = {
  position: 'absolute',
  insetBlockStart: spacingTokens.xs,
  insetInlineEnd: spacingTokens.xs,
  paddingInline: spacingTokens.xs,
  borderRadius: radiusTokens.full,
  background: colorTokens.ink,
  color: colorTokens.inkInk,
  ...typographyTokens.caption,
} as const;
