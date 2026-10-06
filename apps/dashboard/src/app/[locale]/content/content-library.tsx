import Link from 'next/link';
import type { ReactNode } from 'react';
import { AssetMedia, NoteIcon, PlayIcon, SegmentPill, colorTokens } from '@brandspace/ui';
import {
  duplicateContentAction,
  setContentCampaignAction,
  submitForReviewAction,
  transitionItemAction,
} from './actions';
import { cancelScheduleAction, rescheduleContentAction } from '../calendar/actions';
import { PostMenu } from './post-menu';
import { ChannelMark } from '../calendar/prototype-calendar';
import { FiltersDisclosure } from '../../../components/filters-disclosure';

/**
 * THE CONTENT LIBRARY — PORTED FROM `prototype-2026-09-27` (D-468 batch 2):
 * "Posts", `Main.dc.html` lines 538–566, its stylesheet §3-POSTS of
 * `@brandspace/ui/prototype.css`. The status tabs with their counts, the
 * channel chips and "+ New post", "From your strategy", the four-across grid
 * of cards (picture, title and status, meta, campaign, the one button and the
 * "…" menu) and the empty card.
 *
 * THE CARD IS THE PROTOTYPE'S: the square cover (the post's REAL first image,
 * an expiring grant; a video tile for a video), the title and status pill, ONE
 * meta line — the channels and when it goes out — the campaign chip, the one
 * button and "…". A text-only post keeps its words (D-306) in the cover's own
 * overlay, on the prototype's purple picture; nothing is invented.
 *
 * THE PRODUCT'S OTHER CONTROLS ARE KEPT, BEHIND "FILTERS" (review of #67): the
 * search, brand, campaign, format, language, an exact status and the grid /
 * list switch float in a panel over the screen, so the head row is the
 * prototype's — the tabs, the channel chips and "+ New post". The list view
 * keeps the product's long meta line (format, language, who, notes).
 *
 * Server-rendered: every quick action is a link or a server action.
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
  /** Gate 2b — the cover headline (`c.overlay`): the first picture's slide headline, if any. */
  readonly headline?: string | null;
  /** B8 — what the Posts menu needs: the brand, the campaign, the live plan, the links. */
  readonly brandId?: string;
  readonly campaignId?: string | null;
  readonly slot?: { readonly id: string; readonly date: string; readonly time: string } | null;
  readonly links?: readonly { readonly label: string; readonly url: string }[];
  /** The prototype's "Oct 16 · 10:00", "Today · 18:00" or "No date". */
  readonly when?: string;
}

