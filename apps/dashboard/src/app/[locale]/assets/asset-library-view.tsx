'use client';

import type React from 'react';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AssetKind, AssetScanStatus, AssetStatus } from '@brandspace/database';
import {
  Button,
  Card,
  ContentGrid,
  CONTROL_CLASS,
  Dialog,
  Field,
  IconTile,
  FolderIcon,
  MediaImage,
  ImageIcon,
  LinkTabs,
  SideSheet,
  SearchField,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  type BadgeTone,
} from '@brandspace/ui';
import { translator, type MessageKey } from '../../../i18n/messages';
import { ASSET_VIEWS, type RightsState } from '../../../server/asset-views';

/**
 * The Asset Library screen.
 *
 * A DESIGN-SYSTEM EXTENSION (D-98). Composed entirely from primitives the
 * platform already ships — `PageHeader`, `Toolbar`, `SearchField`,
 * `ContentGrid`, `Card`, `StatusBadge`, `StateMessage`, `Dialog`, `Field`,
 * `IconTile` — and the design tokens. It introduces no colour, font, shadow,
 * spacing scale, layout system or interaction model of its own, which is what
 * rules 4 and 5 of the contract require and what keeps it recognisably part of
 * this product rather than a screen designed in isolation.
 *
 * EVERY FUNCTIONAL STATE IS IMPLEMENTED, because a library that only draws the
 * happy path is a library that surprises a customer the first time a scan
 * fails: loading, empty, no-results, uploading, processing, quarantined,
 * processing-failed, archived and ready each have a rendering and a
 * screen-reader label. Colour is never the only signal — every state carries
 * its word.
 *
 * NAVIGATION IS LINKS AND FORMS. Filters are `<a>` elements carrying query
 * parameters and every mutation is a server action, so the screen works with
 * JavaScript disabled, every view is bookmarkable, and the back button behaves.
 * The one piece of client state is which dialog is open.
 */

export interface AssetVersionData {
  readonly versionNumber: number;
  readonly sizeBytes: number;
  readonly scanStatus: AssetScanStatus;
  readonly createdAt: string;
}

export interface AssetCardData {
  readonly id: string;
  readonly name: string;
  readonly kind: AssetKind;
  readonly status: AssetStatus;
  readonly scanStatus: AssetScanStatus;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly tags: readonly string[];
  readonly folderId: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly failureReason: string | null;
  readonly selectable: boolean;
  /**
   * An opaque, expiring download grant — NEVER a storage key or a path.
   * `null` when the file is not selectable or cannot be previewed inline.
   */
  readonly previewToken: string | null;
  /** PHASE 6 FINAL (D-287) — where it came from, whose shelf, its licence, its use. */
  readonly source: 'UPLOAD' | 'AI_GENERATED' | 'IMPORTED';
  readonly shared: boolean;
  readonly rights: RightsState;
  readonly usedIn: number;
}

export interface AssetUseData {
  readonly contentItemId: string;
  readonly title: string;
  readonly status: string;
  readonly campaignName: string | null;
  readonly platformKeys: readonly string[];
  readonly asCover: boolean;
  readonly updatedAt: string;
}

export interface AssetDetailData extends AssetCardData {
  readonly versions: readonly AssetVersionData[];
  readonly downloadToken: string | null;
  readonly brandName: string | null;
  readonly license: string | null;
  readonly rightsExpiryAt: string | null;
  readonly uploadedBy: string | null;
  readonly uses: readonly AssetUseData[];
}

export interface FolderData {
  readonly id: string;
  readonly name: string;
  readonly brandId: string | null;
  readonly parentFolderId: string | null;
}

type FormAction = (formData: FormData) => Promise<void>;

export interface AssetLibraryViewProps {
  readonly locale: string;
  /**
   * `?upload=1` — the top bar's "Upload to the library" (P6-16) opens the
   * library's OWN upload dialog, not a second upload path. Honoured only when
   * the member may upload; the dialog's action refuses independently.
   */
  readonly openUpload?: boolean;
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
  readonly brands: ReadonlyArray<{ id: string; name: string }>;
  readonly cards: readonly AssetCardData[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  /** D-305 — the reader is past the first page, so the first is offered back. */
  readonly pastFirstPage?: boolean | undefined;
  readonly folders: readonly FolderData[];
  readonly tags: ReadonlyArray<{ tag: string; count: number }>;
  readonly storageLimitGb: number | null;
  readonly storageUsedGb: number;
  readonly maxFileBytes: Readonly<Record<string, number>>;
  readonly allowedMimeTypes: readonly string[];
  readonly selected: AssetDetailData | null;
  /**
   * The selected asset's conversation (D-277 §28, D-281) — the server-rendered
   * `NotesPanel`, passed in as a slot because this view is a client component.
   */
  readonly notes?: React.ReactNode;
  /** D-277 §31 — the selected brand's kit, a view over Brand Profile + library. */
  readonly brandKit?: {
    readonly brandName: string;
    readonly logos: ReadonlyArray<{
      readonly role: 'primary' | 'secondary';
      readonly assetId: string;
      readonly token: string | null;
    }>;
    readonly palette: readonly string[];
    readonly fonts: readonly string[];
  } | null;
  readonly filters: {
    readonly search?: string;
    readonly kind?: string;
    readonly status?: string;
    readonly tag?: string;
    readonly folder?: string;
    /**
     * WHICH SLICE OF THE ONE LIBRARY IS SHOWN (D-193).
     *
     * `undefined` is every asset this member may see, `'shared'` is the
     * workspace-level shelf (`brandId = null`), and a brand id is that brand
     * PLUS the shared shelf — because the fonts and the logo pack are what a
     * brand view is mostly for, and hiding them would push people to upload a
     * second copy.
     *
     * There is ONE library. This is a filter over it, not a second one.
     */
    readonly scope?: string;
    readonly view?: string;
    readonly sort: string;
  };
  readonly can: {
    readonly upload: boolean;
    readonly edit: boolean;
    readonly manageTaxonomy: boolean;
    readonly version: boolean;
    readonly archive: boolean;
    readonly restore: boolean;
    readonly delete: boolean;
    readonly use: boolean;
  };
  readonly actions: {
    readonly upload: FormAction;
    readonly createFolder: FormAction;
    readonly update: FormAction;
    readonly archive: FormAction;
    readonly restore: FormAction;
    readonly remove: FormAction;
    readonly addVersion: FormAction;
    readonly restoreVersion: FormAction;
    readonly bulk: FormAction;
  };
}

/** Every status the grid can show, with the word a reader gets. */
const STATE_LABEL: Readonly<Record<AssetStatus, MessageKey>> = {
  UPLOADING: 'assets.state.uploading',
  PROCESSING: 'assets.state.processing',
  READY: 'assets.state.ready',
  PROCESSING_FAILED: 'assets.state.failed',
  QUARANTINED: 'assets.state.quarantined',
  ARCHIVED: 'assets.state.archived',
};

/**
 * Tone per state.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL — every badge carries its label, so a reader
 * who cannot distinguish the tones still gets the state. The tones exist to
 * make a grid scannable, not to carry meaning alone (WCAG 1.4.1).
 */
const STATE_TONE: Readonly<Record<AssetStatus, BadgeTone>> = {
  UPLOADING: 'info',
  PROCESSING: 'info',
  READY: 'success',
  PROCESSING_FAILED: 'danger',
  QUARANTINED: 'danger',
  ARCHIVED: 'neutral',
};

const KIND_LABEL: Readonly<Record<AssetKind, MessageKey>> = {
  IMAGE: 'assets.kind.IMAGE',
  VIDEO: 'assets.kind.VIDEO',
  AUDIO: 'assets.kind.AUDIO',
  DOCUMENT: 'assets.kind.DOCUMENT',
  FONT: 'assets.kind.FONT',
};

/**
 * Human file size, in the reader's locale.
 *
 * `Intl.NumberFormat` rather than a hand-rolled join, so Arabic gets its own
 * grouping and decimal separator (CLAUDE.md §4). The unit words are ASCII
 * abbreviations in both locales because that is what a file manager shows.
 */
function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const formatted = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', {
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value);
  return `${formatted} ${units[unit]}`;
}

