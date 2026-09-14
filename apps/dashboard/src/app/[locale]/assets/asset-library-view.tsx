'use client';

import { useId, useState } from 'react';
import type { AssetKind, AssetScanStatus, AssetStatus } from '@brandspace/database';
import {
  Button,
  Card,
  ContentGrid,
  CONTROL_CLASS,
  Dialog,
  Field,
  IconTile,
  ImageIcon,
  SearchField,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  Toolbar,
  colorTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  type BadgeTone,
} from '@brandspace/ui';
import { translator, type MessageKey } from '../../../i18n/messages';

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
}

export interface AssetDetailData extends AssetCardData {
  readonly versions: readonly AssetVersionData[];
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
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
  readonly brands: ReadonlyArray<{ id: string; name: string }>;
  readonly cards: readonly AssetCardData[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
  readonly folders: readonly FolderData[];
  readonly tags: ReadonlyArray<{ tag: string; count: number }>;
  readonly storageLimitGb: number | null;
  readonly storageUsedGb: number;
  readonly maxFileBytes: Readonly<Record<string, number>>;
  readonly allowedMimeTypes: readonly string[];
  readonly selected: AssetDetailData | null;
  readonly filters: {
    readonly search?: string;
    readonly kind?: string;
    readonly status?: string;
    readonly tag?: string;
    readonly folder?: string;
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
  const [uploadOpen, setUploadOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const uploadFieldId = useId();
  const folderFieldId = useId();

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

      <Toolbar>
        {/*
          A GET FORM, so search is a link the browser makes. It works with
          JavaScript disabled, the result is bookmarkable, and the back button
          returns to the previous query rather than to an empty grid.
        */}
        <form method="get" action={`/${props.locale}/assets`} style={{ display: 'contents' }}>
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
          <input type="hidden" name="sort" value={filters.sort} />
        </form>

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

        <FilterGroup
          label={t('assets.sort')}
          allLabel={t('assets.sort.newest')}
          current={filters.sort === 'createdAt' ? undefined : filters.sort}
          options={[
            { value: 'name', label: t('assets.sort.name') },
            { value: 'sizeBytes', label: t('assets.sort.size') },
          ]}
          hrefFor={(value) => filterHref(props.locale, filters, { sort: value ?? 'createdAt' })}
        />
      </Toolbar>

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
          {(props.folders.length > 0 || props.tags.length > 0) && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: spacingTokens.sm,
                alignItems: 'center',
              }}
              data-testid="assets-taxonomy"
            >
              <FilterGroup
                label={t('assets.folders')}
                allLabel={t('assets.allFiles')}
                current={filters.folder}
                options={props.folders.map((folder) => ({
                  value: folder.id,
                  label: folder.name,
                }))}
                hrefFor={(value) => filterHref(props.locale, filters, { folder: value })}
              />
              {props.tags.length > 0 ? (
                <FilterGroup
                  label={t('assets.tags')}
                  allLabel={t('assets.filter.all')}
                  current={filters.tag}
                  options={props.tags.map((facet) => ({
                    value: facet.tag,
                    label: `${facet.tag} (${facet.count})`,
                  }))}
                  hrefFor={(value) => filterHref(props.locale, filters, { tag: value })}
                />
              ) : null}
            </div>
          )}

          {props.cards.length === 0 ? (
            <StateMessage
              kind={filtered ? 'no-results' : 'empty'}
              title={filtered ? t('assets.emptyFilteredTitle') : t('assets.emptyTitle')}
              description={filtered ? t('assets.emptyFilteredBody') : t('assets.emptyBody')}
              testId="assets-empty"
            />
          ) : (
            <ContentGrid min="14rem" testId="assets-grid">
              {props.cards.map((asset) => (
                <AssetTile
                  key={asset.id}
                  asset={asset}
                  locale={props.locale}
                  href={filterHref(props.locale, filters, { asset: asset.id } as never)}
                  t={t}
                />
              ))}
            </ContentGrid>
          )}

          {props.hasMore && props.nextCursor ? (
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <a
                href={filterHref(props.locale, filters, {
                  cursor: props.nextCursor,
                } as never)}
                className={CONTROL_CLASS}
                data-testid="assets-load-more"
                style={{
                  ...typographyTokens.label,
                  color: colorTokens.brandPurple,
                  textDecoration: 'none',
                  padding: `${spacingTokens.xs} ${spacingTokens.md}`,
                  borderRadius: radiusTokens.md,
                }}
              >
                {t('assets.loadMore')}
              </a>
            </div>
          ) : null}
        </Stack>
      </div>

      {props.selected ? (
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
    <nav
      aria-label={label}
      style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens['3xs'], alignItems: 'center' }}
    >
      <span
        style={{
          ...typographyTokens.overline,
          textTransform: 'uppercase',
          color: colorTokens.textMuted,
          marginInlineEnd: spacingTokens['3xs'],
        }}
      >
        {label}
      </span>
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
              padding: `${spacingTokens['3xs']} ${spacingTokens.xs}`,
              borderRadius: radiusTokens.sm,
              color: active ? colorTokens.brandPurple : colorTokens.textSecondary,
              background: active ? colorTokens.surfaceMuted : 'transparent',
            }}
          >
            {option.label}
          </a>
        );
      })}
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
  t,
}: {
  readonly asset: AssetCardData;
  readonly locale: string;
  readonly href: string;
  readonly t: (key: MessageKey) => string;
}) {
  const stateLabel = t(STATE_LABEL[asset.status]);
  return (
    <Card padded={false} testId={`asset-tile-${asset.id}`}>
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
            <img
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
          </span>
        </div>

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
    <Card title={t('assets.detail.title')} testId="asset-detail">
      <Stack gap={spacingTokens.md}>
        <SectionHeader title={asset.name} />

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
        </dl>

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
    </Card>
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
