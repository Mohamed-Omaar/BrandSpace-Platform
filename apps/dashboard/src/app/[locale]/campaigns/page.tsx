import Link from 'next/link';
import {
  AbstractMedia,
  AssetMedia,
  SegmentPill,
  StateMessage,
  type MediaSeed,
} from '@brandspace/ui';
import { workspaceMonthLabel } from '@brandspace/entitlements';
import { systemClock } from '@brandspace/shared';
import { inWorkspace, requireWorkspacePage } from '../../../server/customer-context';
import { NoAccessPage } from '../../../components/no-access-page';
import { brandContextFor, brandFilterFor } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
import { mediaForVariants } from '../../../server/media-picker';
import { optionalMessage, statusMessage, translator, successFlash } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { CAMPAIGN_STATUSES } from '../../../server/campaign-form';
import { bestCampaign, formatRateMilli } from '../../../server/best-campaign';
import { ChannelMark } from '../calendar/prototype-calendar';
import { objectiveLabel, periodLabel, statusLabel } from './labels';

import { EmptyAction } from '../../../components/empty-action';
import { whenLabel } from '../../../server/prototype-dates';

export const dynamic = 'force-dynamic';

/**
 * CAMPAIGNS — the prototype's campaigns list (`Main.dc.html` lines 1159–1199,
 * D-468 batch 3), over the Phase 7 domain (D-195, AC-26).
 *
 * The composition is the prototype's: the lavender-to-yellow hero (the
 * running / planned / ended line, what ends or starts next, "+ New campaign"
 * and the stat tiles), the status switch with counts, and the two-across cards
 * — the posts' pictures, the status chip, the name, the dates, channels and
 * objective, what has been published, the next post, and Open.
 *
 * EVERY FIGURE IS READ FROM THE DOMAIN: the campaigns, the posts filed under
 * them, their calendar slots and their pictures through the one Asset Library.
 * Nothing is invented and nothing new is stored.
 *
 * BRAND-OR-ALL (D-192). A multi-brand owner's campaigns are worth seeing
 * together, and a brand on the rail narrows them. "All brands" means the brands
 * THIS MEMBER may access, which is what `brandIdQueryFilter` puts in the WHERE.
 */
/*
 * Review of #67 — THE PROTOTYPE'S TAB ORDER: Running · Paused · Planned · Ended;
 * the product's draft and archived statuses follow, shown only when they have
 * campaigns, as every tab is.
 */
const PROTOTYPE_ORDER = ['ACTIVE', 'PAUSED', 'PLANNED', 'COMPLETED'] as const;
const LISTABLE = [
  ...PROTOTYPE_ORDER,
  ...CAMPAIGN_STATUSES.filter((value) => !(PROTOTYPE_ORDER as readonly string[]).includes(value)),
  'ARCHIVED',
] as const;
type ListableStatus = (typeof LISTABLE)[number];

/** The chip's dot per status: the prototype's run, paused, planned and ended. */
const DOT: Record<string, string> = {
  ACTIVE: 'bsp-camp-dot-run',
  PAUSED: 'bsp-camp-dot-paused',
  PLANNED: 'bsp-camp-dot-plan',
  COMPLETED: 'bsp-camp-dot-ended',
  DRAFT: 'bsp-camp-dot-paused',
  ARCHIVED: 'bsp-camp-dot-paused',
};

const DAY_MS = 86_400_000;

