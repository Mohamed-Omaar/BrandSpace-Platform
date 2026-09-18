import Link from 'next/link';
import {
  Card,
  Cell,
  DataTable,
  Row,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  spacingTokens,
  statusTone,
  typographyTokens,
} from '@brandspace/ui';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, brandFilterFor } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
import { statusMessage, translator } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { CAMPAIGN_STATUSES } from '../../../server/campaign-form';
import { objectiveLabel, periodLabel, statusLabel } from './labels';

export const dynamic = 'force-dynamic';

/**
 * CAMPAIGNS — the customer surface over the Phase 7 domain (D-195, AC-26).
 *
 * WHY THIS SCREEN DID NOT EXIST UNTIL NOW. `Campaign` has been a real table
 * since Phase 7, written by the Copilot and read by analytics and automations —
 * a dimension the product could reason about but nobody could open. Phase 8
 * gives it a door.
 *
 * NO REFERENCE, SO THE DESIGN SYSTEM DECIDES (CLAUDE.md §4.2). The approved
 * demo has no campaigns route at all. This is composed from what already ships:
 * `PageHeader` through the shell, `RecordList` as the Assets and Members
 * screens use it, `StatusBadge` for the lifecycle, and the same filter links
 * the content library uses. Nothing new was drawn.
 *
 * BRAND-OR-ALL (D-192). A multi-brand owner's campaigns are worth seeing
 * together, and a brand on the rail narrows them. "All brands" means the brands
 * THIS MEMBER may access, which is what `brandIdQueryFilter` puts in the WHERE.
 */
const LISTABLE = [...CAMPAIGN_STATUSES, 'ARCHIVED'] as const;
type ListableStatus = (typeof LISTABLE)[number];

export default async function CampaignsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'campaigns.read');

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
  const includeArchived = single('archived') === '1' || status === 'ARCHIVED';

  const mayManage = workspace.permissionKeys.includes('campaigns.manage');

  const campaigns = await inContentStudio(workspace.workspaceId, async (services) =>
    services.campaigns().list({
      ...(effectiveBrand ? { brandId: effectiveBrand } : {}),
      ...(status ? { statuses: [status] } : {}),
      includeArchived,
      brandScope: workspace.brandScope,
      take: 100,
    }),
  );

  const filterHref = (next: Record<string, string | undefined>): string => {
    const params = new URLSearchParams();
    const current: Record<string, string | undefined> = {
      status,
      archived: includeArchived ? '1' : undefined,
      ...next,
    };
    for (const [key, value] of Object.entries(current)) {
      if (value !== undefined && value !== '') params.set(key, value);
    }
    const rest = params.toString();
    return rest === '' ? `/${locale}/campaigns` : `/${locale}/campaigns?${rest}`;
  };

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('campaigns.title')}
      description={t('campaigns.subtitle')}
      activePath="/campaigns"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
      actions={
        mayManage ? (
          <Link
            href={`/${locale}/campaigns/new`}
            style={buttonStyle('brand')}
            data-testid="campaign-new"
          >
            {t('campaigns.new')}
          </Link>
        ) : null
      }
    >
      {single('error') && (
        <CustomerBanner tone="error">
          {statusMessage(single('error'), locale, single('ref'))}
        </CustomerBanner>
      )}
      {single('ok') && statusMessage(single('ok'), locale) && (
        <CustomerBanner tone="success">{statusMessage(single('ok'), locale)}</CustomerBanner>
      )}

      {/*
        THE SAME FILTER ROW THE CONTENT LIBRARY USES — links, not a control,
        so a filtered view is a shareable URL and the back button means what a
        reader expects.
      */}
      <nav
        aria-label={t('campaigns.filterStatus')}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: spacingTokens.xs,
          marginBlockEnd: spacingTokens.md,
        }}
        data-testid="campaign-filters"
      >
        <FilterLink href={filterHref({ status: undefined })} current={status === undefined}>
          {t('campaigns.filterAll')}
        </FilterLink>
        {LISTABLE.map((value) => (
          <FilterLink
            key={value}
            href={filterHref({ status: value })}
            current={status === value}
            testId={`campaign-filter-${value}`}
          >
            {statusLabel(t, value)}
          </FilterLink>
        ))}
      </nav>

      {campaigns.length === 0 ? (
        brandContext.resolution.kind === 'empty' ? (
          <StateMessage
            kind="empty"
            title={t('campaigns.chooseBrandTitle')}
            description={t('campaigns.chooseBrandBody')}
            testId="campaigns-no-brand"
          />
        ) : (
          <StateMessage
            kind="empty"
            title={t('campaigns.emptyTitle')}
            description={t('campaigns.emptyBody')}
            testId="campaigns-empty"
          />
        )
      ) : (
        <Card testId="campaign-list">
          <DataTable
            headers={[
              t('campaigns.name'),
              t('campaigns.objective'),
              t('campaigns.dates'),
              t('campaigns.channels'),
              t('campaigns.status'),
            ]}
            caption={t('campaigns.title')}
            testId="campaigns-table"
          >
            {campaigns.map((campaign) => (
              <Row key={campaign.id} testId={`campaign-row-${campaign.id}`}>
                <Cell>
                  <Link
                    href={`/${locale}/campaigns/${campaign.id}`}
                    data-testid={`campaign-open-${campaign.id}`}
                    style={{ color: colorTokens.brandPurple, fontWeight: 600 }}
                  >
                    {campaign.name}
                  </Link>
                </Cell>
                <Cell>{objectiveLabel(t, campaign.objective)}</Cell>
                <Cell>
                  {periodLabel(
                    campaign.startDate,
                    campaign.endDate,
                    locale,
                    t('campaigns.noDates'),
                  )}
                </Cell>
                <Cell>
                  {campaign.channels.length === 0
                    ? t('campaigns.noChannels')
                    : campaign.channels.join(' · ')}
                </Cell>
                <Cell>
                  <StatusBadge
                    tone={statusTone(campaign.status)}
                    label={statusLabel(t, campaign.status)}
                    testId={`campaign-status-${campaign.id}`}
                  />
                </Cell>
              </Row>
            ))}
          </DataTable>
        </Card>
      )}
    </WorkspaceShell>
  );
}

/**
 * One filter chip.
 *
 * `aria-current="page"` rather than colour alone, because a filter a screen
 * reader cannot report the state of is a filter only some readers have.
 */
function FilterLink({
  href,
  current,
  children,
  testId,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly children: React.ReactNode;
  readonly testId?: string;
}) {
  return (
    <Link
      href={href}
      {...(current ? { 'aria-current': 'page' as const } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
      style={{
        ...typographyTokens.bodySm,
        paddingBlock: spacingTokens.xs,
        paddingInline: spacingTokens.sm,
        borderRadius: '999px',
        textDecoration: 'none',
        background: current ? colorTokens.brandPurpleTint : colorTokens.surfaceMuted,
        color: current ? colorTokens.brandPurple : colorTokens.textSecondary,
        fontWeight: current ? 600 : 500,
      }}
    >
      {children}
    </Link>
  );
}
