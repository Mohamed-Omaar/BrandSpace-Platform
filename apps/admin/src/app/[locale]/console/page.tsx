import Link from 'next/link';
import { CONFIG_DOMAIN_KEYS } from '@brandspace/config';
import { evaluateHealth, tracingStatus } from '@brandspace/observability';
import {
  Card,
  ContentGrid,
  HeroFloatCard,
  MetricCard,
  OverviewHero,
  Stack,
  buttonStyle,
  colorTokens,
} from '@brandspace/ui';
import { PageIntro } from '../../../components/admin-shell';
import { translator } from '../../../i18n/messages';
import { SimpleHome } from '../../../components/simple/home';
import { getConsoleMode } from '../../../server/console-mode-cookie';
import {
  currentEnvironment,
  getConfigService,
  getIntegrationsService,
  getSecretService,
  getWorkspaceService,
  requirePageActor,
  serviceActor,
} from '../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * Home / Overview — real counts from the platform database, not placeholders.
 *
 * ONE ROUTE, TWO PRESENTATIONS (D-307). Simple mode renders the owner's home;
 * Advanced renders the technical overview below, unchanged. The guard runs
 * first and is the same for both.
 */
export default async function OverviewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = translator(locale);
  // Every admin-capable role may see the overview. WHAT it shows depends on the
  // actor's permissions: a role that may not read secrets does not learn how
  // many exist from a summary tile.
  const actor = await requirePageActor(locale, 'platform.workspace.read');
  if ((await getConsoleMode()) === 'simple') return <SimpleHome locale={locale} actor={actor} />;
  const mayReadConfig = actor.permissionKeys.includes('platform.configuration.read');
  const mayReadSecrets = actor.permissionKeys.includes('platform.secret.read');

  const environment = currentEnvironment();
  const config = getConfigService();
  const secrets = getSecretService();
  const workspaceService = getWorkspaceService();

  const [workspaces, secretCount, activeDomains] = await Promise.all([
    workspaceService.list(serviceActor(actor), {}),
    // F-53: a COUNT, not a listing. This tile needs one integer, and reading
    // every record with its active version to take `.length` of them was the
    // same unbounded-read defect in its purest form.
    mayReadSecrets ? secrets.countSecrets(serviceActor(actor), { environment }) : 0,
    mayReadConfig
      ? Promise.all(
          CONFIG_DOMAIN_KEYS.map(async (domain) => ({
            domain,
            versions: await config.listVersions(serviceActor(actor), domain, environment),
          })),
        )
      : [],
  ]);

  /*
   * PHASE 10 — the operational half of this screen.
   *
   * `evaluateHealth` is the SAME function `/health/ready` feeds, so the word on
   * this card and the word an orchestrator reads cannot drift apart. The
   * integration gaps come from the Hub's own computation for the same reason.
   */
  const tracing = tracingStatus();
  const readiness = evaluateHealth([
    { name: 'database', state: 'ok', required: true },
    {
      name: 'tracing',
      state: tracing.exporting ? 'ok' : 'not_configured',
      required: false,
      capability: 'observability',
    },
  ]);
  const integrationGaps = mayReadConfig
    ? await getIntegrationsService().productionGaps(serviceActor(actor), environment)
    : [];

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
      value: mayReadSecrets ? String(secretCount) : undefined,
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
      <PageIntro
        description={
          locale === 'ar'
            ? 'حالة إعدادات المنصة والمفاتيح السرية في هذه البيئة.'
            : 'Configuration and secret state for this environment.'
        }
      />
      <Stack>
        {/*
          THE CONTROL CENTER'S HERO (§24), at the demo's geometry: a label pill,
          the display heading, a line of body copy, two actions and two floating
          cards. Both actions lead to real console routes. The status card says
          plainly that operational telemetry is not wired rather than claiming
          "all systems operational"; the workspace count is a real count.
        */}
        <OverviewHero
          eyebrow={t('console.hero.eyebrow')}
          title={t('console.hero.title')}
          description={t('console.hero.body')}
          primaryAction={
            <Link
              href={`/${locale}/console/workspaces`}
              style={buttonStyle('primary')}
              data-testid="console-hero-primary"
            >
              {t('console.hero.primary')}
            </Link>
          }
          secondaryAction={
            <Link
              href={`/${locale}/console/health`}
              data-testid="console-hero-secondary"
              style={{
                ...buttonStyle('ghost'),
                background: 'transparent',
                color: colorTokens.textPrimary,
              }}
            >
              {t('console.hero.secondary')}
            </Link>
          }
          visual={
            <>
              <HeroFloatCard
                placement="end"
                title={t('console.float.status')}
                detail={t('console.float.statusDetail')}
              />
              <HeroFloatCard
                placement="start"
                title={t('console.float.workspaces')}
                detail={String(workspaces.total)}
              />
            </>
          }
        />
        <ContentGrid min="10rem" testId="overview-stats">
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
          PHASE 10 — REAL OPERATIONAL STATE, and the end of "a later phase".

          This card used to say "operational indicators appear here once
          telemetry is wired in a later phase". Phase 10 is that phase, so the
          promise is replaced by the thing it promised: the same readiness
          verdict `/health/ready` returns, and the integration categories that
          are required in production with nobody serving them.

          IT STILL SHOWS ONLY WHAT IT ACTUALLY KNOWS. Request volume and queue
          depth need a metrics backend nobody has chosen (D-217), and an empty
          chart would be the fake-success state this phase exists to remove.
          What is here is computed, not decorative.
        */}
        <Card title={locale === 'ar' ? 'صحة المنصة' : 'Platform health'} testId="overview-health">
          <ContentGrid min="12rem" testId="overview-health-metrics">
            <MetricCard
              testId="health-readiness"
              label={locale === 'ar' ? 'الجاهزية' : 'Readiness'}
              value={readiness.status}
              accent={readiness.status !== 'ready'}
            />
            <MetricCard
              testId="health-degraded"
              label={locale === 'ar' ? 'قدرات متأثرة' : 'Degraded capabilities'}
              value={
                readiness.degradedCapabilities.length === 0
                  ? locale === 'ar'
                    ? 'لا شيء'
                    : 'None'
                  : readiness.degradedCapabilities.join(', ')
              }
            />
            <MetricCard
              testId="health-integration-gaps"
              label={locale === 'ar' ? 'تكاملات إنتاج ناقصة' : 'Production integration gaps'}
              value={mayReadConfig ? String(integrationGaps.length) : undefined}
              unavailable={!mayReadConfig}
              unavailableLabel={
                locale === 'ar'
                  ? 'لا تملك صلاحية عرض هذه القيمة'
                  : 'You do not have permission to see this'
              }
              accent={integrationGaps.length > 0}
            />
          </ContentGrid>
        </Card>
      </Stack>
    </>
  );
}