/** B8 — the Posts menu's permissions, options and words, for every card. */
export interface LibraryMenu {
  readonly can: {
    readonly schedule: boolean;
    readonly archive: boolean;
    readonly attachCampaign: boolean;
    readonly changeCampaign: boolean;
  };
  /** Each brand's campaigns the reader may file a post under. */
  readonly campaignsByBrand: Readonly<Record<string, readonly { id: string; name: string }[]>>;
  readonly today: string;
  readonly labels: Readonly<Record<string, string>>;
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
  paging,
  menu,
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
    /** The chips: the connected channels (and a platform filtered on). */
    readonly channels?: readonly LibraryFilterOption[];
    /** Every exact status, for the Filters panel. */
    readonly statuses?: readonly LibraryFilterOption[];
  };
  readonly view: 'grid' | 'list';
  readonly ideas: readonly LibraryIdea[];
  readonly can: {
    readonly create: boolean;
    /** Q12 — may change a post's words (`content.edit`); otherwise it is opened, not edited. */
    readonly edit: boolean;
    readonly submit: boolean;
    /** B-6 — may put a post on the calendar (`content.schedule`). */
    readonly schedule: boolean;
    /** D-468 — the card's Review goes to the approval queue (`content.approve`). */
    readonly approve?: boolean;
    /** D-468 — the card's Results goes to Performance (its page permission). */
    readonly results?: boolean;
    /** D-468 — the card's Retry goes to the Publishing log (its page permission). */
    readonly retry?: boolean;
  };
  /** A per-render key so a double-clicked Duplicate makes one copy. */
  readonly duplicateToken: string;
  /** D-305 — which page of the library this is, and whether another follows. */
  readonly paging?: { readonly page: number; readonly hasMore: boolean } | undefined;
  readonly menu?: LibraryMenu | undefined;
}) {
  const pageHref = (page: number) => {
    const params = new URLSearchParams({ ...filters, ...(page > 1 ? { page: String(page) } : {}) });
    const search = params.toString();
    return `/${locale}/content${search ? `?${search}` : ''}`;
  };
  const viewHref = (next: 'grid' | 'list') => {
    const params = new URLSearchParams({ ...filters, view: next });
    return `/${locale}/content?${params.toString()}`;
  };
  const platformHref = (key: string) => {
    const params = new URLSearchParams(filters);
    if (filters['platform'] === key) params.delete('platform');
    else params.set('platform', key);
    const search = params.toString();
    return `/${locale}/content${search ? `?${search}` : ''}`;
  };
  const filtered = Object.keys(filters).some(
    (key) => key !== 'view' && key !== 'status' && key !== 'tab',
  );
  // What the Filters chip counts: everything the head row does not show.
  const activeFilters = ['q', 'brand', 'campaign', 'format', 'language', 'status'].filter(
    (key) => filters[key] !== undefined,
  ).length;
  const studio = (card: LibraryCard) => `/${locale}/content/compose?item=${card.id}`;
  const openLabel = (card: LibraryCard) =>
    t(
      // A member who may not edit (the Viewer, Q12) OPENS a post — the Studio
      // shows it read-only — so the card never offers an edit it would refuse.
      !can.edit || card.status === 'PUBLISHED' || card.status === 'ARCHIVED'
        ? 'content.action.open'
        : 'content.action.edit',
    );

  const select = (name: string, label: string, list: readonly LibraryFilterOption[]) =>
    list.length === 0 ? null : (
      <label key={name} className="bsp-fdis-field">
        <span className="bsp-fdis-label">{label}</span>
        <select
          name={name}
          defaultValue={filters[name] ?? ''}
          className="bs-control bsp-fdis-control"
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

  /*
   * THE CARD'S ONE BUTTON, as the prototype's `kinds` give it: Continue a
   * draft, Review one waiting, Edit a scheduled one, Results for a published
   * one, Retry a failed one, Restore an archived one — each only for a member
   * the destination would let in; otherwise the post is opened.
   */
  const primary = (card: LibraryCard): ReactNode => {
    const link = (href: string, label: string, dark: boolean, testId: string) => (
      <Link
        href={href}
        className={`bsp-btn bsp-sm${dark ? '' : ' bsp-sec'} bsp-post-primary`}
        data-testid={testId}
      >
        {label}
      </Link>
    );
    const open = () => link(studio(card), openLabel(card), false, `content-edit-${card.id}`);
    switch (card.status) {
      case 'DRAFT':
      case 'CHANGES_REQUESTED':
        return can.edit
          ? link(studio(card), t('content.p.continue'), false, `content-edit-${card.id}`)
          : open();
      case 'IN_REVIEW':
        return can.approve
          ? link(`/${locale}/approvals`, t('content.p.review'), true, `content-review-${card.id}`)
          : open();
      case 'APPROVED':
        return can.schedule
          ? link(
              `/${locale}/calendar?item=${card.id}`,
              t('content.action.schedule'),
              true,
              `content-primary-schedule-${card.id}`,
            )
          : open();
      case 'PUBLISHED':
      case 'PARTIALLY_PUBLISHED':
        return can.results
          ? link(
              `/${locale}/analytics`,
              t('content.p.results'),
              false,
              `content-results-${card.id}`,
            )
          : open();
      case 'FAILED':
        return can.retry
          ? link(`/${locale}/publishing`, t('content.p.retry'), true, `content-retry-${card.id}`)
          : open();
      case 'ARCHIVED':
        return menu?.can.archive ? (
          <form action={transitionItemAction} style={{ display: 'contents' }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="returnTo" value="/content" />
            <input type="hidden" name="itemId" value={card.id} />
            <input type="hidden" name="to" value="DRAFT" />
            <button
              type="submit"
              className="bsp-btn bsp-sm bsp-sec bsp-post-primary"
              data-testid={`content-restore-${card.id}`}
            >
              {t('content.menu.restore')}
            </button>
          </form>
        ) : (
          open()
        );
      default:
        return open();
    }
  };

  const more = (card: LibraryCard): ReactNode =>
    menu ? (
      <PostMenu
        locale={locale}
        itemId={card.id}
        status={card.status}
        campaignId={card.campaignId ?? null}
        campaigns={card.brandId ? (menu.campaignsByBrand[card.brandId] ?? []) : []}
        slot={card.slot ?? null}
        links={card.links ?? []}
        today={menu.today}
        open={{ href: studio(card), label: openLabel(card) }}
        duplicateToken={can.create ? duplicateToken : null}
        can={{ ...menu.can, submit: can.submit }}
        labels={menu.labels}
        actions={{
          reschedule: rescheduleContentAction,
          cancel: cancelScheduleAction,
          transition: transitionItemAction,
          setCampaign: setContentCampaignAction,
          duplicate: duplicateContentAction,
          submit: submitForReviewAction,
        }}
      />
    ) : null;

  /* THE PROTOTYPE'S META LINE: the channels, then when it goes out. */
  const meta = (card: LibraryCard) => (
    <span className="bsp-post-meta">
      {[...card.platforms.map((platform) => t(`content.platform.${platform}`)), card.when ?? null]
        .filter(Boolean)
        .join(' · ')}
      {card.openNotes > 0 ? (
        <span className="bs-visually-hidden" data-testid={`content-notes-${card.id}`}>
          {' · '}
          {t('content.openNotes').replace('{count}', String(card.openNotes))}
        </span>
      ) : null}
    </span>
  );

  /* The list view's long line: format, channels, language, when, who, notes. */
  const fullMeta = (card: LibraryCard) => (
    <span className="bsp-post-meta">
      {[
        t(`content.type.${card.contentType}`),
        card.platforms.map((platform) => t(`content.platform.${platform}`)).join(', ') || null,
        card.locale === 'AR' ? t('content.language.AR') : t('content.language.EN'),
      ]
        .filter(Boolean)
        .join(' · ')}
      {' · '}
      <time dateTime={card.updatedAt}>{card.updatedLabel}</time>
      {card.ownerName ? <span> · {card.ownerName}</span> : null}
      {card.openNotes > 0 ? (
        <span data-testid={`content-notes-${card.id}`}>
          {' · '}
          <NoteIcon size={12} aria-hidden="true" />{' '}
          {t('content.openNotes').replace('{count}', String(card.openNotes))}
        </span>
      ) : null}
    </span>
  );

  const campaignChip = (card: LibraryCard) =>
    card.campaignName ? (
      <span className="bsp-post-camp">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M5 21V4 M5 5h11.5l-1.75 3.5L16.5 12H5" />
        </svg>
        {card.campaignName}
      </span>
    ) : null;

  const media = (card: LibraryCard, compact = false) =>
    card.media.kind === 'image' ? (
      <>
        <AssetMedia src={card.media.src} alt="" />
        {card.headline && !compact ? (
          <span dir="auto" className="bsp-post-overlay" data-testid={`content-headline-${card.id}`}>
            {card.headline}
          </span>
        ) : null}
      </>
    ) : card.media.kind === 'video' ? (
      <span style={centeredStyle}>
        <PlayIcon size={compact ? 20 : 32} aria-hidden="true" />
      </span>
    ) : (
      /* A TEXT-ONLY POST IS A DESIGNED CARD, NOT A MISSING IMAGE (D-306 §23):
         the prototype's purple picture, and the post's own words where the
         prototype puts a design's headline (`c.overlay`). The compact list
         tile keeps only the glyph. */
      <span
        data-testid={`content-text-${card.id}`}
        data-text-only="true"
        className="bsp-post-textart"
      >
        {compact ? (
          <NoteIcon size={20} aria-hidden="true" />
        ) : (
          <span dir="auto" className="bsp-post-overlay">
            {card.excerpt || card.title}
          </span>
        )}
      </span>
    );

  /*
   * Review of #67, round 3 — the prototype's cover carries no media count, so
   * the count is not drawn on the picture; it stays in the cover link's
   * accessible name ("Weekend brunch · 3 media").
   */
  const coverLabel = (card: LibraryCard) =>
    card.media.kind !== 'none' && card.media.count > 1
      ? `${card.title} · ${t('content.mediaCount').replace('{count}', String(card.media.count))}`
      : card.title;

  return (
    <div data-testid="content-library" data-view={view} className="bsp-posts">
      <div className="bsp-posts-head">
        <nav className="bsp-seg" aria-label={t('content.title')} data-testid="content-tabs">
          <SegmentPill selector='[aria-current="page"]' />
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={tab.id === currentStatus ? 'page' : undefined}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}{' '}
              <span
                className="bsp-posts-count bsp-ltr"
                data-bad={tab.id === 'FAILED' && tab.badge !== '0' ? '' : undefined}
              >
                {tab.badge}
              </span>
            </Link>
          ))}
        </nav>
        <div className="bsp-posts-right">
          <FiltersDisclosure
            label={t('content.p.filters')}
            active={activeFilters}
            testId="content-filters-toggle"
          >
            <form
              method="get"
              action={`/${locale}/content`}
              data-testid="content-filters"
              className="bsp-fdis-form"
            >
              {filters['tab'] ? <input type="hidden" name="tab" value={filters['tab']} /> : null}
              {filters['platform'] ? (
                <input type="hidden" name="platform" value={filters['platform']} />
              ) : null}
              <input type="hidden" name="view" value={view} />
              <label className="bsp-fdis-field">
                <span className="bsp-fdis-label">{t('content.search')}</span>
                <input
                  type="search"
                  name="q"
                  defaultValue={filters['q'] ?? ''}
                  placeholder={t('content.search')}
                  className="bs-control bsp-fdis-control"
                  data-testid="content-search"
                />
              </label>
              {select('brand', t('content.filter.brand'), options.brands)}
              {select('campaign', t('content.filter.campaign'), options.campaigns)}
              {select('format', t('content.filter.format'), options.formats)}
              {select('language', t('content.filter.language'), options.languages)}
              {select('platform', t('content.filter.platform'), options.platforms)}
              {select('status', t('content.filter.status'), options.statuses ?? [])}
              <div className="bsp-fdis-foot">
                <nav
                  className="bsp-seg"
                  aria-label={t('content.view.label')}
                  data-testid="content-view"
                >
                  <SegmentPill selector='[aria-current="page"]' />
                  {(['grid', 'list'] as const).map((id) => (
                    <Link
                      key={id}
                      href={viewHref(id)}
                      aria-current={view === id ? 'page' : undefined}
                      data-testid={`tab-${id}`}
                    >
                      {t(`content.view.${id}`)}
                    </Link>
                  ))}
                </nav>
                <button type="submit" className="bsp-btn bsp-sm" data-testid="content-apply">
                  {t('content.filter.apply')}
                </button>
              </div>
            </form>
          </FiltersDisclosure>
          {(options.channels ?? []).map((platform) => (
            <Link
              key={platform.value}
              href={platformHref(platform.value)}
              className="bsp-chip"
              aria-current={filters['platform'] === platform.value ? 'true' : undefined}
              data-testid={`content-channel-${platform.value}`}
            >
              <ChannelMark
                channel={{ key: platform.value, name: platform.label }}
                size={13}
                label={false}
              />
              <span className="bsp-ltr">{platform.label}</span>
            </Link>
          ))}
          {can.create ? (
            <Link
              href={`/${locale}/content/compose`}
              className="bsp-btn bsp-sm bsp-pur"
              style={{ marginInlineStart: '6px' }}
              data-testid="content-create"
            >
              {t('content.create')}
            </Link>
          ) : null}
        </div>
      </div>

      {ideas.length > 0 ? (
        <section className="bsp-posts-ideas" data-testid="content-ideas">
          <span className="bsp-pill bsp-p-ai">{t('content.p.fromStrategy')}</span>
          {ideas.map((idea) => (
            <Link
              key={idea.key}
              href={idea.href}
              className="bsp-posts-idea"
              title={idea.body}
              data-testid={`content-idea-${idea.key}`}
            >
              {idea.title}
              <span className="bsp-posts-idea-verb">{idea.action} →</span>
            </Link>
          ))}
        </section>
      ) : null}

      {cards.length === 0 ? (
        <section className="bsp-xcard bsp-posts-empty" data-testid="content-empty">
          <span className="bsp-xicon" aria-hidden="true">
            ✎
          </span>
          <span className="bsp-xtitle bsp-sm" style={{ margin: '6px 0 0' }}>
            {filtered ? t('content.emptyFilteredTitle') : t('content.emptyTitle')}
          </span>
          <p className="bsp-xdesc">
            {filtered ? t('content.emptyFilteredBody') : t('content.emptyBody')}
          </p>
          {!filtered && can.create ? (
            <Link
              href={`/${locale}/content/compose`}
              className="bsp-btn bsp-sm bsp-pur"
              data-testid="content-empty-create"
            >
              {t('content.create')}
            </Link>
          ) : null}
        </section>
      ) : view === 'grid' ? (
        <ul className="bsp-posts-grid">
          {cards.map((card) => (
            <li key={card.id} data-testid="content-card" data-item-id={card.id}>
              <article className="bsp-card bsp-lift bsp-post">
                <Link
                  href={studio(card)}
                  aria-label={coverLabel(card)}
                  tabIndex={-1}
                  className="bsp-post-art"
                >
                  {media(card)}
                </Link>
                <div className="bsp-post-body">
                  <div className="bsp-post-top">
                    <Link href={studio(card)} dir="auto" className="bsp-post-title">
                      {card.title}
                    </Link>
                    <span className={`bsp-pill ${PILL[card.status] ?? 'bsp-p-neu'}`}>
                      {t(`content.status.${card.status}`)}
                    </span>
                  </div>
                  {meta(card)}
                  {campaignChip(card)}
                  <div className="bsp-post-acts">
                    {primary(card)}
                    {more(card)}
                  </div>
                </div>
              </article>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="bsp-xcard bsp-posts-list">
          {cards.map((card) => (
            <li key={card.id} data-testid="content-card" data-item-id={card.id}>
              <Link
                href={studio(card)}
                aria-label={card.title}
                tabIndex={-1}
                className="bsp-posts-list-art"
              >
                {media(card, true)}
              </Link>
              <div style={{ display: 'grid', gap: '4px', minInlineSize: 0, flexGrow: 1 }}>
                <div
                  style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}
                >
                  <Link href={studio(card)} dir="auto" className="bsp-post-title">
                    {card.title}
                  </Link>
                  <span className={`bsp-pill ${PILL[card.status] ?? 'bsp-p-neu'}`}>
                    {t(`content.status.${card.status}`)}
                  </span>
                  {campaignChip(card)}
                </div>
                {fullMeta(card)}
              </div>
              <div className="bsp-post-acts" style={{ marginTop: 0, flexShrink: 0 }}>
                {primary(card)}
                {more(card)}
              </div>
            </li>
          ))}
        </ul>
      )}

      {paging && (paging.page > 1 || paging.hasMore) ? (
        <nav
          aria-label={t('content.paging.label')}
          data-testid="content-paging"
          className="bsp-posts-paging"
        >
          {paging.page > 1 ? (
            <Link
              href={pageHref(paging.page - 1)}
              className="bsp-btn bsp-sm bsp-sec"
              data-testid="content-page-previous"
            >
              {t('content.paging.previous')}
            </Link>
          ) : null}
          <span>{t('content.paging.page').replace('{page}', String(paging.page))}</span>
          {paging.hasMore ? (
            <Link
              href={pageHref(paging.page + 1)}
              className="bsp-btn bsp-sm bsp-sec"
              data-testid="content-page-next"
            >
              {t('content.paging.next')}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}

/** The prototype's status pills (`kinds`), for the product's statuses. */
const PILL: Readonly<Record<string, string>> = {
  DRAFT: 'bsp-p-neu',
  CHANGES_REQUESTED: 'bsp-p-warn',
  IN_REVIEW: 'bsp-p-warn',
  APPROVED: 'bsp-p-ok',
  SCHEDULED: 'bsp-p-info',
  PUBLISHING: 'bsp-p-info',
  PUBLISHED: 'bsp-p-ok',
  PARTIALLY_PUBLISHED: 'bsp-p-ok',
  FAILED: 'bsp-p-bad',
  ARCHIVED: 'bsp-p-neu',
};

const centeredStyle = {
  position: 'absolute',
  inset: 0,
  display: 'grid',
  placeItems: 'center',
  color: colorTokens.textSecondary,
} as const;
