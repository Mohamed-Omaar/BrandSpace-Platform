import type { AssetKind, AssetStatus } from '@brandspace/database';
import { canPreviewWithoutDerivative, isSelectable } from '@brandspace/assets';
import { brandScopeFilter, systemClock } from '@brandspace/shared';
import {
  ASSET_VIEWS,
  RECENT_DAYS,
  rightsState,
  viewKinds,
  type AssetView,
} from '../../../server/asset-views';
import { inWorkspace, requireWorkspacePage } from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor, brandFilterFor } from '../../../server/brand-context';
import { inAssetLibrary } from '../../../server/assets-context';
import { paletteFrom, typographyFrom } from '../../../server/brand-profile';
import { statusMessage, translator } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { NOTE_PERMISSION } from '@brandspace/collaboration';
import { NotesPanel } from '../../../components/notes-panel';
import { AssetLibraryView, type AssetCardData, type FolderData } from './asset-library-view';
import {
  addAssetVersionAction,
  archiveAssetAction,
  createAssetFolderAction,
  deleteAssetAction,
  restoreAssetAction,
  restoreAssetVersionAction,
  updateAssetAction,
  uploadAssetAction,
  bulkAssetAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * The Asset Library — the customer screen.
 *
 * A DESIGN-SYSTEM EXTENSION, NOT A DEMO PORT (D-98, and
 * `docs/UI-FIDELITY-CONTRACT.md` §6). The approved demo's `#customer/media`
 * route is `simpleFeaturePage('media')` — a "Future product preview" kicker,
 * a heading, one sentence and three identical placeholder cards. There is no
 * Asset Library design in the Landing repository at the pinned commit, so
 * there is nothing to port. This screen is composed from what the platform
 * already ships: `PageHeader`, `Toolbar`, `SearchField`, `ContentGrid`,
 * `Card`, `StatusBadge`, `StateMessage`, `Dialog` and the design tokens. No
 * new colour, font, shadow, layout system or interaction model is introduced.
 *
 * EVERY NUMBER ON THIS PAGE IS COMPUTED. There is no 128, no 2.8 GB and no
 * "All systems operational": the counts are `count()` queries, the storage
 * figure is the real usage counter against the real plan limit, and an empty
 * library reads zero rather than borrowing an encouraging number.
 *
 * The page is a SERVER component: it reads under RLS inside the workspace
 * context and hands the client only what the screen renders — never a storage
 * key, never a checksum. The interactive parts are the client island below it.
 */
export default async function AssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const access = await requireWorkspacePage(locale, '/assets');
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;

  const permissions = workspace.permissionKeys;
  const can = (key: string) => permissions.includes(key);

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const search = single('q');
  const kindFilter = single('kind') as AssetKind | undefined;
  const statusFilter = single('status') as AssetStatus | undefined;
  const tagFilter = single('tag');
  const folderFilter = single('folder');
  const sort = (single('sort') ?? 'createdAt') as 'createdAt' | 'name' | 'sizeBytes';
  const scopeParam = single('scope');
  const selectedId = single('asset');
  /*
   * PHASE 6 FINAL (D-287) — THE LIBRARY'S VIEWS. Each is a filter over real
   * columns (kind, source, age, shelf, references), never a stored collection,
   * which is why the screen calls them views.
   */
  const view = ASSET_VIEWS.includes(single('view') as AssetView)
    ? (single('view') as AssetView)
    : undefined;
  /*
   * THE PAGE CURSOR — the read that was missing (PHASE 2).
   *
   * `AssetLibraryService.browse` has always returned `nextCursor`, and the view
   * has always rendered a "Load more" link carrying it as `?cursor=`. Nothing
   * read it back. So the link went round in a circle: every press re-requested
   * the FIRST page, the grid redrew the same 48 tiles, and a workspace with
   * more than a page of assets had no way to reach the rest of them — the
   * pagination was complete at both ends and disconnected in the middle.
   *
   * IT IS PASSED THROUGH UNINSPECTED, which is safe by construction: the cursor
   * is opaque, carries no secret, and decodes to a sort value plus an id used
   * only as a `WHERE` predicate. A forged one can move a reader within the rows
   * RLS and their BrandScope already admit, and nowhere else.
   */
  const cursor = single('cursor');

  /*
   * THE MEMBER'S OWN BRANDS, not the workspace's.
   *
   * `brandScopeFilter` contributes nothing when the scope is empty — which it
   * is for every membership today — and restricts the query when it is not.
   * Filtering here rather than refusing afterwards matters for the same reason
   * it does on the Brand Brain screen (docs/SECURITY.md §4.2, F-74).
   */
  const brands = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: {
        deletedAt: null,
        status: { in: ['ACTIVE', 'DRAFT'] },
        ...brandScopeFilter(workspace.brandScope),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    }),
  );

  const brandContext = await brandContextFor(workspace, '/assets');

  /*
   * THE LIBRARY'S SLICE, AND WHERE ITS DEFAULT COMES FROM (D-193).
   *
   * `/assets` is a BRAND-OR-ALL route, so with a brand on the rail the library
   * opens on THAT BRAND PLUS THE SHARED SHELF — the phase brief's default — and
   * the reader can still widen to every asset they may see, or narrow to shared
   * only, from the filter row. An explicit `?scope=` always wins, so a
   * bookmarked view is the view that comes back.
   *
   * A BRAND ID IS NOT TAKEN ON TRUST. `library.browse` calls
   * `assertAssetBrandInScope` on any named brand, and an id outside the
   * member's scope is refused there rather than filtered out here — so this
   * only has to decide what was ASKED FOR, never what is allowed.
   */
  const contextBrand = brandFilterFor(brandContext);
  const effectiveScope = view === 'shared' ? 'shared' : (scopeParam ?? contextBrand);
  const browseScope: { brandId?: string | null; includeShared?: boolean } =
    effectiveScope === undefined
      ? {}
      : effectiveScope === 'shared'
        ? { brandId: null }
        : { brandId: effectiveScope, includeShared: true };

  const actor = {
    userId: customer.userId,
    permissionKeys: permissions,
    brandScope: workspace.brandScope,
  };

  /*
   * PHASE 6 FINAL (D-277 §31, D-287) — THE BRAND KIT, A VIEW. Logos from the
   * one library (the Brand Profile's own references), palette and typography
   * from the Brand Profile. Nothing is copied; editing stays in Settings.
   */
  const kitBrandId =
    brandContext.resolution.kind === 'brand' ? brandContext.resolution.brand.id : null;
  const brandKit = kitBrandId
    ? await inAssetLibrary(workspace.workspaceId, async (services) => {
        const brand = await services.db.brand.findFirst({
          where: { id: kitBrandId, deletedAt: null },
          select: {
            name: true,
            colorPalette: true,
            typography: true,
            primaryLogoAssetId: true,
            secondaryLogoAssetId: true,
          },
        });
        if (!brand) return null;
        const download = await services.download();
        const logos = await Promise.all(
          (
            [
              ['primary', brand.primaryLogoAssetId],
              ['secondary', brand.secondaryLogoAssetId],
            ] as const
          )
            .filter((entry): entry is readonly ['primary' | 'secondary', string] => !!entry[1])
            .map(async ([role, assetId]) => ({
              role,
              assetId,
              token: await download
                .grantFor({ assetId, actor, disposition: 'inline' })
                .then((issued) => issued.grant.token)
                .catch(() => null),
            })),
        );
        const fonts = typographyFrom(brand.typography);
        return {
          brandName: brand.name,
          logos,
          palette: paletteFrom(brand.colorPalette),
          fonts: [fonts.heading, fonts.body].filter((font): font is string => !!font),
        };
      })
    : null;

  const { selectedBrandId, ...data } = await inAssetLibrary(
    workspace.workspaceId,
    async (services) => {
      const library = await services.library();
      const policy = await services.policy();

      const page = await library.browse({
        actor,
        ...browseScope,
        ...(folderFilter ? { folderId: folderFilter } : {}),
        ...(kindFilter ? { kinds: [kindFilter] } : viewKinds(view)),
        ...(view === 'ai' ? { sources: ['AI_GENERATED' as const] } : {}),
        ...(view === 'uploaded' ? { sources: ['UPLOAD' as const] } : {}),
        ...(view === 'recent'
          ? { createdAfter: new Date(systemClock.now().getTime() - RECENT_DAYS * 86_400_000) }
          : {}),
        ...(view === 'unused' ? { unusedOnly: true } : {}),
        ...(statusFilter ? { statuses: [statusFilter] } : {}),
        ...(tagFilter ? { tags: [tagFilter] } : {}),
        ...(search ? { search } : {}),
        sort,
        ...(cursor ? { cursor } : {}),
        limit: 48,
        includeArchived: statusFilter === 'ARCHIVED',
      });

      const [folders, tags, storageLimitGb, usedCounter] = await Promise.all([
        library.listFolders(actor),
        library.tagFacets(actor),
        services.storageLimitGb(),
        services.db.usageCounter.findFirst({ where: { featureKey: 'limit.storage_gb' } }),
      ]);

      const selected =
        selectedId !== undefined ? await library.get(selectedId, actor).catch(() => null) : null;
      const versions = selected ? await library.versions(selected.id, actor) : [];
      // D-287 — where the file is used, from the real references, and how
      // many posts use each tile on this page (one query).
      const [uses, usage] = await Promise.all([
        selected ? library.usage(selected.id, actor) : Promise.resolve([]),
        library.usageCounts(page.items.map((asset) => asset.id)),
      ]);
      const now = systemClock.now();
      const uploader = selected?.uploadedByUserId
        ? await services.db.membership
            .findFirst({
              // Through the MEMBERSHIP, so only a person of this workspace is named.
              where: { userId: selected.uploadedByUserId },
              select: { user: { select: { name: true, email: true } } },
            })
            .then((row) => row?.user ?? null)
            .catch(() => null)
        : null;

      /*
       * A DOWNLOAD GRANT PER TILE, ISSUED ON THE SERVER.
       *
       * The client never receives a storage key or a path — only an opaque,
       * expiring token bound to this workspace. Only SELECTABLE assets get one:
       * a quarantined, processing, failed or archived file has no grant at all,
       * so there is no path to its bytes rather than a broken one
       * (docs/SECURITY.md §11.6-11.7).
       */
      const download = await services.download();
      const cards: AssetCardData[] = await Promise.all(
        page.items.map(async (asset) => {
          const selectable = isSelectable(asset);
          const grant =
            selectable && canPreviewWithoutDerivative(asset.mimeType, asset.sizeBytes)
              ? await download
                  .grantFor({ assetId: asset.id, actor, disposition: 'inline' })
                  .then((issued) => issued.grant.token)
                  .catch(() => null)
              : null;
          return {
            id: asset.id,
            name: asset.name,
            kind: asset.kind,
            status: asset.status,
            scanStatus: asset.scanStatus,
            mimeType: asset.mimeType,
            sizeBytes: asset.sizeBytes,
            width: asset.width,
            height: asset.height,
            tags: asset.tags,
            folderId: asset.folderId,
            version: asset.currentVersion,
            createdAt: asset.createdAt.toISOString(),
            failureReason: asset.failureReason,
            selectable,
            previewToken: grant,
            source: asset.source,
            shared: asset.brandId === null,
            rights: rightsState(asset.rightsExpiryAt, now),
            usedIn: usage.get(asset.id) ?? 0,
          };
        }),
      );

      return {
        // Which brand the selected asset belongs to (null = workspace-shared).
        selectedBrandId: selected ? selected.brandId : null,
        cards,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        folders: folders.map((folder): FolderData => ({
          id: folder.id,
          name: folder.name,
          brandId: folder.brandId,
          parentFolderId: folder.parentFolderId,
        })),
        tags: tags.map((facet) => ({ tag: facet.tag, count: facet.count })),
        storageLimitGb,
        storageUsedGb: usedCounter?.usedValue ?? 0,
        maxFileBytes: policy.upload.maxFileBytes,
        allowedMimeTypes: Object.values(policy.upload.allowedMimeTypes).flat(),
        selected: selected
          ? {
              id: selected.id,
              name: selected.name,
              kind: selected.kind,
              status: selected.status,
              scanStatus: selected.scanStatus,
              mimeType: selected.mimeType,
              sizeBytes: selected.sizeBytes,
              width: selected.width,
              height: selected.height,
              tags: selected.tags,
              folderId: selected.folderId,
              version: selected.currentVersion,
              createdAt: selected.createdAt.toISOString(),
              failureReason: selected.failureReason,
              selectable: isSelectable(selected),
              previewToken:
                isSelectable(selected) &&
                canPreviewWithoutDerivative(selected.mimeType, selected.sizeBytes)
                  ? await download
                      .grantFor({ assetId: selected.id, actor, disposition: 'inline' })
                      .then((issued) => issued.grant.token)
                      .catch(() => null)
                  : null,
              downloadToken: isSelectable(selected)
                ? await download
                    .grantFor({ assetId: selected.id, actor, disposition: 'attachment' })
                    .then((issued) => issued.grant.token)
                    .catch(() => null)
                : null,
              source: selected.source,
              shared: selected.brandId === null,
              brandName: selected.brandId
                ? (brands.find((brand) => brand.id === selected.brandId)?.name ?? null)
                : null,
              license: selected.license,
              rightsExpiryAt: selected.rightsExpiryAt?.toISOString() ?? null,
              rights: rightsState(selected.rightsExpiryAt, now),
              uploadedBy: uploader ? (uploader.name ?? uploader.email) : null,
              usedIn: uses.length,
              uses: uses.map((use) => ({
                contentItemId: use.contentItemId,
                title: use.title,
                status: use.status,
                campaignName: use.campaignName,
                platformKeys: use.platformKeys,
                asCover: use.asCover,
                updatedAt: use.updatedAt.toISOString(),
              })),
              versions: versions.map((version) => ({
                versionNumber: version.versionNumber,
                sizeBytes: version.sizeBytes,
                scanStatus: version.scanStatus,
                createdAt: version.createdAt.toISOString(),
              })),
            }
          : null,
      };
    },
  );

  /*
   * THE BRAND AN ASSET'S CONVERSATION BELONGS TO (D-281): the asset's own, or —
   * for a workspace-shared asset — the brand on the rail. With a shared asset
   * and "All brands" there is no brand to talk in, and no panel.
   */
  const notesBrandId =
    data.selected === null
      ? null
      : (selectedBrandId ??
        (brandContext.resolution.kind === 'brand' ? brandContext.resolution.brand.id : null));

  // The real outcome, in the reader's language, with the correlation id on a
  // failure — the one value that joins this screen to the redacted server log.
  const status = single('ok') ?? null;
  const error = single('error') ?? null;
  const reference = single('ref');
  const successText = status ? statusMessage(status, locale) : null;
  const errorText = error ? statusMessage(error, locale, reference) : null;

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('assets.title')}
      description={t('assets.subtitle')}
      activePath="/assets"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={permissions}
    >
      {successText ? <CustomerBanner tone="success">{successText}</CustomerBanner> : null}
      {errorText ? <CustomerBanner tone="error">{errorText}</CustomerBanner> : null}
      <AssetLibraryView
        locale={locale}
        notes={
          notesBrandId && selectedId && can(NOTE_PERMISSION) ? (
            <NotesPanel
              locale={locale}
              subject={{ type: 'ASSET', assetId: selectedId, brandId: notesBrandId }}
              returnPath={`/${locale}/assets?asset=${selectedId}`}
              highlightThreadId={single('thread') ?? null}
            />
          ) : null
        }
        brandKit={brandKit}
        openUpload={query['upload'] === '1'}
        eyebrow={t('assets.eyebrow')}
        title={t('assets.title')}
        subtitle={t('assets.subtitle')}
        brands={brands}
        pastFirstPage={cursor !== undefined}
        {...data}
        filters={{
          ...(search ? { search } : {}),
          ...(kindFilter ? { kind: kindFilter } : {}),
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(tagFilter ? { tag: tagFilter } : {}),
          ...(folderFilter ? { folder: folderFilter } : {}),
          ...(effectiveScope && view !== 'shared' ? { scope: effectiveScope } : {}),
          ...(view ? { view } : {}),
          sort,
        }}
        can={{
          upload: can('assets.upload'),
          edit: can('assets.edit'),
          manageTaxonomy: can('assets.manage_taxonomy'),
          version: can('assets.version'),
          archive: can('assets.archive'),
          restore: can('assets.restore'),
          delete: can('assets.delete'),
          use: can('assets.use'),
        }}
        actions={{
          upload: uploadAssetAction,
          createFolder: createAssetFolderAction,
          update: updateAssetAction,
          archive: archiveAssetAction,
          restore: restoreAssetAction,
          remove: deleteAssetAction,
          addVersion: addAssetVersionAction,
          restoreVersion: restoreAssetVersionAction,
          bulk: bulkAssetAction,
        }}
      />
    </WorkspaceShell>
  );
}