function formatDate(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
  }).format(new Date(iso));
}

/** Build a URL for this route with one filter changed and the rest preserved. */
function filterHref(
  locale: string,
  filters: AssetLibraryViewProps['filters'],
  change: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();
  const merged: Record<string, string | undefined> = {
    q: filters.search,
    kind: filters.kind,
    status: filters.status,
    tag: filters.tag,
    folder: filters.folder,
    scope: filters.scope,
    view: filters.view,
    sort: filters.sort,
    ...change,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const search = params.toString();
  return `/${locale}/assets${search ? `?${search}` : ''}`;
}

export function AssetLibraryView(props: AssetLibraryViewProps) {
  const t = translator(props.locale);
  const { filters, can, actions } = props;
  /** D-305 — the standard business: one brand, so no brand or shelf choice to make. */
  const singleBrand = props.brands.length <= 1;
  const [uploadOpen, setUploadOpen] = useState(props.openUpload === true && props.can.upload);
  const [folderOpen, setFolderOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const uploadFieldId = useId();
  const folderFieldId = useId();
  const bulkFormId = useId();
  const router = useRouter();
  const canBulk = can.edit || can.archive;

  const filtered =
    filters.search !== undefined ||
    filters.kind !== undefined ||
    filters.status !== undefined ||
    filters.tag !== undefined ||
    filters.folder !== undefined;

  const storage =
    props.storageLimitGb === null
      ? t('assets.storageUnlimited')
      : `${props.storageUsedGb} ${t('assets.storageOf')} ${props.storageLimitGb} GB`;

  return (
    <Stack>
      {/*
        NO `PageHeader` HERE, AND THAT IS DELIBERATE. `WorkspaceShell` owns the
        page `h1` so that every route has exactly one and no route can forget
        it — the property the accessibility suite asserts. A `PageHeader` in
        this island would render a SECOND `h1`, which is a WCAG 1.3.1 failure
        that looks like nothing on screen. The actions live in the toolbar
        instead, beside the controls they act on.
      */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: spacingTokens.sm,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <StatusBadge
          label={`${t('assets.storageUsed')}: ${storage}`}
          tone="neutral"
          testId="assets-storage"
        />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
          {can.manageTaxonomy ? (
            <Button variant="neutral" onClick={() => setFolderOpen(true)}>
              {t('assets.newFolder')}
            </Button>
          ) : null}
          {can.upload ? (
            <Button
              variant="primary"
              onClick={() => setUploadOpen(true)}
              data-testid="assets-upload-open"
            >
              {t('assets.upload')}
            </Button>
          ) : null}
        </div>
      </div>

      {props.brandKit &&
      (props.brandKit.logos.length > 0 ||
        props.brandKit.palette.length > 0 ||
        props.brandKit.fonts.length > 0) ? (
        <Card
          title={t('assets.kit.title').replace('{brand}', props.brandKit.brandName)}
          description={t('assets.kit.body')}
          testId="assets-brand-kit"
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.lg,
              alignItems: 'flex-start',
            }}
          >
            {props.brandKit.logos.map((logo) => (
              <a
                key={logo.assetId}
                href={filterHref(props.locale, filters, { asset: logo.assetId } as never)}
                className={CONTROL_CLASS}
                data-testid={`assets-kit-logo-${logo.role}`}
                style={{
                  display: 'grid',
                  gap: spacingTokens['3xs'],
                  justifyItems: 'center',
                  textDecoration: 'none',
                  color: colorTokens.textSecondary,
                  ...typographyTokens.caption,
                }}
              >
                {logo.token ? (
                  <img
                    src={`/${props.locale}/assets/file/${logo.token}`}
                    alt=""
                    style={{
                      inlineSize: '4rem',
                      blockSize: '4rem',
                      objectFit: 'contain',
                      borderRadius: radiusTokens.md,
                      background: colorTokens.surfaceMuted,
                    }}
                  />
                ) : (
                  <IconTile tone="neutral" icon={<ImageIcon size={20} />} />
                )}
                {t(logo.role === 'primary' ? 'assets.kit.primaryLogo' : 'assets.kit.secondaryLogo')}
              </a>
            ))}
            {props.brandKit.palette.length > 0 ? (
              <div
                data-testid="assets-kit-palette"
                style={{ display: 'grid', gap: spacingTokens.xs }}
              >
                <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                  {t('assets.kit.palette')}
                </span>
                <ul
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: spacingTokens.xs,
                    margin: 0,
                    padding: 0,
                    listStyle: 'none',
                  }}
                >
                  {props.brandKit.palette.map((colour) => (
                    <li
                      key={colour}
                      style={{ display: 'grid', justifyItems: 'center', gap: spacingTokens['3xs'] }}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          inlineSize: '2rem',
                          blockSize: '2rem',
                          borderRadius: radiusTokens.full,
                          // The brand's OWN colour, as data — not a design literal.
                          background: colour,
                          border: `1px solid ${colorTokens.cardBorder}`,
                        }}
                      />
                      <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                        {colour}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {props.brandKit.fonts.length > 0 ? (
              <div
                data-testid="assets-kit-fonts"
                style={{ display: 'grid', gap: spacingTokens.xs }}
              >
                <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                  {t('assets.kit.typography')}
                </span>
                <span style={typographyTokens.bodySm}>{props.brandKit.fonts.join(' · ')}</span>
              </div>
            ) : null}
          </div>
          <a
            href={`/${props.locale}/settings/brand`}
            className={CONTROL_CLASS}
            style={{
              display: 'inline-flex',
              marginBlockStart: spacingTokens.sm,
              ...typographyTokens.label,
              color: colorTokens.brandPurple,
            }}
          >
            {t('assets.kit.edit')}
          </a>
        </Card>
      ) : null}

      {/*
        D-287 — VIEWS: derived filters over real columns and references. The
        word is "view" because nothing here is a stored collection.
      */}
      <LinkTabs
        label={t('assets.views.label')}
        testId="assets-views"
        currentId={filters.view ?? 'all'}
        tabs={[
          {
            id: 'all',
            href: filterHref(props.locale, filters, { view: undefined }),
            label: t('assets.view.all'),
          },
          ...ASSET_VIEWS.filter((view) => view !== 'shared' || !singleBrand).map((view) => ({
            id: view,
            href: filterHref(props.locale, filters, {
              view,
              kind: undefined,
              ...(view === 'shared' ? { scope: undefined } : {}),
            }),
            label: t(`assets.view.${view}` as MessageKey),
          })),
        ]}
      />

      <Card testId="assets-filters">
        <div style={{ display: 'grid', gap: spacingTokens.lg }}>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.md,
              alignItems: 'end',
              justifyContent: 'space-between',
            }}
          >
            {/* Search gets its own lane instead of competing visually with every facet. */}
            <form
              method="get"
              action={`/${props.locale}/assets`}
              style={{ display: 'flex', flex: '1 1 18rem', minInlineSize: 0 }}
            >
              <SearchField
                id="assets-search"
                label={t('assets.search')}
                placeholder={t('assets.search')}
                defaultValue={filters.search ?? ''}
              />
              {/* The other filters ride along, so searching does not reset them. */}
              {filters.kind ? <input type="hidden" name="kind" value={filters.kind} /> : null}
              {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
              {filters.tag ? <input type="hidden" name="tag" value={filters.tag} /> : null}
              {filters.folder ? <input type="hidden" name="folder" value={filters.folder} /> : null}
              {filters.scope ? <input type="hidden" name="scope" value={filters.scope} /> : null}
              <input type="hidden" name="sort" value={filters.sort} />
            </form>

            <div style={{ flex: '0 1 auto', minInlineSize: '12rem' }}>
              <FilterGroup
                label={t('assets.sort')}
                allLabel={t('assets.sort.newest')}
                current={filters.sort === 'createdAt' ? undefined : filters.sort}
                options={[
                  { value: 'name', label: t('assets.sort.name') },
                  { value: 'sizeBytes', label: t('assets.sort.size') },
                ]}
                hrefFor={(value) =>
                  filterHref(props.locale, filters, { sort: value ?? 'createdAt' })
                }
              />
            </div>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(14rem, 100%), 1fr))',
              gap: spacingTokens.md,
              alignItems: 'start',
            }}
          >
            {/*
              D-305 — ONE BRAND, NO SCOPE FILTER. A single-brand business sees its
              brand's files (with the shared shelf) and no "Flow 54f8b0 · Flow …"
              chip wall. Several brands get ONE compact select, not a chip per
              brand.
            */}
            {singleBrand ? null : (
              <label
                style={{ display: 'grid', gap: spacingTokens['3xs'], minInlineSize: 0 }}
                data-testid="assets-brand-filter"
              >
                <span style={{ ...typographyTokens.label, color: colorTokens.textSecondary }}>
                  {t('assets.filter.context')}
                </span>
                <select
                  className={`${CONTROL_CLASS} bs-select`}
                  style={inputStyle()}
                  value={filters.scope ?? ''}
                  onChange={(event) =>
                    router.push(
                      filterHref(props.locale, filters, {
                        scope: event.target.value === '' ? undefined : event.target.value,
                      }),
                    )
                  }
                >
                  <option value="">{t('assets.filter.allAssets')}</option>
                  <option value="shared">{t('assets.filter.shared')}</option>
                  {props.brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <FilterGroup
              label={t('assets.filter.kind')}
              allLabel={t('assets.filter.all')}
              current={filters.kind}
              options={(Object.keys(KIND_LABEL) as AssetKind[]).map((kind) => ({
                value: kind,
                label: t(KIND_LABEL[kind]),
              }))}
              hrefFor={(value) => filterHref(props.locale, filters, { kind: value })}
            />

            <FilterGroup
              label={t('assets.filter.status')}
              allLabel={t('assets.filter.all')}
              current={filters.status}
              options={(Object.keys(STATE_LABEL) as AssetStatus[]).map((status) => ({
                value: status,
                label: t(STATE_LABEL[status]),
              }))}
              hrefFor={(value) => filterHref(props.locale, filters, { status: value })}
            />

            {/* Tags are metadata to filter by, not places: they sit with the
                other filters, the most-used first, never beside the folders. */}
            {props.tags.length > 0 ? (
              <FilterGroup
                label={t('assets.tags')}
                allLabel={t('assets.filter.all')}
                current={filters.tag}
                options={props.tags.slice(0, TAG_LIMIT).map((facet) => ({
                  value: facet.tag,
                  label: `${facet.tag} (${facet.count})`,
                }))}
                hrefFor={(value) => filterHref(props.locale, filters, { tag: value })}
              />
            ) : null}
          </div>
        </div>
      </Card>

      <div
        style={{
          display: 'grid',
          // The demo's own two-column working shape: a narrow rail beside the
          // content. It collapses to one column below the same breakpoint the
          // rest of the product uses, so a phone gets the grid and not a
          // squeezed sidebar.
          gridTemplateColumns: 'minmax(0, 1fr)',
          gap: spacingTokens.lg,
        }}
        data-testid="assets-layout"
      >
        <Stack gap={spacingTokens.md}>
          {/* The location is always stated, even before the first folder exists. */}
          <FolderBrowser
            folders={props.folders}
            current={filters.folder}
            hrefFor={(folder) => filterHref(props.locale, filters, { folder })}
            t={t}
          />

          {props.cards.length === 0 ? (
            <StateMessage
              kind={filtered ? 'no-results' : 'empty'}
              title={filtered ? t('assets.emptyFilteredTitle') : t('assets.emptyTitle')}
              description={filtered ? t('assets.emptyFilteredBody') : t('assets.emptyBody')}
              testId="assets-empty"
              action={
                /*
                 * D-299 (§43) — an empty library offers the two ways a file
                 * arrives: Upload (the same dialog as the header's) and
                 * Generate a visual (Creative, which asks `assets.upload` too).
                 */
                !filtered && can.upload ? (
                  <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setUploadOpen(true)}
                      data-testid="assets-empty-upload"
                    >
                      {t('assets.upload')}
                    </Button>
                    <Link
                      href={`/${props.locale}/creative`}
                      className={buttonClass('neutral')}
                      style={buttonStyle('neutral', 'sm')}
                      data-testid="assets-empty-generate"
                    >
                      {t('assets.emptyGenerate')}
                    </Link>
                  </span>
                ) : undefined
              }
            />
          ) : (
            <>
              {canBulk ? (
                <form
                  id={bulkFormId}
                  action={actions.bulk}
                  data-testid="assets-bulk"
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: spacingTokens.sm,
                    alignItems: 'end',
                  }}
                >
                  <input type="hidden" name="locale" value={props.locale} />
                  <Field htmlFor={`${bulkFormId}-op`} label={t('assets.bulk.label')}>
                    <select
                      id={`${bulkFormId}-op`}
                      name="operation"
                      className={CONTROL_CLASS}
                      style={inputStyle({ size: 'sm' })}
                      data-testid="assets-bulk-operation"
                    >
                      {can.edit ? <option value="tag">{t('assets.bulk.tag')}</option> : null}
                      {can.edit ? <option value="move">{t('assets.bulk.move')}</option> : null}
                      {can.archive ? (
                        <option value="archive">{t('assets.bulk.archive')}</option>
                      ) : null}
                    </select>
                  </Field>
                  {can.edit ? (
                    <Field htmlFor={`${bulkFormId}-tag`} label={t('assets.bulk.tagValue')}>
                      <input
                        id={`${bulkFormId}-tag`}
                        name="tag"
                        className={CONTROL_CLASS}
                        style={inputStyle({ size: 'sm' })}
                        data-testid="assets-bulk-tag"
                      />
                    </Field>
                  ) : null}
                  {can.edit && props.folders.length > 0 ? (
                    <Field htmlFor={`${bulkFormId}-folder`} label={t('assets.bulk.folder')}>
                      <select
                        id={`${bulkFormId}-folder`}
                        name="folderId"
                        className={CONTROL_CLASS}
                        style={inputStyle({ size: 'sm' })}
                      >
                        <option value="">{t('assets.allFiles')}</option>
                        {props.folders.map((folder) => (
                          <option key={folder.id} value={folder.id}>
                            {folder.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ) : null}
                  <Button type="submit" variant="neutral" size="sm" data-testid="assets-bulk-apply">
                    {t('assets.bulk.apply')}
                  </Button>
                </form>
              ) : null}
              <ContentGrid min="14rem" testId="assets-grid">
                {props.cards.map((asset) => (
                  <AssetTile
                    key={asset.id}
                    asset={asset}
                    locale={props.locale}
                    href={filterHref(props.locale, filters, { asset: asset.id } as never)}
                    bulkFormId={canBulk ? bulkFormId : null}
                    showShared={!singleBrand}
                    t={t}
                  />
                ))}
              </ContentGrid>
            </>
          )}

          {props.pastFirstPage || (props.hasMore && props.nextCursor) ? (
            <nav
              aria-label={t('assets.paging')}
              data-testid="assets-paging"
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: spacingTokens.sm,
              }}
            >
              {props.pastFirstPage ? (
                <Link
                  href={filterHref(props.locale, filters, {})}
                  className={buttonClass('neutral')}
                  style={buttonStyle('neutral', 'sm')}
                  data-testid="assets-first-page"
                >
                  {t('assets.firstPage')}
                </Link>
              ) : null}
              {props.hasMore && props.nextCursor ? (
                <a
                  href={filterHref(props.locale, filters, {
                    cursor: props.nextCursor,
                  } as never)}
                  className={CONTROL_CLASS}
                  data-testid="assets-load-more"
                  style={{
                    // The same 24px floor as the filter links (WCAG 2.2 AA 2.5.8).
                    display: 'inline-flex',
                    alignItems: 'center',
                    minBlockSize: '24px',
                    ...typographyTokens.label,
                    color: colorTokens.brandPurple,
                    textDecoration: 'none',
                    padding: `${spacingTokens.xs} ${spacingTokens.md}`,
                    borderRadius: radiusTokens.md,
                  }}
                >
                  {t('assets.loadMore')}
                </a>
              ) : null}
            </nav>
          ) : null}
        </Stack>
      </div>

      {/*
        D-287 — THE DETAIL IS A DRAWER over the library, so the grid the reader
        came from stays where it was. Closing it is a navigation back to the
        same view without `?asset=`, so the URL stays the truth.
      */}
      {props.selected ? (
        <SideSheet
          open
          onClose={() => router.push(filterHref(props.locale, filters, {}))}
          title={props.selected.name}
          closeLabel={t('assets.detail.close')}
          testId="asset-detail"
        >
          <AssetDetail
            asset={props.selected}
            locale={props.locale}
            brands={props.brands}
            folders={props.folders}
            can={can}
            actions={actions}
            onRequestDelete={() => setConfirmDelete(props.selected!.id)}
            t={t}
          />
          {props.notes ?? null}
        </SideSheet>
      ) : null}

      {/* --- Upload ------------------------------------------------------ */}
      <Dialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        title={t('assets.upload')}
        closeLabel={t('assets.action.cancel')}
        testId="assets-upload-dialog"
      >
        <form action={actions.upload} encType="multipart/form-data">
          <input type="hidden" name="locale" value={props.locale} />
          {filters.folder ? <input type="hidden" name="folderId" value={filters.folder} /> : null}
          <Stack gap={spacingTokens.md}>
            {props.brands.length > 0 ? (
              <Field htmlFor={`${uploadFieldId}-brand`} label={t('assets.filter.all')}>
                <select
                  id={`${uploadFieldId}-brand`}
                  name="brandId"
                  className={CONTROL_CLASS}
                  style={inputStyle()}
                >
                  {/* A workspace-level asset is the DEFAULT, because the shared
                      logo pack and the contract templates are the files most
                      often uploaded without a brand in mind. */}
                  <option value="">{t('assets.allFiles')}</option>
                  {props.brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Field htmlFor={`${uploadFieldId}-file`} label={t('assets.upload')}>
              <input
                id={`${uploadFieldId}-file`}
                name="file"
                type="file"
                required
                // The ACCEPTED TYPES COME FROM ACTIVATED CONFIGURATION, so the
                // picker offers exactly what the server will admit. It is a
                // courtesy, not a check: the server refuses anything else, and
                // the file's own signature has to agree as well.
                accept={props.allowedMimeTypes.join(',')}
                className={CONTROL_CLASS}
                style={inputStyle()}
                data-testid="assets-file-input"
              />
            </Field>
            <Button type="submit" variant="primary" data-testid="assets-upload-submit">
              {t('assets.upload')}
            </Button>
          </Stack>
        </form>
      </Dialog>

      {/* --- New folder -------------------------------------------------- */}
      <Dialog
        open={folderOpen}
        onClose={() => setFolderOpen(false)}
        title={t('assets.newFolder')}
        closeLabel={t('assets.action.cancel')}
        testId="assets-folder-dialog"
      >
        <form action={actions.createFolder}>
          <input type="hidden" name="locale" value={props.locale} />
          <Stack gap={spacingTokens.md}>
            {/*
              D-305 — WHERE THE FOLDER GOES. Opened inside a folder, the new one
              goes inside it by default; any folder (or the top level) can be
              chosen instead. The tree is `parentFolderId`, and the service
              refuses a parent deeper than the configured maximum.
            */}
            <Field htmlFor={`${folderFieldId}-parent`} label={t('assets.folderParent')}>
              <select
                id={`${folderFieldId}-parent`}
                name="parentFolderId"
                defaultValue={filters.folder ?? ''}
                className={`${CONTROL_CLASS} bs-select`}
                style={inputStyle()}
                data-testid="assets-folder-parent"
              >
                <option value="">{t('assets.folderRoot')}</option>
                {folderTree(props.folders).map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {`${'— '.repeat(depth)}${folder.name}`}
                  </option>
                ))}
              </select>
            </Field>
            <Field htmlFor={`${folderFieldId}-name`} label={t('assets.folderName')}>
              <input
                id={`${folderFieldId}-name`}
                name="name"
                type="text"
                required
                maxLength={120}
                className={CONTROL_CLASS}
                style={inputStyle()}
                data-testid="assets-folder-name"
              />
            </Field>
            <Button type="submit" variant="primary">
              {t('assets.folderCreate')}
            </Button>
          </Stack>
        </form>
      </Dialog>

      {/* --- Delete confirmation ----------------------------------------- */}
      <Dialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title={t('assets.confirm.deleteTitle')}
        closeLabel={t('assets.action.cancel')}
        testId="assets-delete-dialog"
      >
        <form action={actions.remove}>
          <input type="hidden" name="locale" value={props.locale} />
          <input type="hidden" name="assetId" value={confirmDelete ?? ''} />
          <Stack gap={spacingTokens.md}>
            <p style={{ margin: 0, ...typographyTokens.body, color: colorTokens.textSecondary }}>
              {t('assets.confirm.deleteBody')}
            </p>
            <div style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
              <Button type="submit" variant="danger" data-testid="assets-delete-confirm">
                {t('assets.action.delete')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                {t('assets.action.cancel')}
              </Button>
            </div>
          </Stack>
        </form>
      </Dialog>
    </Stack>
  );
}

/**
 * A row of filter links.
 *
 * LINKS, NOT A SELECT, so a filtered view is bookmarkable and the back button
 * works — the same reasoning `Pagination` already follows. `aria-current`
 * marks the active one for a screen reader, so the state does not rely on the
 * background tint alone.
 */
function FilterGroup({
  label,
  allLabel,
  current,
  options,
  hrefFor,
}: {
  readonly label: string;
  readonly allLabel: string;
  readonly current: string | undefined;
  readonly options: ReadonlyArray<{ value: string; label: string }>;
  readonly hrefFor: (value: string | undefined) => string;
}) {
  return (
    <nav aria-label={label} style={{ display: 'grid', gap: spacingTokens.xs, minInlineSize: 0 }}>
      <span
        style={{
          ...typographyTokens.overline,
          textTransform: 'uppercase',
          color: colorTokens.textMuted,
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: spacingTokens['3xs'],
          alignItems: 'center',
          padding: spacingTokens['3xs'],
          borderRadius: radiusTokens.md,
          background: colorTokens.surfaceMuted,
          minInlineSize: 0,
        }}
      >
        {[{ value: undefined, label: allLabel }, ...options].map((option) => {
          const active = option.value === current;
          return (
            <a
              key={option.value ?? '__all__'}
              href={hrefFor(option.value)}
              className={CONTROL_CLASS}
              {...(active ? { 'aria-current': 'true' as const } : {})}
              style={{
                ...typographyTokens.label,
                textDecoration: 'none',
                /*
                 * A 24px MINIMUM TOUCH TARGET — WCAG 2.2 AA 2.5.8.
                 *
                 * These were 27.5 x 20px, which reads fine on a desktop pointer
                 * and fails on a phone: axe reported 268 violations on a 390px
                 * viewport, all of them these links. Padding alone does not fix
                 * it, because a short label gives the box nothing to pad around;
                 * the minimum has to be stated, and the flex centring is what
                 * keeps the label in the middle of the larger box.
                 */
                display: 'inline-flex',
                alignItems: 'center',
                minBlockSize: '28px',
                minInlineSize: '28px',
                justifyContent: 'center',
                padding: `${spacingTokens['3xs']} ${spacingTokens.sm}`,
                borderRadius: radiusTokens.sm,
                color: active ? colorTokens.brandPurple : colorTokens.textSecondary,
                background: active ? colorTokens.surfaceLavender : 'transparent',
              }}
            >
              {option.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * One tile in the grid.
 *
 * THE STATE IS THE FIRST THING IT SAYS. A processing file shows its badge and
 * no preview, a quarantined one says so and offers nothing, and only a
 * selectable file with an inline-previewable type renders its own bytes — via
 * an expiring grant, never a storage key. Everything else gets the typed
 * placeholder tile the design system already draws.
 */
function AssetTile({
  asset,
  locale,
  href,
  bulkFormId,
  showShared,
  t,
}: {
  readonly asset: AssetCardData;
  readonly locale: string;
  readonly href: string;
  /** The bulk form this tile's checkbox belongs to, when bulk actions exist. */
  readonly bulkFormId: string | null;
  /** D-305 — "Shared" means something only when there is more than one brand. */
  readonly showShared: boolean;
  readonly t: (key: MessageKey) => string;
}) {
  const stateLabel = t(STATE_LABEL[asset.status]);
  return (
    <Card padded={false} testId={`asset-tile-${asset.id}`}>
      {bulkFormId ? (
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: spacingTokens.xs,
            padding: `${spacingTokens.xs} ${spacingTokens.md} 0`,
            ...typographyTokens.caption,
            color: colorTokens.textSecondary,
          }}
        >
          <input
            type="checkbox"
            name="assetIds"
            value={asset.id}
            form={bulkFormId}
            data-testid={`asset-select-${asset.id}`}
            // The 24px target WCAG 2.2 AA (2.5.8) asks for, on a phone too.
            style={{ inlineSize: '1.5rem', blockSize: '1.5rem', margin: 0 }}
          />
          {t('assets.bulk.select')}
          <span className="bs-sr-only">{asset.name}</span>
        </label>
      ) : null}
      <a
        href={href}
        className={CONTROL_CLASS}
        style={{
          display: 'grid',
          gap: spacingTokens.xs,
          padding: spacingTokens.md,
          textDecoration: 'none',
          color: 'inherit',
          borderRadius: radiusTokens.lg,
        }}
      >
        <div
          style={{
            aspectRatio: '4 / 3',
            borderRadius: radiusTokens.md,
            background: colorTokens.surfaceMuted,
            display: 'grid',
            placeItems: 'center',
            overflow: 'hidden',
            maxInlineSize: '100%',
          }}
          data-testid={`asset-preview-${asset.status.toLowerCase()}`}
        >
          {asset.previewToken ? (
            /*
             * A PLAIN `img`, NOT `next/image`, and the reason is the grant.
             * The optimiser rewrites a source into its own cached URL, which
             * would mean a short-lived per-viewer capability being stored and
             * re-served by a shared cache — exactly what `cache-control:
             * private, no-store` on the download route forbids. There is also
             * nothing to optimise: the route already serves the bytes the
             * customer uploaded.
             */
            <MediaImage
              src={`/${locale}/assets/file/${asset.previewToken}`}
              alt={asset.name}
              style={{ inlineSize: '100%', blockSize: '100%', objectFit: 'cover' }}
            />
          ) : (
            <IconTile
              tone={asset.status === 'READY' ? 'brand' : 'neutral'}
              icon={<ImageIcon size={20} />}
            />
          )}
        </div>

        <span
          style={{
            ...typographyTokens.label,
            color: colorTokens.textPrimary,
            // A long file name must not stretch the grid column.
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={asset.name}
        >
          {asset.name}
        </span>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens['3xs'],
            alignItems: 'center',
          }}
        >
          <StatusBadge
            label={stateLabel}
            tone={STATE_TONE[asset.status]}
            testId={`asset-state-${asset.id}`}
          />
          <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
            {t(KIND_LABEL[asset.kind])} · {formatBytes(asset.sizeBytes, locale)}
            {asset.width !== null && asset.height !== null
              ? ` · ${asset.width}×${asset.height}`
              : ''}
          </span>
        </div>

        {/* D-287 — small badges, only where they mean something. */}
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens['3xs'] }}
          data-testid={`asset-badges-${asset.id}`}
        >
          {asset.source === 'AI_GENERATED' ? (
            <StatusBadge label={t('assets.badge.ai')} tone="info" />
          ) : null}
          {asset.shared && showShared ? (
            <StatusBadge label={t('assets.filter.shared')} tone="neutral" />
          ) : null}
          {asset.rights === 'expiring' ? (
            <StatusBadge label={t('assets.badge.rightsExpiring')} tone="warning" />
          ) : null}
          {asset.rights === 'expired' ? (
            <StatusBadge
              label={t('assets.badge.rightsExpired')}
              tone="danger"
              testId={`asset-rights-expired-${asset.id}`}
            />
          ) : null}
        </div>
        <span
          style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
          data-testid={`asset-used-${asset.id}`}
        >
          {asset.usedIn === 0
            ? t('assets.usedNone')
            : t(asset.usedIn === 1 ? 'assets.usedOne' : 'assets.usedMany').replace(
                '{count}',
                new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en').format(asset.usedIn),
              )}
        </span>

        {/*
          THE REASON, WHEN THERE IS ONE. A stable key rendered in the reader's
          language — never a raw extractor or scanner message, and never a path
          or a vendor name.
        */}
        {asset.failureReason ? (
          <span
            style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
            data-testid={`asset-reason-${asset.id}`}
          >
            {t(`assets.reason.${asset.failureReason}` as MessageKey)}
          </span>
        ) : null}
      </a>
    </Card>
  );
}

/** The detail panel for one asset: metadata, versions and the actions allowed. */
function AssetDetail({
  asset,
  locale,
  folders,
  can,
  actions,
  onRequestDelete,
  t,
}: {
  readonly asset: AssetDetailData;
  readonly locale: string;
  readonly brands: ReadonlyArray<{ id: string; name: string }>;
  readonly folders: readonly FolderData[];
  readonly can: AssetLibraryViewProps['can'];
  readonly actions: AssetLibraryViewProps['actions'];
  readonly onRequestDelete: () => void;
  readonly t: (key: MessageKey) => string;
}) {
  const fieldId = useId();
  const folder = folders.find((f) => f.id === asset.folderId);

  return (
    <div data-testid="asset-detail-body">
      <Stack gap={spacingTokens.md}>
        {/* A large preview where the bytes may be shown; the state otherwise. */}
        {asset.previewToken ? (
          <img
            src={`/${locale}/assets/file/${asset.previewToken}`}
            alt={asset.name}
            data-testid="asset-detail-preview"
            style={{
              inlineSize: '100%',
              maxBlockSize: '18rem',
              objectFit: 'contain',
              borderRadius: radiusTokens.lg,
              background: colorTokens.surfaceMuted,
            }}
          />
        ) : null}

        {/* D-287 — what a person does with a file, first. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
          {asset.selectable && can.use && (asset.kind === 'IMAGE' || asset.kind === 'VIDEO') ? (
            <a
              href={`/${locale}/content/compose?${new URLSearchParams({
                mode: 'ai',
                asset: asset.id,
              }).toString()}`}
              className={CONTROL_CLASS}
              data-testid="asset-use-in-post"
              style={{
                ...typographyTokens.label,
                color: colorTokens.brandPurple,
                textDecoration: 'none',
                padding: `${spacingTokens.xs} ${spacingTokens.md}`,
                borderRadius: radiusTokens.md,
                background: colorTokens.brandPurpleTint,
              }}
            >
              {t('assets.action.useInPost')}
            </a>
          ) : null}
          {asset.downloadToken ? (
            <a
              href={`/${locale}/assets/file/${asset.downloadToken}`}
              className={CONTROL_CLASS}
              data-testid="asset-download"
              style={{
                ...typographyTokens.label,
                color: colorTokens.textPrimary,
                textDecoration: 'none',
                padding: `${spacingTokens.xs} ${spacingTokens.md}`,
                borderRadius: radiusTokens.md,
                background: colorTokens.surfaceMuted,
              }}
            >
              {t('assets.action.download')}
            </a>
          ) : null}
        </div>

        {asset.rights === 'expired' ? (
          <StateMessage
            kind="error"
            title={t('assets.badge.rightsExpired')}
            description={t('assets.rights.expiredHint')}
            testId="asset-rights-expired"
          />
        ) : null}

        <dl
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(12rem, 100%), 1fr))',
            gap: spacingTokens.sm,
            margin: 0,
          }}
        >
          <Detail label={t('assets.detail.kind')} value={t(KIND_LABEL[asset.kind])} />
          <Detail label={t('assets.detail.size')} value={formatBytes(asset.sizeBytes, locale)} />
          <Detail label={t('assets.detail.uploaded')} value={formatDate(asset.createdAt, locale)} />
          <Detail
            label={t('assets.detail.version')}
            value={new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en').format(asset.version)}
          />
          {asset.width !== null && asset.height !== null ? (
            <Detail
              label={t('assets.detail.dimensions')}
              value={`${asset.width} × ${asset.height}`}
            />
          ) : null}
          {folder ? <Detail label={t('assets.detail.folder')} value={folder.name} /> : null}
          <Detail
            label={t('assets.detail.shelf')}
            value={asset.shared ? t('assets.filter.shared') : (asset.brandName ?? '—')}
          />
          <Detail
            label={t('assets.detail.source')}
            value={t(`assets.source.${asset.source}` as MessageKey)}
          />
          {asset.uploadedBy ? (
            <Detail label={t('assets.detail.createdBy')} value={asset.uploadedBy} />
          ) : null}
          {asset.license ? (
            <Detail label={t('assets.detail.license')} value={asset.license} />
          ) : null}
          {asset.rightsExpiryAt ? (
            <Detail
              label={t('assets.detail.rightsExpiry')}
              value={formatDate(asset.rightsExpiryAt, locale)}
            />
          ) : null}
        </dl>

        {/* D-287 — USED IN, from the real references. Never invented. */}
        <div data-testid="asset-used-in">
          <SectionHeader title={t('assets.detail.usedIn')} />
          {asset.uses.length === 0 ? (
            <p style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}>
              {t('assets.usedNone')}
            </p>
          ) : (
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: 'none',
                display: 'grid',
                gap: spacingTokens.xs,
              }}
            >
              {asset.uses.map((use) => (
                <li key={use.contentItemId} data-testid={`asset-use-${use.contentItemId}`}>
                  <a
                    href={`/${locale}/content/compose?item=${use.contentItemId}`}
                    className={CONTROL_CLASS}
                    style={{ ...typographyTokens.label, color: colorTokens.brandPurple }}
                  >
                    {use.title}
                  </a>
                  <span
                    style={{
                      display: 'block',
                      ...typographyTokens.caption,
                      color: colorTokens.textSecondary,
                    }}
                  >
                    {[
                      t(`content.status.${use.status}` as MessageKey),
                      use.campaignName,
                      use.asCover ? t('assets.detail.asCover') : null,
                      formatDate(use.updatedAt, locale),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* The state, restated where the customer is looking at one file. */}
        {!asset.selectable ? (
          <StateMessage
            kind={asset.status === 'QUARANTINED' ? 'error' : 'empty'}
            title={t(STATE_LABEL[asset.status])}
            description={
              asset.status === 'QUARANTINED'
                ? t('assets.state.quarantinedHint')
                : asset.status === 'PROCESSING'
                  ? t('assets.state.processingHint')
                  : asset.failureReason
                    ? t(`assets.reason.${asset.failureReason}` as MessageKey)
                    : undefined
            }
            testId="asset-detail-state"
          />
        ) : null}

        {can.edit ? (
          <form action={actions.update}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="assetId" value={asset.id} />
            <Stack gap={spacingTokens.sm}>
              <Field htmlFor={`${fieldId}-tags`} label={t('assets.detail.tags')}>
                <input
                  id={`${fieldId}-tags`}
                  name="tags"
                  type="text"
                  defaultValue={asset.tags.join(', ')}
                  className={CONTROL_CLASS}
                  style={inputStyle()}
                  data-testid="asset-tags-input"
                />
              </Field>
              {folders.length > 0 ? (
                <Field htmlFor={`${fieldId}-folder`} label={t('assets.detail.folder')}>
                  <select
                    id={`${fieldId}-folder`}
                    name="folderId"
                    defaultValue={asset.folderId ?? ''}
                    className={CONTROL_CLASS}
                    style={inputStyle()}
                    data-testid="asset-folder-select"
                  >
                    <option value="">{t('assets.allFiles')}</option>
                    {folders.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <Field htmlFor={`${fieldId}-license`} label={t('assets.detail.license')}>
                <input
                  id={`${fieldId}-license`}
                  name="license"
                  type="text"
                  defaultValue={asset.license ?? ''}
                  className={CONTROL_CLASS}
                  style={inputStyle()}
                  data-testid="asset-license-input"
                />
              </Field>
              <Field
                htmlFor={`${fieldId}-rights`}
                label={t('assets.detail.rightsExpiry')}
                hint={t('assets.rights.hint')}
              >
                <input
                  id={`${fieldId}-rights`}
                  name="rightsExpiryAt"
                  type="date"
                  defaultValue={asset.rightsExpiryAt ? asset.rightsExpiryAt.slice(0, 10) : ''}
                  className={CONTROL_CLASS}
                  style={inputStyle()}
                  data-testid="asset-rights-input"
                />
              </Field>
              <Button type="submit" variant="neutral" data-testid="asset-save">
                {t('assets.action.select')}
              </Button>
            </Stack>
          </form>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
          {asset.selectable && can.archive ? (
            <SingleAction
              action={actions.archive}
              locale={locale}
              assetId={asset.id}
              label={t('assets.action.archive')}
              variant="neutral"
              testId="asset-archive"
            />
          ) : null}
          {asset.status === 'ARCHIVED' && can.restore ? (
            <SingleAction
              action={actions.restore}
              locale={locale}
              assetId={asset.id}
              label={t('assets.action.restore')}
              variant="neutral"
              testId="asset-restore"
            />
          ) : null}
          {can.delete ? (
            <Button variant="danger" onClick={onRequestDelete} data-testid="asset-delete">
              {t('assets.action.delete')}
            </Button>
          ) : null}
        </div>

        {can.version ? (
          <form action={actions.addVersion} encType="multipart/form-data">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="assetId" value={asset.id} />
            <Stack gap={spacingTokens.sm}>
              <Field htmlFor={`${fieldId}-version`} label={t('assets.action.newVersion')}>
                <input
                  id={`${fieldId}-version`}
                  name="file"
                  type="file"
                  required
                  accept={asset.mimeType}
                  className={CONTROL_CLASS}
                  style={inputStyle()}
                  data-testid="asset-version-input"
                />
              </Field>
              <Button type="submit" variant="neutral">
                {t('assets.action.newVersion')}
              </Button>
            </Stack>
          </form>
        ) : null}

        {asset.versions.length > 0 ? (
          <div data-testid="asset-versions">
            <SectionHeader title={t('assets.detail.versions')} />
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: 'none',
                display: 'grid',
                gap: spacingTokens.xs,
              }}
            >
              {asset.versions.map((version) => (
                <li
                  key={version.versionNumber}
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: spacingTokens.sm,
                    ...typographyTokens.caption,
                    color: colorTokens.textSecondary,
                  }}
                >
                  <span>
                    {t('assets.detail.version')}{' '}
                    {new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en').format(
                      version.versionNumber,
                    )}
                  </span>
                  <span>{formatBytes(version.sizeBytes, locale)}</span>
                  <span>{formatDate(version.createdAt, locale)}</span>
                  {version.versionNumber !== asset.version && can.version ? (
                    <form action={actions.restoreVersion} style={{ display: 'contents' }}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="assetId" value={asset.id} />
                      <input
                        type="hidden"
                        name="versionNumber"
                        value={String(version.versionNumber)}
                      />
                      <Button type="submit" variant="ghost" size="sm">
                        {t('assets.action.restoreVersion')}
                      </Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Stack>
    </div>
  );
}

function Detail({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt
        style={{
          ...typographyTokens.overline,
          textTransform: 'uppercase',
          color: colorTokens.textMuted,
        }}
      >
        {label}
      </dt>
      <dd style={{ margin: 0, ...typographyTokens.body, color: colorTokens.textPrimary }}>
        {value}
      </dd>
    </div>
  );
}

/** A one-button form, so a mutation is always a POST rather than a link. */
function SingleAction({
  action,
  locale,
  assetId,
  label,
  variant,
  testId,
}: {
  readonly action: FormAction;
  readonly locale: string;
  readonly assetId: string;
  readonly label: string;
  readonly variant: 'primary' | 'neutral' | 'ghost' | 'danger';
  readonly testId: string;
}) {
  return (
    <form action={action} style={{ display: 'contents' }}>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="assetId" value={assetId} />
      <Button type="submit" variant={variant} data-testid={testId}>
        {label}
      </Button>
    </form>
  );
}

/** The most-used tags shown as filters; the rest stay searchable by name. */
const TAG_LIMIT = 12;

/** The folder tree flattened in display order, each with its depth. */
function folderTree(
  folders: readonly FolderData[],
): readonly { folder: FolderData; depth: number }[] {
  const out: { folder: FolderData; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const folder of folders
      .filter((candidate) => candidate.parentFolderId === parent)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ folder, depth });
      // Bounded by the tree itself; a cycle is impossible in a parent pointer
      // the service validates, and the guard below makes it harmless anyway.
      if (depth < 16) walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/**
 * FOLDERS THAT LOOK LIKE FOLDERS (Phase 6 final acceptance, D-305).
 *
 * The library's `AssetFolder` tree was shown as one row of filter chips, so a
 * real hierarchy read as random filters. This is a location — a breadcrumb
 * from "Media Library" to where the reader is — and the folders INSIDE that
 * location as cards; the files below are the ones in it. An APPROVED
 * DESIGN-SYSTEM EXTENSION: `Card`-like surfaces, the existing type scale and
 * a new stroke glyph in the icon family.
 */
function FolderBrowser({
  folders,
  current,
  hrefFor,
  t,
}: {
  readonly folders: readonly FolderData[];
  readonly current: string | undefined;
  readonly hrefFor: (folder: string | undefined) => string;
  readonly t: (key: MessageKey) => string;
}) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const here = current ? (byId.get(current) ?? null) : null;
  const trail: FolderData[] = [];
  for (
    let at = here;
    at && trail.length < 16;
    at = at.parentFolderId ? (byId.get(at.parentFolderId) ?? null) : null
  ) {
    trail.unshift(at);
  }
  const inside = folders
    .filter((folder) => folder.parentFolderId === (here?.id ?? null))
    .sort((a, b) => a.name.localeCompare(b.name));
  const childCount = (id: string) =>
    folders.filter((folder) => folder.parentFolderId === id).length;

  return (
    <section data-testid="assets-folders" style={{ display: 'grid', gap: spacingTokens.sm }}>
      <nav aria-label={t('assets.location')} data-testid="assets-breadcrumbs">
        <ol
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: spacingTokens.xs,
            ...typographyTokens.bodySm,
          }}
        >
          <li>
            {here ? (
              <Link href={hrefFor(undefined)} data-testid="assets-crumb-root">
                {t('assets.root')}
              </Link>
            ) : (
              <strong aria-current="page">{t('assets.root')}</strong>
            )}
          </li>
          {trail.map((folder, index) => (
            <li
              key={folder.id}
              style={{ display: 'inline-flex', alignItems: 'center', gap: spacingTokens.xs }}
            >
              <span aria-hidden="true" style={{ color: colorTokens.textMuted }}>
                /
              </span>
              {index === trail.length - 1 ? (
                <strong aria-current="page" data-testid="assets-crumb-current">
                  {folder.name}
                </strong>
              ) : (
                <Link href={hrefFor(folder.id)}>{folder.name}</Link>
              )}
            </li>
          ))}
        </ol>
      </nav>

      {inside.length > 0 ? (
        <ul
          aria-label={t('assets.folders')}
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(11rem, 100%), 1fr))',
            gap: spacingTokens.sm,
          }}
        >
          {inside.map((folder) => {
            const count = childCount(folder.id);
            return (
              <li key={folder.id}>
                <Link
                  href={hrefFor(folder.id)}
                  className="bs-pressable"
                  data-testid={`assets-folder-${folder.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: spacingTokens.sm,
                    padding: spacingTokens.sm,
                    borderRadius: radiusTokens.lg,
                    background: colorTokens.surface,
                    border: `1px solid ${colorTokens.border}`,
                    color: colorTokens.textPrimary,
                    textDecoration: 'none',
                    minInlineSize: 0,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: 'inline-grid',
                      placeItems: 'center',
                      inlineSize: '2.25rem',
                      blockSize: '2.25rem',
                      flexShrink: 0,
                      borderRadius: radiusTokens.md,
                      background: colorTokens.surfaceLavender,
                      color: colorTokens.brandPurplePressed,
                    }}
                  >
                    <FolderIcon size={18} />
                  </span>
                  <span style={{ display: 'grid', minInlineSize: 0 }}>
                    <span
                      style={{
                        ...typographyTokens.label,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {folder.name}
                    </span>
                    {count > 0 ? (
                      <span
                        style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
                      >
                        {t('assets.subfolders').replace('{count}', String(count))}
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