export default async function CampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const access = await requireWorkspacePage(locale, '/campaigns');
  const { messageLocale } = access.session;
  const t = translator(messageLocale);
  if (!access.allowed) return <NoAccessPage locale={locale} access={access} />;
  const { customer, workspace } = access.session;

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const brandContext = await brandContextFor(workspace, '/campaigns', single('brand'));
  const effectiveBrand = brandFilterFor(brandContext);
  const rawStatus = single('status');
  const status = LISTABLE.includes(rawStatus as ListableStatus)
    ? (rawStatus as ListableStatus)
    : undefined;

  const mayManage = workspace.permissionKeys.includes('campaigns.manage');

  /*
   * EVERY CAMPAIGN THIS MEMBER MAY SEE, archived included, read once: the
   * switch counts them by status and the list is the switch's choice of them —
   * a campaign that is not archived when no status is chosen, exactly as before.
   */
  const everything = await inContentStudio(workspace.workspaceId, async (services) =>
    services.campaigns().list({
      ...(effectiveBrand ? { brandId: effectiveBrand } : {}),
      includeArchived: true,
      brandScope: workspace.brandScope,
      take: 200,
    }),
  );
  const campaigns = everything
    .filter((campaign) => (status ? campaign.status === status : campaign.deletedAt === null))
    .slice(0, 100);
  const countOf = (key: ListableStatus) =>
    everything.filter((campaign) => campaign.status === key).length;
  const live = everything.filter((campaign) => campaign.deletedAt === null);

  /*
   * THE POSTS FILED UNDER THE CAMPAIGNS ON SCREEN, their slots, and the
   * pictures the cards show — scoped by workspace and brand like every other
   * read here.
   */
  const now = systemClock.now();
  const posts = await inWorkspace(workspace.workspaceId, async ({ db }) => {
    const scope =
      workspace.brandScope.length > 0 ? { brandId: { in: [...workspace.brandScope] } } : {};
    const items = await db.contentItem.findMany({
      where: {
        workspaceId: workspace.workspaceId,
        campaignId: { in: live.map((campaign) => campaign.id) },
        deletedAt: null,
        ...scope,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        title: true,
        status: true,
        campaignId: true,
        variants: { select: { assetIds: true }, orderBy: { createdAt: 'asc' }, take: 1 },
      },
      take: 2_000,
    });
    const slots =
      items.length === 0
        ? []
        : await db.calendarSlot.findMany({
            where: {
              workspaceId: workspace.workspaceId,
              contentItemId: { in: items.map((item) => item.id) },
              status: { not: 'CANCELLED' },
              scheduledAtUtc: { gt: new Date(now.getTime() - 40 * DAY_MS) },
            },
            orderBy: { scheduledAtUtc: 'asc' },
            select: {
              contentItemId: true,
              scheduledAtUtc: true,
              timezone: true,
              status: true,
            },
            take: 2_000,
          });
    const zone = await db.workspace.findUniqueOrThrow({
      where: { id: workspace.workspaceId },
      select: { timezone: true },
    });
    return { items, slots, timezone: zone.timezone };
  });

  const itemsOf = (campaignId: string) =>
    posts.items.filter((item) => item.campaignId === campaignId);
  const firstAsset = (item: (typeof posts.items)[number]) => item.variants[0]?.assetIds[0];
  const nextOf = (campaignId: string) => {
    const mine = new Set(itemsOf(campaignId).map((item) => item.id));
    const slot = posts.slots.find(
      (row) =>
        mine.has(row.contentItemId) &&
        row.scheduledAtUtc.getTime() > now.getTime() &&
        row.status !== 'PUBLISHED',
    );
    return slot ? { slot, item: posts.items.find((item) => item.id === slot.contentItemId) } : null;
  };
  const media = await mediaForVariants({
    workspaceId: workspace.workspaceId,
    userId: customer.userId,
    permissionKeys: workspace.permissionKeys,
    brandScope: workspace.brandScope,
    assetIds: campaigns.flatMap((campaign) => {
      const next = nextOf(campaign.id)?.item;
      return [...itemsOf(campaign.id).slice(0, 3), ...(next ? [next] : [])]
        .map(firstAsset)
        .filter((id): id is string => id !== undefined);
    }),
  });
  const pictureOf = (item: (typeof posts.items)[number] | undefined) => {
    const option = item ? media.get(firstAsset(item) ?? '') : undefined;
    return option?.previewToken && option.kind !== 'VIDEO'
      ? `/${locale}/assets/file/${option.previewToken}`
      : null;
  };

  /*
   * B11 (Phase 2B-2b, D-341) — THE BEST CAMPAIGN, over the brands this list
   * shows. An engagement figure is analytics, so it needs `analytics.read`, as
   * the campaign's own Performance section does; without it the tile is not
   * drawn at all rather than drawn empty.
   */
  const best =
    workspace.permissionKeys.includes('analytics.read') && brandContext.resolution.kind !== 'empty'
      ? await bestCampaign({
          workspaceId: workspace.workspaceId,
          brandId: effectiveBrand,
          brandScope: workspace.brandScope,
        })
      : null;
  const bestDetail =
    best?.kind === 'best' ? t('campaigns.best.detail').replace('{name}', best.name) : '';

  /* The hero's line: what is running, planned and ended, and what ends or starts next. */
  const daysBetween = (from: Date, to: Date) =>
    Math.max(0, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ending = live
    .filter((campaign) => campaign.status === 'ACTIVE' && campaign.endDate)
    .sort((a, b) => (a.endDate as Date).getTime() - (b.endDate as Date).getTime())[0];
  const starting = live
    .filter(
      (campaign) =>
        campaign.status === 'PLANNED' && campaign.startDate && campaign.startDate >= today,
    )
    .sort((a, b) => (a.startDate as Date).getTime() - (b.startDate as Date).getTime())[0];
  // A running campaign with no end date still runs: say so rather than "none".
  const running = live.find((campaign) => campaign.status === 'ACTIVE');
  const headline = ending
    ? daysBetween(today, ending.endDate as Date) === 0
      ? t('campaigns.hero.endsToday').replace('{name}', ending.name)
      : t('campaigns.hero.endsIn')
          .replace('{name}', ending.name)
          .replace('{days}', String(daysBetween(today, ending.endDate as Date)))
    : starting
      ? t('campaigns.hero.startsIn')
          .replace('{name}', starting.name)
          .replace('{days}', String(daysBetween(today, starting.startDate as Date)))
      : running
        ? t('campaigns.hero.running').replace('{name}', running.name)
        : t('campaigns.hero.none');
  const heroLine = t('campaigns.hero.line')
    .replace('{running}', String(countOf('ACTIVE')))
    .replace('{planned}', String(countOf('PLANNED')))
    .replace('{ended}', String(countOf('COMPLETED')));

  /* "Campaign posts this month": slots of campaign posts in this workspace month. */
  const month = workspaceMonthLabel(posts.timezone, now);
  const monthSlots = posts.slots.filter(
    (slot) => workspaceMonthLabel(slot.timezone, slot.scheduledAtUtc) === month,
  );
  const monthScheduled = monthSlots.filter(
    (slot) => slot.status === 'PLANNED' || slot.status === 'SCHEDULED',
  ).length;
  const monthPublished = monthSlots.filter((slot) => slot.status === 'PUBLISHED').length;

  const filterHref = (next: ListableStatus | undefined): string =>
    next ? `/${locale}/campaigns?status=${next}` : `/${locale}/campaigns`;
  // Round 3 (C2) — the prototype's one style: "Oct 16 · 10:00", 24-hour.
  const whenFormat = { format: (value: Date) => whenLabel(value, locale, posts.timezone) };

  return (
    <WorkspaceShell
      flash={successFlash(single('ok'), locale)}
      brandContext={brandContext}
      locale={locale}
      eyebrow={t('nav.group.plan')}
      heading={t('campaigns.title')}
      description={t('campaigns.subtitle')}
      activePath="/campaigns"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {single('error') && (
        <CustomerBanner tone="error">
          {statusMessage(single('error'), locale, single('ref'))}
        </CustomerBanner>
      )}

      <div className="bsp-camp">
        {/* ------------------------------------------------- the hero --- */}
        <section className="bsp-camp-hero" data-testid="campaign-kpis">
          <div className="bsp-camp-hero-copy">
            <span className="bsp-pill bsp-camp-hero-sub">{heroLine}</span>
            <div className="bsp-camp-hero-h">{headline}</div>
            {mayManage ? (
              <Link
                href={`/${locale}/campaigns/new`}
                className="bsp-btn bsp-sm bsp-camp-hero-new"
                data-testid="campaign-new"
              >
                + {t('campaigns.new')}
              </Link>
            ) : null}
          </div>
          <div className="bsp-camp-stats">
            <div className="bsp-camp-stat" data-testid="campaign-month">
              <span className="bsp-camp-stat-l">{t('campaigns.hero.month')}</span>
              <span className="bsp-ltr bsp-xnum bsp-camp-stat-v">{monthSlots.length}</span>
              <span className="bsp-camp-stat-s">
                {t('campaigns.hero.monthSub')
                  .replace('{scheduled}', String(monthScheduled))
                  .replace('{published}', String(monthPublished))}
              </span>
            </div>
            {best ? (
              <div className="bsp-camp-stat" data-testid="campaign-best">
                <span className="bsp-camp-stat-l">{t('campaigns.best.label')}</span>
                {best.kind === 'best' ? (
                  <>
                    <span className="bsp-ltr bsp-xnum bsp-camp-stat-v bsp-camp-stat-best">
                      {formatRateMilli(best.rateMilli, locale)}
                    </span>
                    <span className="bsp-camp-stat-s bsp-camp-ellipsis" title={bestDetail}>
                      {bestDetail}
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className="bsp-ltr bsp-xnum bsp-camp-stat-v bsp-camp-stat-none"
                      data-testid="campaign-best-unavailable"
                    >
                      —
                    </span>
                    <span className="bsp-camp-stat-s">{t('campaigns.best.none')}</span>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </section>

        {/*
          THE STATUS SWITCH — links, not a control, so a filtered view is a
          shareable URL and the back button means what a reader expects.
        */}
        <nav
          className="bsp-seg bsp-camp-tabs"
          aria-label={t('campaigns.filterStatus')}
          data-testid="campaign-filters"
        >
          <SegmentPill selector='[aria-current="page"]' />
          <Link
            href={filterHref(undefined)}
            aria-current={status === undefined ? 'page' : undefined}
          >
            {t('campaigns.filterAll')} <span className="bsp-ltr bsp-camp-count">{live.length}</span>
          </Link>
          {/*
            Round 3 (C5) — the prototype's four tabs are always there (Running ·
            Paused · Planned · Ended); the product's draft and archived appear
            when they have campaigns.
          */}
          {LISTABLE.filter(
            (value) =>
              (PROTOTYPE_ORDER as readonly string[]).includes(value) ||
              countOf(value) > 0 ||
              value === status,
          ).map((value) => (
            <Link
              key={value}
              href={filterHref(value)}
              aria-current={status === value ? 'page' : undefined}
              data-testid={`campaign-filter-${value}`}
            >
              {statusLabel(t, value)}{' '}
              <span className="bsp-ltr bsp-camp-count">{countOf(value)}</span>
            </Link>
          ))}
        </nav>

        {campaigns.length === 0 ? (
          brandContext.resolution.kind === 'empty' ? (
            /*
             * D-299 — `empty` means the workspace has NO brand, so "choose one"
             * was wrong: the next step is to create one.
             */
            <StateMessage
              kind="empty"
              title={t('brand.emptyTitle')}
              description={t('campaigns.noBrandBody')}
              testId="campaigns-no-brand"
              action={
                workspace.permissionKeys.includes('brand.manage') ? (
                  <EmptyAction
                    href={`/${locale}/brand-brain`}
                    label={t('bb.createBrand')}
                    testId="campaigns-empty-create-brand"
                  />
                ) : undefined
              }
            />
          ) : (
            <div className="bsp-card bsp-camp-empty" data-testid="campaigns-empty">
              <b>{t('campaigns.emptyTitle')}</b>
              <span>{t('campaigns.emptyBody')}</span>
              {mayManage ? (
                <Link
                  href={`/${locale}/campaigns/new`}
                  className="bsp-btn bsp-sm bsp-pur bsp-camp-start"
                  data-testid="campaigns-empty-create"
                >
                  {t('campaigns.emptyAction')}
                </Link>
              ) : null}
            </div>
          )
        ) : (
          <div className="bsp-camp-grid" data-testid="campaign-list">
            {campaigns.map((campaign) => {
              const items = itemsOf(campaign.id);
              const published = items.filter(
                (item) => item.status === 'PUBLISHED' || item.status === 'PARTIALLY_PUBLISHED',
              ).length;
              const paused = campaign.status === 'PAUSED';
              const next = nextOf(campaign.id);
              const covers = [0, 1, 2].map((index) => items[index]);
              const seed = (id: string) => (id.charCodeAt(0) % 6) as MediaSeed;
              const pct = items.length === 0 ? 0 : Math.round((published / items.length) * 100);
              return (
                <section
                  key={campaign.id}
                  className="bsp-lift bsp-camp-card"
                  data-paused={paused ? 'true' : undefined}
                  data-testid={`campaign-row-${campaign.id}`}
                >
                  <div className="bsp-camp-covers">
                    {covers.map((item, index) => (
                      <span key={index} className={`bsp-camp-cover bsp-camp-cover-${index}`}>
                        {item ? (
                          pictureOf(item) ? (
                            <AssetMedia src={pictureOf(item) as string} alt="" />
                          ) : (
                            <AbstractMedia seed={seed(item.id)} alt="" />
                          )
                        ) : null}
                        {index === 2 && items.length > 3 ? (
                          <span className="bsp-ltr bsp-camp-more">+{items.length - 3}</span>
                        ) : null}
                      </span>
                    ))}
                    <span className="bsp-camp-chip" data-testid={`campaign-status-${campaign.id}`}>
                      <span className={`bsp-camp-dot ${DOT[campaign.status] ?? ''}`} />
                      {statusLabel(t, campaign.status)}
                    </span>
                    {items.length === 0 ? (
                      <span className="bsp-camp-noposts">{t('campaigns.card.noPosts')}</span>
                    ) : null}
                  </div>
                  <div className="bsp-camp-body">
                    <div className="bsp-camp-head">
                      <span className="bsp-camp-name" dir="auto">
                        {campaign.name}
                      </span>
                      <div className="bsp-camp-meta">
                        <CalendarIcon />
                        <span>
                          {periodLabel(
                            campaign.startDate,
                            campaign.endDate,
                            locale,
                            t('campaigns.noDates'),
                          )}
                        </span>
                        {campaign.channels.length > 0 ? (
                          <span className="bsp-camp-marks">
                            {campaign.channels.map((raw) => {
                              /*
                               * A stored key in another case still names its
                               * platform, and one with no translation is named
                               * by itself rather than not at all.
                               */
                              const key = raw.toLowerCase();
                              return (
                                <ChannelMark
                                  key={raw}
                                  channel={{
                                    key,
                                    name:
                                      optionalMessage(messageLocale, `content.platform.${key}`) ??
                                      raw,
                                  }}
                                  size={13}
                                />
                              );
                            })}
                          </span>
                        ) : null}
                        <span className="bsp-xstatus bsp-neu">
                          {objectiveLabel(t, campaign.objective)}
                        </span>
                      </div>
                    </div>
                    <div className="bsp-camp-progress">
                      <div className="bsp-camp-bar" aria-hidden="true">
                        <div style={{ width: `${pct}%` }} />
                      </div>
                      <span className="bsp-camp-ratio">
                        {campaign.status === 'COMPLETED'
                          ? t('campaigns.card.allPublished')
                          : t('campaigns.card.published')}{' '}
                        <span className="bsp-ltr">
                          {published} / {items.length}
                        </span>
                      </span>
                    </div>
                    {next ? (
                      <div className="bsp-camp-next">
                        <span className="bsp-camp-next-art" aria-hidden="true">
                          {pictureOf(next.item) ? (
                            <AssetMedia src={pictureOf(next.item) as string} alt="" />
                          ) : (
                            <AbstractMedia seed={seed(next.slot.contentItemId)} alt="" />
                          )}
                        </span>
                        <span className="bsp-camp-next-copy">
                          <span className="bsp-camp-next-l">{t('campaigns.card.next')}</span>
                          <span className="bsp-camp-next-t" dir="auto">
                            {next.item?.title ?? '—'} ·{' '}
                            {whenFormat.format(next.slot.scheduledAtUtc)}
                          </span>
                        </span>
                      </div>
                    ) : null}
                    <div className="bsp-camp-foot">
                      <Link
                        href={`/${locale}/campaigns/${campaign.id}`}
                        className="bsp-camp-open"
                        data-testid={`campaign-open-${campaign.id}`}
                        aria-label={`${t('campaigns.card.open')} — ${campaign.name}`}
                      >
                        {t('campaigns.card.open')} <span className="bsp-camp-arrow">→</span>
                      </Link>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.25" y="5" width="17.5" height="16" rx="2" />
      <path d="M3.25 9.5h17.5M8 3v4M16 3v4" />
    </svg>
  );
}
