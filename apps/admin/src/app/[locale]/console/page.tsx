import { CONFIG_DOMAIN_KEYS } from '@brandspace/config';
import { spacingTokens, colorTokens } from '@brandspace/ui';
import { PageHeading } from '../../../components/admin-shell';
import {
  currentEnvironment,
  getConfigService,
  getSecretService,
  requirePageActor,
  serviceActor,
} from '../../../server/platform-context';

export const dynamic = 'force-dynamic';

/** Overview — real counts from the platform database, not placeholders. */
export default async function OverviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  // Every admin-capable role may see the overview. WHAT it shows depends on the
  // actor's permissions: a role that may not read secrets does not learn how
  // many exist from a summary tile.
  const actor = await requirePageActor(locale, 'platform.workspace.read');
  const mayReadConfig = actor.permissionKeys.includes('platform.configuration.read');
  const mayReadSecrets = actor.permissionKeys.includes('platform.secret.read');

  const environment = currentEnvironment();
  const config = getConfigService();
  const secrets = getSecretService();

  const [secretList, activeDomains] = await Promise.all([
    mayReadSecrets ? secrets.listSecrets(serviceActor(actor), { environment }) : [],
    mayReadConfig
      ? Promise.all(
          CONFIG_DOMAIN_KEYS.map(async (domain) => ({
            domain,
            versions: await config.listVersions(serviceActor(actor), domain, environment),
          })),
        )
      : [],
  ]);

  const activated = activeDomains.filter((d) => d.versions.some((v) => v.status === 'ACTIVE'));
  const drafts = activeDomains.flatMap((d) => d.versions.filter((v) => v.status === 'DRAFT'));
  const withheld = locale === 'ar' ? '—' : '—';

  const stats = [
    {
      label: locale === 'ar' ? 'مجالات مُفعّلة' : 'Activated domains',
      value: mayReadConfig ? `${activated.length} / ${CONFIG_DOMAIN_KEYS.length}` : withheld,
      testid: 'stat-active-domains',
    },
    {
      label: locale === 'ar' ? 'مسودات معلّقة' : 'Pending drafts',
      value: mayReadConfig ? String(drafts.length) : withheld,
      testid: 'stat-drafts',
    },
    {
      label: locale === 'ar' ? 'مفاتيح سرية' : 'Stored secrets',
      value: mayReadSecrets ? String(secretList.length) : withheld,
      testid: 'stat-secrets',
    },
    {
      label: locale === 'ar' ? 'البيئة' : 'Environment',
      value: environment,
      testid: 'stat-environment',
    },
  ];

  return (
    <>
      <PageHeading
        title={locale === 'ar' ? 'نظرة عامة' : 'Overview'}
        description={
          locale === 'ar'
            ? 'حالة إعدادات المنصة والمفاتيح السرية في هذه البيئة.'
            : 'Configuration and secret state for this environment.'
        }
      />
      <div
        style={{
          display: 'grid',
          gap: spacingTokens.md,
          // `min(12rem, 100%)` so a narrow column collapses the cards rather
          // than forcing 12rem of content into less space than that.
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(12rem, 100%), 1fr))',
        }}
      >
        {stats.map((stat) => (
          <div
            key={stat.testid}
            data-testid={stat.testid}
            style={{
              border: `1px solid ${colorTokens.border}`,
              borderRadius: '0.5rem',
              padding: spacingTokens.md,
            }}
          >
            <div style={{ color: colorTokens.textSecondary, fontSize: '0.875rem' }}>
              {stat.label}
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 600 }}>{stat.value}</div>
          </div>
        ))}
      </div>
    </>
  );
}
