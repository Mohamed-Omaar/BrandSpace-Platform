import Link from 'next/link';
import { StateMessage, buttonStyle, spacingTokens } from '@brandspace/ui';
import { requireWorkspace } from '../../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../../server/brand-context';
import { inContentStudio } from '../../../../server/content-context';
import { statusMessage, translator } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import { createCampaignAction } from '../actions';
import { CampaignFormView } from '../campaign-form-view';
import { formLabels } from '../labels';

export const dynamic = 'force-dynamic';

/**
 * CREATE A CAMPAIGN (AC-26.1).
 *
 * BRAND-SCOPED, AND IT ASKS RATHER THAN GUESSING (D-191). A campaign belongs to
 * exactly one brand, so this route is declared `brand` in the scope table: with
 * a sole accessible brand it resolves to that brand, and with two or more and
 * nothing selected it shows the choose-a-brand state instead of filing the
 * campaign under whichever brand sorted first.
 */
export default async function NewCampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'campaigns.manage');

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const brandContext = await brandContextFor(workspace, '/campaigns/new', single('brand'));
  const selected = requiredBrand(brandContext);

  const platforms = await inContentStudio(workspace.workspaceId, async (services) => {
    const policy = await services.policy();
    return policy.platforms.map((platform) => ({ key: platform.key, label: platform.key }));
  });

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('campaigns.new')}
      description={t('campaigns.subtitle')}
      activePath="/campaigns"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
      actions={
        <Link
          href={`/${locale}/campaigns`}
          style={buttonStyle('neutral')}
          data-testid="campaign-back"
        >
          {t('campaigns.back')}
        </Link>
      }
    >
      {single('error') && (
        <CustomerBanner tone="error">
          {statusMessage(single('error'), locale, single('ref'))}
        </CustomerBanner>
      )}

      {selected === null ? (
        <StateMessage
          kind="empty"
          title={
            brandContext.resolution.kind === 'empty'
              ? t('brand.emptyTitle')
              : t('campaigns.chooseBrandTitle')
          }
          description={
            brandContext.resolution.kind === 'empty'
              ? t('brand.emptyBody')
              : t('campaigns.chooseBrandBody')
          }
          testId="campaign-no-brand"
        />
      ) : (
        <div style={{ display: 'grid', gap: spacingTokens.md }}>
          <CampaignFormView
            action={createCampaignAction}
            hidden={{ locale, brandId: selected.id }}
            values={{
              name: '',
              objective: 'AWARENESS',
              briefAr: '',
              briefEn: '',
              description: '',
              startDate: '',
              endDate: '',
              channels: [],
              status: 'DRAFT',
            }}
            labels={formLabels(t, t('campaigns.create'))}
            platforms={platforms}
            withStatus={false}
            testId="campaign-create-form"
          />
        </div>
      )}
    </WorkspaceShell>
  );
}
