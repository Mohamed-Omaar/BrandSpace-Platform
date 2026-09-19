import { evaluateHealth, tracingStatus, type DependencyCheck } from '@brandspace/observability';
import { INTEGRATION_CATEGORY_DEFINITIONS } from '@brandspace/integrations';
import {
  SectionHeader,
  colorTokens,
  fontTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { Cell, DataTable, PageIntro } from '../../../../components/admin-shell';
import {
  currentEnvironment,
  getPlatformPrisma,
  requirePageActor,
} from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * System health and observability status.
 *
 * Reports what is ACTUALLY configured. When OTLP export is not configured it
 * says so plainly rather than showing a green tick — a health page that lies is
 * worse than no health page.
 */
export default async function HealthPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  // Basic health is visible to every admin-capable role; the provider
  // inventory is configuration, so it needs the configuration read permission.
  const actor = await requirePageActor(locale, 'platform.workspace.read');
  const mayReadConfig = actor.permissionKeys.includes('platform.configuration.read');
  const environment = currentEnvironment();
  const isArabic = locale === 'ar';

  const tracing = tracingStatus();

  let databaseOk = false;
  let databaseRole = 'unknown';
  try {
    const rows = await getPlatformPrisma().$queryRaw<{ current_user: string }[]>`
      SELECT current_user`;
    databaseRole = rows[0]?.current_user ?? 'unknown';
    databaseOk = true;
  } catch {
    databaseOk = false;
  }

  /*
   * PHASE 10 — THE SAME VERDICT THE READINESS PROBE REACHES.
   *
   * `evaluateHealth` decides what a set of probe answers means, and both this
   * screen and `/health/ready` feed it. Two screens computing "is this healthy"
   * from two similar-looking rules is how an orchestrator and an operator come
   * to disagree about whether the platform is up.
   *
   * WHAT THIS SCREEN ADDS over the public probe is DETAIL — the role the
   * database answered as, the collector host, the reason a category is not
   * configured. None of that is in the public response, because it describes
   * how the platform is assembled to anybody who can reach a URL.
   */
  const dependencies: DependencyCheck[] = [
    {
      name: 'database',
      state: databaseOk ? 'ok' : 'down',
      required: true,
      detail: databaseRole,
    },
    {
      name: 'tracing',
      state: tracing.exporting ? 'ok' : 'not_configured',
      required: false,
      capability: 'observability',
      detail: tracing.exporting
        ? // Host only — an endpoint URL can embed credentials.
          (tracing.endpointHost ?? 'configured')
        : isArabic
          ? 'غير مُهيّأ (التتبع يعمل محليًا دون تصدير)'
          : 'Not configured (spans are created locally, nothing is exported)',
    },
  ];

  const report = evaluateHealth(dependencies);

  const checks = [
    ...report.checks.map((check) => ({
      name:
        check.name === 'database'
          ? isArabic
            ? 'قاعدة البيانات (هوية المنصة)'
            : 'Database (platform identity)'
          : isArabic
            ? 'تصدير التتبع'
            : 'Trace export',
      status: check.state === 'ok' ? 'ok' : check.state === 'down' ? 'error' : 'off',
      detail: check.detail ?? '—',
      testid: `health-${check.name}`,
    })),
    {
      name: isArabic ? 'تهيئة التتبع' : 'Tracing initialised',
      status: tracing.initialized ? 'ok' : 'off',
      detail: tracing.serviceName,
      testid: 'health-tracing',
    },
    {
      name: isArabic ? 'الجاهزية الإجمالية' : 'Overall readiness',
      status: report.status === 'ready' ? 'ok' : report.status === 'degraded' ? 'off' : 'error',
      detail:
        report.degradedCapabilities.length > 0
          ? report.degradedCapabilities.join(', ')
          : isArabic
            ? 'كل الاعتماديات المطلوبة تستجيب'
            : 'Every required dependency is answering',
      testid: 'health-readiness',
    },
    {
      name: isArabic ? 'البيئة' : 'Environment',
      status: 'ok',
      detail: environment,
      testid: 'health-environment',
    },
  ];

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? 'حالة فعلية للاعتماديات. الحالة "غير مُهيّأ" تعني أنها فعلاً غير مُهيّأة.'
            : 'Real dependency status. "Not configured" means exactly that.'
        }
      />

      <DataTable
        headers={[
          isArabic ? 'الفحص' : 'Check',
          isArabic ? 'الحالة' : 'Status',
          isArabic ? 'التفاصيل' : 'Detail',
        ]}
      >
        {checks.map((check) => (
          <tr key={check.testid} data-testid={check.testid}>
            <Cell>{check.name}</Cell>
            <Cell>
              <span
                style={{
                  color:
                    check.status === 'ok'
                      ? colorTokens.success
                      : check.status === 'off'
                        ? colorTokens.warning
                        : colorTokens.danger,
                  fontWeight: 600,
                }}
              >
                {check.status.toUpperCase()}
              </span>
            </Cell>
            <Cell>{check.detail}</Cell>
          </tr>
        ))}
      </DataTable>

      {mayReadConfig ? (
        <>
          <div style={{ marginBlockStart: spacingTokens.xl }}>
            <SectionHeader
              title={isArabic ? 'فئات التكامل' : 'Integration categories'}
              description={
                isArabic
                  ? 'ما تحتاجه المنصة فعلًا في الإنتاج، وما تعمل بدونه. التفاصيل والاتصال في صفحة التكاملات.'
                  : 'What the platform actually requires in production, and what it runs without. Detail and connection status live on the Integrations page.'
              }
            />
          </div>
          <DataTable
            headers={[
              isArabic ? 'الفئة' : 'Category',
              isArabic ? 'مطلوبة في الإنتاج' : 'Required in production',
              isArabic ? 'مصدر الإعداد' : 'Configured in',
            ]}
          >
            {INTEGRATION_CATEGORY_DEFINITIONS.map((category) => (
              <tr key={category.key} data-testid={`integration-category-${category.key}`}>
                <Cell>{isArabic ? category.labelAr : category.labelEn}</Cell>
                <Cell>
                  <span
                    style={{
                      color: category.requiredInProduction
                        ? colorTokens.textPrimary
                        : colorTokens.textMuted,
                      fontWeight: category.requiredInProduction ? 600 : 400,
                    }}
                  >
                    {category.requiredInProduction
                      ? isArabic
                        ? 'نعم'
                        : 'Yes'
                      : isArabic
                        ? 'لا'
                        : 'No'}
                  </span>
                </Cell>
                <Cell>
                  <code style={{ ...typographyTokens.caption, fontFamily: fontTokens.mono }}>
                    {category.configDomain}
                  </code>
                </Cell>
              </tr>
            ))}
          </DataTable>
        </>
      ) : null}
    </>
  );
}
