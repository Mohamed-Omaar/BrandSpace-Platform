import { CONFIG_DOMAIN_KEYS } from '@brandspace/config';
import { Card, ContentGrid, MetricCard, Stack, StateMessage } from '@brandspace/ui';
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
  const stats = [
    {
      label: locale === 'ar' ? 'مجالات مُفعّلة' : 'Activated domains',
      value: mayReadConfig ? `${activated.length} / ${CONFIG_DOMAIN_KEYS.length}` : undefined,
      withheld: !mayReadConfig,
      testid: 'stat-active-domains',
    },
    {
      label: locale === 'ar' ? 'مسودات معلّقة' : 'Pending drafts',
      value: mayReadConfig ? String(drafts.length) : undefined,
      withheld: !mayReadConfig,
      testid: 'stat-drafts',
    },
    {
      label: locale === 'ar' ? 'مفاتيح سرية' : 'Stored secrets',
      value: mayReadSecrets ? String(secretList.length) : undefined,
      withheld: !mayReadSecrets,
      testid: 'stat-secrets',
    },
    {
      label: locale === 'ar' ? 'البيئة' : 'Environment',
      value: environment,
      withheld: false,
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
      <Stack>
        <ContentGrid min="12rem" testId="overview-stats">
          {stats.map((stat) => (
            <MetricCard
              key={stat.testid}
              testId={stat.testid}
              label={stat.label}
              value={stat.value}
              unavailable={stat.withheld}
              // A withheld figure says so. Rendering a zero for a role that may
              // not read secrets would state, falsely, that none exist.
              unavailableLabel={
                locale === 'ar'
                  ? 'لا تملك صلاحية عرض هذه القيمة'
                  : 'You do not have permission to see this'
              }
              accent={stat.testid === 'stat-environment'}
            />
          ))}
        </ContentGrid>

        {/*
          Operational metrics — request volume, job queues, provider health —
          need telemetry that no phase has wired to this screen. The card says
          so instead of showing a chart with no data behind it.
        */}
        <Card title={locale === 'ar' ? 'صحة المنصة' : 'Platform health'} testId="overview-health">
          <StateMessage
            title={locale === 'ar' ? 'لا توجد مقاييس بعد' : 'No metrics yet'}
            description={
              locale === 'ar'
                ? 'ستظهر مؤشرات التشغيل هنا بعد ربط التتبّع في مرحلة لاحقة.'
                : 'Operational indicators appear here once telemetry is wired in a later phase.'
            }
          />
        </Card>
      </Stack>
    </>
  );
}
