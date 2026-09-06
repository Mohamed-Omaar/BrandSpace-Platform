import { tracingStatus } from '@brandspace/observability';
import { ALL_FAKE_ADAPTERS } from '@brandspace/providers';
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

  const checks = [
    {
      name: isArabic ? 'قاعدة البيانات (هوية المنصة)' : 'Database (platform identity)',
      status: databaseOk ? 'ok' : 'error',
      detail: databaseRole,
      testid: 'health-database',
    },
    {
      name: isArabic ? 'تهيئة التتبع' : 'Tracing initialised',
      status: tracing.initialized ? 'ok' : 'off',
      detail: tracing.serviceName,
      testid: 'health-tracing',
    },
    {
      name: isArabic ? 'تصدير OTLP' : 'OTLP export',
      status: tracing.exporting ? 'ok' : 'off',
      // Host only — an endpoint URL can embed credentials.
      detail: tracing.exporting
        ? (tracing.endpointHost ?? 'configured')
        : isArabic
          ? 'غير مُهيّأ (التتبع يعمل محليًا دون تصدير)'
          : 'Not configured (spans are created locally, nothing is exported)',
      testid: 'health-otlp',
    },
    {
      name: isArabic ? 'البيئة' : 'Environment',
      status: 'ok',
      detail: currentEnvironment(),
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
              title={isArabic ? 'محوّلات المزودين المسجّلة' : 'Registered provider adapters'}
              description={
                isArabic
                  ? 'محوّلات اختبارية فقط في هذه المرحلة — لا يوجد اتصال بمزود خارجي حقيقي.'
                  : 'Test adapters only at this phase — no real external provider is connected.'
              }
            />
          </div>
          <DataTable
            headers={[
              isArabic ? 'المفتاح' : 'Key',
              isArabic ? 'النوع' : 'Kind',
              isArabic ? 'بيانات مطلوبة' : 'Required credentials',
            ]}
          >
            {ALL_FAKE_ADAPTERS.map((adapter) => (
              <tr key={adapter.key} data-testid={`adapter-${adapter.key}`}>
                <Cell>
                  <code style={{ ...typographyTokens.caption, fontFamily: fontTokens.mono }}>
                    {adapter.key}
                  </code>
                </Cell>
                <Cell>{adapter.kind}</Cell>
                <Cell>{adapter.requiredCredentialKeys.join(', ') || '—'}</Cell>
              </tr>
            ))}
          </DataTable>
        </>
      ) : null}
    </>
  );
}
