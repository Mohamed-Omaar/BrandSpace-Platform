import { randomUUID } from 'node:crypto';
import { canPreviewWithoutDerivative, isSelectable } from '@brandspace/assets';
import { RESCHEDULABLE_SLOT_STATUSES, formatLocalTime } from '@brandspace/content';
import { brandIdQueryFilter, brandScopeFilter, systemClock } from '@brandspace/shared';
import { inWorkspace, requireWorkspacePage } from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor, brandFilterFor } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
import { inAssetLibrary } from '../../../server/assets-context';
import { relativeTime } from '../../../server/home';
import { optionalMessage, statusMessage, translator } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { CONTENT_TYPES } from './content-types';
import {
  ContentLibrary,
  type LibraryCard,
  type LibraryIdea,
  type LibraryStatus,
} from './content-library';

export const dynamic = 'force-dynamic';

/**
 * THE CONTENT LIBRARY (Phase 6 final, D-277 §15, D-282).
 *
 * EVERY NUMBER IS COUNTED AND EVERY FILTER IS IN THE QUERY. The status tabs are
 * a `groupBy` over the member's own brands; brand, campaign, format, platform
 * and language narrow the query itself (`ContentLibraryService.listItems`), so
 * a filter never runs over a page the database already truncated.
 *
 * THE MEDIA IS REAL. A card's picture is the post's first attached image,
 * served through an expiring download grant issued for this viewer — the same
 * mechanism the Asset Library uses — and only for an asset that is ready and
 * clean. A text-only post shows its caption.
 *
 * "IDEAS WORTH MAKING" ARE GROUNDED OR ABSENT: a running campaign with no
 * content yet, and an open content-gap insight from Intelligence. Nothing is
 * suggested that the data does not show.
 */
