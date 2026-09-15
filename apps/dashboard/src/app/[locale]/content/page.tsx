import { brandScopeFilter } from '@brandspace/shared';
import '@brandspace/ui/content-studio.css';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { inContentStudio } from '../../../server/content-context';
import { statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { ContentLibraryView, type ContentCardData } from './content-library-view';

export const dynamic = 'force-dynamic';

/**
 * The AI Content Studio library — Phase 5 scope item 3, docs/PRODUCT.md §5
 * module 7.
 *
 * A DEMO PORT, not an extension: the approved demo has a real design for this
 * route (`postsPage()` in `demo/app-2.js`) and the manifest in
 * docs/UI-FIDELITY-CONTRACT.md §3 pins it. The client island below is the port;
 * this server component reads under RLS inside the workspace context and hands
 * it only what the screen renders.
 *
 * EVERY NUMBER ON THIS PAGE IS COUNTED. The demo's `All · 28 / Drafts · 4 /
 * Review · 3` are invented; these are a `groupBy` over the member's own
 * workspace, and an empty library reads zero rather than borrowing an
 * encouraging number.
 */
/*
 * PHASE 5B-3 ADDED THE TWO STATES A REVIEW PRODUCES. Without them an approved
 * item and one a reviewer sent back were counted by no tab and shown under no
 * filter — reachable only through a link somebody still had. The library is the
 * screen that is supposed to answer "where is my content?".
 */
const STATUSES = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'ARCHIVED'] as const;
type LibraryStatus = (typeof STATUSES)[number];

export default async function ContentPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const translate = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'content.read');

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const search = single('q');
  const brandFilter = single('brand');
  const rawStatus = single('status');
  const status = STATUSES.includes(rawStatus as LibraryStatus)
    ? (rawStatus as LibraryStatus)
    : undefined;

  /*
   * THE MEMBER'S OWN BRANDS, not the workspace's. `brandScopeFilter`
   * contributes nothing when the scope is empty and restricts the query when it
   * is not — filtered here rather than refused afterwards, for the reason
   * docs/SECURITY.md §4.2 gives (F-74).
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

  const brandNames = new Map(brands.map((brand) => [brand.id, brand.name]));
  // A `brand` in the URL that is not one of the member's own is IGNORED rather
  // than refused: the filter narrows a list the member may already see, so an
  // unknown value is a stale link, not an attempt at anything.
  const effectiveBrand = brandFilter && brandNames.has(brandFilter) ? brandFilter : undefined;

  const { cards, counts } = await inContentStudio(workspace.workspaceId, async (services) => {
    const library = await services.library();
    const [items, byStatus] = await Promise.all([
      library.listItems({
        ...(effectiveBrand ? { brandId: effectiveBrand } : {}),
        ...(status ? { status } : {}),
        ...(search ? { search } : {}),
        limit: 48,
      }),
      library.countsByStatus(effectiveBrand),
    ]);

    return {
      cards: items.map((item): ContentCardData => ({
        id: item.id,
        title: item.title,
        status: item.status as LibraryStatus,
        brandName: brandNames.get(item.brandId) ?? null,
        updatedAt: item.updatedAt.toISOString(),
        variantCount: item.variants.length,
        channels: [...new Set(item.variants.map((variant) => variant.platformKey))],
        insufficientKnowledge: item.insufficientKnowledge,
      })),
      counts: {
        all: STATUSES.reduce((sum, key) => sum + (byStatus[key] ?? 0), 0),
        DRAFT: byStatus.DRAFT ?? 0,
        IN_REVIEW: byStatus.IN_REVIEW ?? 0,
        CHANGES_REQUESTED: byStatus.CHANGES_REQUESTED ?? 0,
        APPROVED: byStatus.APPROVED ?? 0,
        ARCHIVED: byStatus.ARCHIVED ?? 0,
      },
    };
  });

  const t = dictionaryFor(translate);

  const ok = single('ok') ?? null;
  const error = single('error') ?? null;
  const reference = single('ref');
  const successText = ok ? statusMessage(ok, locale) : null;
  const errorText = error ? statusMessage(error, locale, reference) : null;

  return (
    <WorkspaceShell
      locale={locale}
      heading={translate('content.title')}
      description={translate('content.subtitle')}
      activePath="/content"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {successText ? <CustomerBanner tone="success">{successText}</CustomerBanner> : null}
      {errorText ? <CustomerBanner tone="error">{errorText}</CustomerBanner> : null}
      <ContentLibraryView
        locale={locale}
        t={t}
        cards={cards}
        counts={counts}
        brands={brands}
        filters={{
          ...(search ? { search } : {}),
          ...(status ? { status } : {}),
          ...(effectiveBrand ? { brand: effectiveBrand } : {}),
        }}
        canCreate={workspace.permissionKeys.includes('content.create')}
      />
    </WorkspaceShell>
  );
}

/**
 * The client island's strings, resolved on the SERVER.
 *
 * A plain record rather than the translator itself: a function cannot cross the
 * server/client boundary, and shipping the whole dictionary to the browser to
 * render one screen is how a message file becomes a bundle. Keys are listed
 * explicitly so a missing one is a compile error rather than an empty span.
 */
const LIBRARY_KEYS = [
  'content.eyebrow',
  'content.title',
  'content.create',
  'content.search',
  'content.filter.brand',
  'content.filter.allBrands',
  'content.tab.all',
  'content.tab.draft',
  'content.tab.review',
  'content.tab.archived',
  'content.emptyTitle',
  'content.emptyBody',
  'content.emptyFilteredTitle',
  'content.emptyFilteredBody',
  'content.tab.changesRequested',
  'content.tab.approved',
  'content.status.DRAFT',
  'content.status.IN_REVIEW',
  'content.status.CHANGES_REQUESTED',
  'content.status.APPROVED',
  'content.status.ARCHIVED',
  'content.variantCount',
  'content.variantCountPlural',
] as const satisfies readonly MessageKey[];

function dictionaryFor(translate: (key: MessageKey) => string): Record<string, string> {
  return Object.fromEntries(LIBRARY_KEYS.map((key) => [key, translate(key)]));
}
