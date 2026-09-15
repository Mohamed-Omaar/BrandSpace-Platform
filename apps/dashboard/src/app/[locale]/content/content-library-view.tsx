'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import type { MessageKey } from '../../../i18n/messages';

/**
 * The content library — a MECHANICAL PORT of the approved demo's `postsPage()`
 * (`demo/app-2.js`, pinned in docs/UI-FIDELITY-CONTRACT.md §3).
 *
 * Every class here is transcribed in `@brandspace/ui/content-studio.css` from
 * the demo's own stylesheets. The composition is the demo's: a `view-toolbar`,
 * then `tabs`, then a `filter-row`, then a `card-grid` of `post-card`s, each a
 * square `post-art` above a `post-info` carrying a title, a meta line and a
 * status pill. Nothing is repositioned, recoloured or simplified.
 *
 * WHAT IS REAL. The demo ships eight invented posts, five invented tab counts
 * and a hard-coded gradient per card. Contract rules 5 and 6: the POSITION,
 * TYPOGRAPHY and TREATMENT are unchanged and only the values come from the
 * database — the tabs count real rows, the cards are real drafts, and the art
 * carries the draft's own title rather than "NEW CHAPTER".
 */

export interface ContentCardData {
  readonly id: string;
  readonly title: string;
  readonly status: 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'ARCHIVED';
  readonly brandName: string | null;
  readonly updatedAt: string;
  readonly variantCount: number;
  readonly channels: readonly string[];
  readonly insufficientKnowledge: boolean;
}

export interface ContentLibraryViewProps {
  readonly locale: string;
  readonly t: Record<string, string>;
  readonly cards: readonly ContentCardData[];
  readonly counts: {
    all: number;
    DRAFT: number;
    IN_REVIEW: number;
    CHANGES_REQUESTED: number;
    APPROVED: number;
    ARCHIVED: number;
  };
  readonly brands: readonly { id: string; name: string }[];
  readonly filters: { search?: string; status?: string; brand?: string };
  readonly canCreate: boolean;
}

/*
 * The demo's four post-art gradients, chosen DETERMINISTICALLY from the draft's
 * id rather than at random or in order.
 *
 * Deterministic matters twice: a card keeps the same face across a reload, so
 * people recognise a draft by it, and the visual E2E fixture renders the same
 * page every run rather than one that has to be re-approved (contract §5).
 */
const GRADIENTS = ['a', 'b', 'c', 'd'] as const;

function gradientFor(id: string): string {
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) sum = (sum + id.charCodeAt(i)) % 1024;
  return GRADIENTS[sum % GRADIENTS.length] as string;
}

/**
 * The demo's art carries a two-line poster phrase in very large type. The real
 * equivalent is the draft's own title, clipped to what the box holds — clipping
 * rather than shrinking, because the demo's `clamp(22px, 2.8vw, 38px)` is the
 * approved size and re-deriving it per title would be a redesign.
 */
function artText(title: string): string {
  const words = title.trim().split(/\s+/).slice(0, 3);
  return words.join(' ').slice(0, 28) || '—';
}

const STATUS_CLASS: Record<ContentCardData['status'], string> = {
  DRAFT: 'draft',
  IN_REVIEW: 'review',
  // A reviewer asked for changes: the same warm treatment as "in review",
  // because both mean somebody is waiting on somebody.
  CHANGES_REQUESTED: 'review',
  // The demo's DEFAULT `.status` — its green settled pill. Approved content is
  // exactly what that treatment is for, and using it costs no new CSS: the
  // fidelity transcription test fails on a declaration ADDED to the ported
  // stylesheet as readily as on one lost (UI-FIDELITY-CONTRACT §5).
  APPROVED: '',
  ARCHIVED: '',
};

