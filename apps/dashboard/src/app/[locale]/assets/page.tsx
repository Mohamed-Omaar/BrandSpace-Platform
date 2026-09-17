import type { AssetKind, AssetStatus } from '@brandspace/database';
import { canPreviewWithoutDerivative, isSelectable } from '@brandspace/assets';
import { brandScopeFilter } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, brandFilterFor } from '../../../server/brand-context';
import { inAssetLibrary } from '../../../server/assets-context';
import { statusMessage, translator } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
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
  const { customer, workspace } = await requireWorkspace(locale, 'assets.read');

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
  const effectiveScope = scopeParam ?? contextBrand;
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

  const data = await inAssetLibrary(workspace.workspaceId, async (services) => {
    const library = await services.library();
    const policy = await services.policy();

    const page = await library.browse({
      actor,
      ...browseScope,
      ...(folderFilter ? { folderId: folderFilter } : {}),
      ...(kindFilter ? { kinds: [kindFilter] } : {}),
      ...(statusFilter ? { statuses: [statusFilter] } : {}),
      ...(tagFilter ? { tags: [tagFilter] } : {}),
      ...(search ? { search } : {}),
      sort,
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
        };
      }),
    );

    return {
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
            previewToken: null,
            versions: versions.map((version) => ({
              versionNumber: version.versionNumber,
              sizeBytes: version.sizeBytes,
              scanStatus: version.scanStatus,
              createdAt: version.createdAt.toISOString(),
            })),
          }
        : null,
    };
  });

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
        eyebrow={t('assets.eyebrow')}
        title={t('assets.title')}
        subtitle={t('assets.subtitle')}
        brands={brands}
        {...data}
        filters={{
          ...(search ? { search } : {}),
          ...(kindFilter ? { kind: kindFilter } : {}),
          ...(statusFilter ? { status: statusFilter } : {}),
          ...(tagFilter ? { tag: tagFilter } : {}),
          ...(folderFilter ? { folder: folderFilter } : {}),
          ...(effectiveScope ? { scope: effectiveScope } : {}),
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
        }}
      />
    </WorkspaceShell>
  );
}