const STATUSES: readonly LibraryStatus[] = [
  'DRAFT',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'SCHEDULED',
  'PUBLISHING',
  'PUBLISHED',
  'PARTIALLY_PUBLISHED',
  'FAILED',
  'ARCHIVED',
];
/** Always offered, whatever their count: where new work starts. */
const ALWAYS: ReadonlySet<LibraryStatus> = new Set(['DRAFT']);
const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'tiktok', 'x'] as const;

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
  const t = (key: string): string => optionalMessage(locale, key) ?? key;
  const access = await requireWorkspacePage(locale, '/content');
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;
  const may = (key: string) => workspace.permissionKeys.includes(key);

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
  const campaign = single('campaign');
  const rawFormat = single('format');
  const format = (CONTENT_TYPES as readonly string[]).includes(rawFormat ?? '')
    ? (rawFormat as (typeof CONTENT_TYPES)[number])
    : undefined;
  const rawPlatform = single('platform');
  const platform = (PLATFORMS as readonly string[]).includes(rawPlatform ?? '')
    ? rawPlatform
    : undefined;
  const language =
    single('language') === 'AR' ? 'AR' : single('language') === 'EN' ? 'EN' : undefined;
  const view = single('view') === 'list' ? 'list' : 'grid';
  /*
   * D-305 — A BOUNDED, PAGED LIBRARY. 48 posts a page; the 49th read only says
   * whether there is a next page. A page number past the end shows an empty
   * page with the way back, never an error.
   */
  const PAGE_SIZE = 48;
  const rawPage = Number.parseInt(single('page') ?? '1', 10);
  const pageNumber = Number.isFinite(rawPage) ? Math.min(Math.max(rawPage, 1), 200) : 1;

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

  const brandContext = await brandContextFor(workspace, '/content', brandFilter ?? null);
  const effectiveBrand = brandFilterFor(brandContext);
  const now = systemClock.now();

  const { items, hasMore, counts, campaigns, notes, owners } = await inContentStudio(
    workspace.workspaceId,
    async (services) => {
      const library = await services.library();
      const [listed, byStatus] = await Promise.all([
        library.listItems({
          ...(effectiveBrand ? { brandId: effectiveBrand } : {}),
          brandScope: workspace.brandScope,
          ...(status ? { status } : {}),
          ...(search ? { search } : {}),
          ...(campaign ? { campaignId: campaign } : {}),
          ...(format ? { contentType: format } : {}),
          ...(platform ? { platformKey: platform } : {}),
          ...(language ? { locale: language } : {}),
          limit: PAGE_SIZE + 1,
          offset: (pageNumber - 1) * PAGE_SIZE,
        }),
        library.countsByStatus({
          ...(effectiveBrand ? { brandId: effectiveBrand } : {}),
          brandScope: workspace.brandScope,
        }),
      ]);
      const scope = brandIdQueryFilter({
        brandId: effectiveBrand,
        brandScope: workspace.brandScope,
      });
      const [campaignRows, noteRows, ownerRows] = await Promise.all([
        may('campaigns.read')
          ? services.db.campaign.findMany({
              where: { deletedAt: null, ...scope },
              select: { id: true, name: true },
              orderBy: { name: 'asc' },
              take: 100,
            })
          : Promise.resolve([] as { id: string; name: string }[]),
        listed.length > 0
          ? services.db.noteThread.groupBy({
              by: ['contentItemId'],
              where: {
                contentItemId: { in: listed.map((item) => item.id) },
                status: 'OPEN',
                ...brandIdQueryFilter({ brandScope: workspace.brandScope }),
              },
              _count: { _all: true },
            })
          : Promise.resolve([]),
        services.db.membership.findMany({
          where: {
            workspaceId: workspace.workspaceId,
            userId: {
              in: [
                ...new Set(
                  listed.flatMap((item) => (item.createdByUserId ? [item.createdByUserId] : [])),
                ),
              ],
            },
          },
          select: { userId: true, user: { select: { name: true, email: true } } },
        }),
      ]);
      return {
        items: listed.slice(0, PAGE_SIZE),
        hasMore: listed.length > PAGE_SIZE,
        counts: byStatus,
        campaigns: campaignRows,
        notes: new Map(noteRows.map((row) => [row.contentItemId, row._count._all])),
        owners: new Map(
          ownerRows.map((row) => [row.userId, row.user.name?.trim() || row.user.email]),
        ),
      };
    },
  );

  /*
   * THE FIRST PICTURE OF EACH POST, as an expiring grant — only for an asset
   * that is ready, clean and previewable inline. A video is shown as a video,
   * never as a broken image.
   */
  const firstAssets = items.map((item) => ({
    itemId: item.id,
    assetIds: [...new Set(item.variants.flatMap((variant) => variant.assetIds))],
  }));
  const wanted = [...new Set(firstAssets.flatMap((entry) => entry.assetIds.slice(0, 1)))];
  const media = new Map<string, { kind: 'image'; src: string } | { kind: 'video' }>();
  if (wanted.length > 0 && may('assets.read')) {
    await inAssetLibrary(workspace.workspaceId, async (services) => {
      const assets = await services.db.asset.findMany({
        where: { id: { in: wanted }, deletedAt: null },
      });
      const download = await services.download();
      const actor = {
        userId: customer.userId,
        permissionKeys: workspace.permissionKeys,
        brandScope: workspace.brandScope,
      };
      for (const asset of assets) {
        if (!isSelectable(asset)) continue;
        if (asset.kind === 'VIDEO') {
          media.set(asset.id, { kind: 'video' });
        } else if (canPreviewWithoutDerivative(asset.mimeType, asset.sizeBytes)) {
          const grant = await download
            .grantFor({ assetId: asset.id, actor, disposition: 'inline' })
            .then((issued) => issued.grant.token)
            .catch(() => null);
          if (grant) media.set(asset.id, { kind: 'image', src: `/${locale}/assets/file/${grant}` });
        }
      }
    });
  }

  /*
   * B8 — WHAT THE POSTS MENU NEEDS, read once for the page in the tenant
   * context: each post's live plan (only one that can still move is offered),
   * the links of what was published, and the campaigns a post may be filed
   * under (Q21: attach with `content.create`, change with `campaigns.manage`).
   */
  const mayAttachCampaign = may('content.create') || may('campaigns.manage');
  const menuFacts = await inWorkspace(workspace.workspaceId, async ({ db }) => {
    const ids = items.map((item) => item.id);
    const [workspaceRow, slots, jobs, campaignOptions] = await Promise.all([
      db.workspace.findUnique({
        where: { id: workspace.workspaceId },
        select: { timezone: true },
      }),
      ids.length > 0 && may('content.schedule')
        ? db.calendarSlot.findMany({
            where: { contentItemId: { in: ids }, status: { in: [...RESCHEDULABLE_SLOT_STATUSES] } },
            select: { id: true, contentItemId: true, scheduledAtUtc: true },
          })
        : Promise.resolve([]),
      ids.length > 0
        ? db.publishJob.findMany({
            where: {
              contentItemId: { in: ids },
              status: 'PUBLISHED',
              externalPostUrl: { not: null },
            },
            select: { contentItemId: true, provider: true, externalPostUrl: true },
          })
        : Promise.resolve([]),
      mayAttachCampaign
        ? db.campaign.findMany({
            where: {
              deletedAt: null,
              status: { not: 'ARCHIVED' },
              ...brandIdQueryFilter({ brandScope: workspace.brandScope }),
            },
            select: { id: true, name: true, brandId: true },
            orderBy: { name: 'asc' },
            take: 200,
          })
        : Promise.resolve([]),
    ]);
    return { timezone: workspaceRow?.timezone ?? 'UTC', slots, jobs, campaignOptions };
  });
  const slotByItem = new Map(
    menuFacts.slots.map((slot) => {
      const local = formatLocalTime(slot.scheduledAtUtc, menuFacts.timezone);
      return [
        slot.contentItemId,
        { id: slot.id, date: local.slice(0, 10), time: local.slice(11, 16) },
      ] as const;
    }),
  );
  const linksByItem = new Map<string, { label: string; url: string }[]>();
  for (const job of menuFacts.jobs) {
    if (!job.externalPostUrl || !job.externalPostUrl.startsWith('https://')) continue;
    const list = linksByItem.get(job.contentItemId) ?? [];
    list.push({
      label:
        optionalMessage(locale, `content.platform.${job.provider.toLowerCase()}`) ?? job.provider,
      url: job.externalPostUrl,
    });
    linksByItem.set(job.contentItemId, list);
  }
  const campaignsByBrand: Record<string, { id: string; name: string }[]> = {};
  for (const row of menuFacts.campaignOptions) {
    (campaignsByBrand[row.brandId] ??= []).push({ id: row.id, name: row.name });
  }

  const campaignNames = new Map(campaigns.map((row) => [row.id, row.name]));
  const cards: LibraryCard[] = items.map((item) => {
    const assetIds = firstAssets.find((entry) => entry.itemId === item.id)?.assetIds ?? [];
    const first = assetIds[0] ? media.get(assetIds[0]) : undefined;
    const primary =
      item.variants.find((variant) => variant.locale === item.primaryLocale) ?? item.variants[0];
    return {
      id: item.id,
      title: item.title,
      status: item.status as LibraryStatus,
      contentType: item.contentType,
      locale: item.primaryLocale,
      platforms: [...new Set(item.variants.map((variant) => variant.platformKey))],
      campaignName: item.campaignId ? (campaignNames.get(item.campaignId) ?? null) : null,
      brandName: brandNames.get(item.brandId) ?? null,
      updatedLabel: relativeTime(item.updatedAt, now, locale),
      updatedAt: item.updatedAt.toISOString(),
      openNotes: notes.get(item.id) ?? 0,
      ownerName: item.createdByUserId ? (owners.get(item.createdByUserId) ?? null) : null,
      media: first ? { ...first, count: assetIds.length } : { kind: 'none' },
      excerpt: (primary?.body ?? '').slice(0, 280),
      brandId: item.brandId,
      campaignId: item.campaignId,
      slot: slotByItem.get(item.id) ?? null,
      links: linksByItem.get(item.id) ?? [],
    };
  });

  /* ------------------------------------------------------------- ideas */
  const ideas: LibraryIdea[] = [];
  if (may('content.create')) {
    const grounded = await inWorkspace(workspace.workspaceId, async ({ db }) => {
      const scope = brandIdQueryFilter({
        brandId: effectiveBrand,
        brandScope: workspace.brandScope,
      });
      const [empty, gaps] = await Promise.all([
        may('campaigns.read')
          ? db.campaign.findMany({
              where: {
                deletedAt: null,
                status: { in: ['PLANNED', 'ACTIVE'] },
                contentItems: { none: { deletedAt: null } },
                ...scope,
              },
              select: { id: true, name: true },
              orderBy: { updatedAt: 'desc' },
              take: 2,
            })
          : Promise.resolve([] as { id: string; name: string }[]),
        may('strategy.read')
          ? db.insight.findMany({
              where: {
                type: 'CONTENT_GAP',
                status: { in: ['NEW', 'SEEN'] },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                ...scope,
              },
              select: { id: true, title: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            })
          : Promise.resolve([] as { id: string; title: unknown }[]),
      ]);
      return { empty, gaps };
    });
    for (const row of grounded.empty) {
      ideas.push({
        key: `campaign-${row.id}`,
        title: translate('content.ideas.emptyCampaignTitle').replace('{campaign}', row.name),
        body: translate('content.ideas.emptyCampaignBody'),
        href: `/${locale}/content/compose?campaign=${row.id}`,
        action: translate('content.ideas.createForCampaign'),
      });
    }
    for (const row of grounded.gaps) {
      const title = row.title as { en?: string; ar?: string } | null;
      const text = (locale === 'ar' ? (title?.ar ?? title?.en) : (title?.en ?? title?.ar)) ?? '';
      ideas.push({
        key: `gap-${row.id}`,
        title: text || translate('content.ideas.gapTitle'),
        body: translate('content.ideas.gapBody'),
        href: `/${locale}/intelligence?insight=${row.id}`,
        action: translate('content.ideas.viewEvidence'),
      });
    }
  }

  /* -------------------------------------------------------------- tabs */
  const filters: Record<string, string> = Object.fromEntries(
    Object.entries({
      q: search,
      status,
      brand: brandFilter,
      campaign,
      format,
      platform,
      language,
      view: view === 'list' ? 'list' : undefined,
    }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const tabHref = (next: string | undefined) => {
    const params = new URLSearchParams(filters);
    if (next) params.set('status', next);
    else params.delete('status');
    const text = params.toString();
    return `/${locale}/content${text ? `?${text}` : ''}`;
  };
  const total = STATUSES.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  const tabs = [
    {
      id: 'all',
      href: tabHref(undefined),
      label: translate('content.tab.all'),
      badge: String(total),
    },
    ...STATUSES.filter((key) => ALWAYS.has(key) || (counts[key] ?? 0) > 0 || key === status).map(
      (key) => ({
        id: key,
        href: tabHref(key),
        label: t(`content.status.${key}`),
        badge: String(counts[key] ?? 0),
      }),
    ),
  ];

  const ok = single('ok') ?? null;
  const error = single('error') ?? null;
  const reference = single('ref');
  const successText = ok ? statusMessage(ok, locale) : null;
  const errorText = error ? statusMessage(error, locale, reference) : null;

  return (
    <WorkspaceShell
      brandContext={brandContext}
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
      <ContentLibrary
        locale={locale}
        t={t}
        cards={cards}
        tabs={tabs}
        currentStatus={status ?? 'all'}
        filters={filters}
        view={view}
        ideas={ideas}
        duplicateToken={randomUUID()}
        paging={{ page: pageNumber, hasMore }}
        menu={{
          can: {
            schedule: may('content.schedule'),
            archive: may('content.archive'),
            attachCampaign: mayAttachCampaign,
            changeCampaign: may('campaigns.manage'),
          },
          campaignsByBrand,
          today: formatLocalTime(now, menuFacts.timezone).slice(0, 10),
          labels: Object.fromEntries(
            MENU_KEYS.map((key) => [key, optionalMessage(locale, key) ?? '']),
          ),
        }}
        can={{
          create: may('content.create'),
          edit: may('content.edit'),
          submit: may('content.submit'),
          schedule: may('content.schedule'),
        }}
        options={{
          brands:
            brands.length > 1
              ? brands.map((brand) => ({ value: brand.id, label: brand.name }))
              : [],
          campaigns: campaigns.map((row) => ({ value: row.id, label: row.name })),
          platforms: PLATFORMS.map((key) => ({ value: key, label: t(`content.platform.${key}`) })),
          formats: CONTENT_TYPES.map((key) => ({ value: key, label: t(`content.type.${key}`) })),
          languages: [
            { value: 'EN', label: translate('content.language.EN') },
            { value: 'AR', label: translate('content.language.AR') },
          ],
        }}
      />
    </WorkspaceShell>
  );
}

/** B8 — the words the Posts menu uses, resolved on the server. */
const MENU_KEYS = [
  'common.close',
  'common.cancel',
  'calendar.scheduleDate',
  'calendar.scheduleTime',
  'content.menu.label',
  'content.menu.move',
  'content.menu.unschedule',
  'content.menu.archive',
  'content.menu.restore',
  'content.menu.campaign',
  'content.menu.viewOn',
  'content.move.title',
  'content.move.submit',
  'content.campaign.title',
  'content.campaign.none',
  'content.campaign.submit',
  'content.archive.title',
  'content.archive.confirm',
  'content.archive.confirmBody',
] as const;