export function ContentLibraryView({
  locale,
  t,
  cards,
  counts,
  brands,
  filters,
  canCreate,
}: ContentLibraryViewProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  /*
   * FILTERS TRAVEL IN THE URL, not in component state.
   *
   * A filtered library is a page somebody links to a colleague, comes back to,
   * or reloads after an edit. State that lives only in the browser loses all
   * three, and the Asset Library settled the same question the same way.
   */
  const navigate = (next: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { ...filters, ...next };
    for (const [key, value] of Object.entries(merged)) {
      if (typeof value === 'string' && value.trim() !== '') params.set(key, value);
    }
    const query = params.toString();
    startTransition(() => router.push(`/${locale}/content${query ? `?${query}` : ''}`));
  };

  const tab = (key: string | undefined, labelKey: string, count: number) => {
    const selected = (filters.status ?? '') === (key ?? '');
    return (
      <button
        type="button"
        key={labelKey}
        className={selected ? 'selected' : undefined}
        aria-pressed={selected}
        onClick={() => navigate({ status: key })}
      >
        {t[labelKey]} · {count}
      </button>
    );
  };

  const filtered = filters.search !== undefined || filters.brand !== undefined;

  return (
    <div className="content-page" data-testid="content-library">
      <div className="cs-view-toolbar">
        <div>
          <span className="cs-section-kicker">{t['content.eyebrow']}</span>
          <h2>{t['content.title']}</h2>
        </div>
        {canCreate ? (
          <Link
            className="cs-primary-button cs-compact"
            href={`/${locale}/content/compose`}
            data-testid="content-create"
          >
            {t['content.create']}
          </Link>
        ) : null}
      </div>

      <div className="cs-tabs" role="group" aria-label={t['content.title']}>
        {tab(undefined, 'content.tab.all', counts.all)}
        {tab('DRAFT', 'content.tab.draft', counts.DRAFT)}
        {tab('IN_REVIEW', 'content.tab.review', counts.IN_REVIEW)}
        {tab('CHANGES_REQUESTED', 'content.tab.changesRequested', counts.CHANGES_REQUESTED)}
        {tab('APPROVED', 'content.tab.approved', counts.APPROVED)}
        {tab('ARCHIVED', 'content.tab.archived', counts.ARCHIVED)}
      </div>

      <div className="cs-filter-row">
        <label className="cs-sr-only" htmlFor="content-search">
          {t['content.search']}
        </label>
        <input
          id="content-search"
          className="cs-search-field"
          type="search"
          defaultValue={filters.search ?? ''}
          placeholder={t['content.search']}
          data-testid="content-search"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              navigate({ q: (event.target as HTMLInputElement).value });
            }
          }}
        />
        {brands.length > 0 ? (
          <>
            <label className="cs-sr-only" htmlFor="content-brand">
              {t['content.filter.brand']}
            </label>
            <select
              id="content-brand"
              className="cs-select"
              defaultValue={filters.brand ?? ''}
              onChange={(event) => navigate({ brand: event.target.value || undefined })}
            >
              <option value="">{t['content.filter.allBrands']}</option>
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      {cards.length === 0 ? (
        <div className="cs-surface-card cs-empty" data-testid="content-empty">
          <b>{filtered ? t['content.emptyFilteredTitle'] : t['content.emptyTitle']}</b>
          <p>{filtered ? t['content.emptyFilteredBody'] : t['content.emptyBody']}</p>
        </div>
      ) : (
        <div className="cs-card-grid" aria-busy={pending}>
          {cards.map((card) => (
            <Link
              key={card.id}
              className="cs-post-card"
              href={`/${locale}/content/compose?item=${card.id}`}
              data-testid="content-card"
              data-item-id={card.id}
            >
              <div className={`cs-post-art cs-gradient-${gradientFor(card.id)}`}>
                <span aria-hidden="true">{artText(card.title)}</span>
              </div>
              <div className="cs-post-info">
                <b>{card.title}</b>
                <small>
                  {[card.brandName, ...card.channels].filter(Boolean).join(' · ')}
                  {' · '}
                  {card.variantCount}{' '}
                  {card.variantCount === 1
                    ? t['content.variantCount']
                    : t['content.variantCountPlural']}
                </small>
                <span className={`cs-status ${STATUS_CLASS[card.status]}`.trim()}>
                  {t[`content.status.${card.status}` as MessageKey]}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
