import { colorTokens } from '@brandspace/ui';
import { Cell, DataTable, EmptyState, PageHeading } from '../../../../components/admin-shell';
import {
  currentEnvironment,
  getConfigService,
  requirePageActor,
} from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/** Renders the ACTIVE 'plans' configuration for this environment. */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requirePageActor(locale, 'platform.configuration.read');
  const isArabic = locale === 'ar';

  const payload = (await getConfigService().get('plans', currentEnvironment())) as Record<
    string,
    unknown
  >;
  const rows = (payload['plans'] ?? []) as Record<string, unknown>[];
  const columns = ['key', 'status', 'visibility', 'prices', 'trialDays', 'monthlyCredits'] as const;

  return (
    <>
      <PageHeading
        title={isArabic ? 'الخطط والاستحقاقات' : 'Plans & entitlements'}
        description={
          isArabic
            ? 'قيم مقروءة من الإصدار المُفعّل. التعديل يتم عبر صفحة الإعدادات.'
            : 'Read from the active configuration version. Edit via the Configuration page.'
        }
      />
      {rows.length === 0 ? (
        <EmptyState
          message={
            isArabic
              ? 'لا توجد قيم مُفعّلة بعد — أنشئ مسودة وفعّلها من صفحة الإعدادات.'
              : 'Nothing activated yet — create and activate a draft on the Configuration page.'
          }
        />
      ) : (
        <DataTable headers={columns}>
          {rows.map((row, index) => (
            <tr key={String(row[columns[0]!] ?? index)} data-testid={`row-${index}`}>
              {columns.map((column) => (
                <Cell key={column}>
                  <span style={{ color: colorTokens.textPrimary }}>
                    {typeof row[column] === 'object'
                      ? JSON.stringify(row[column])
                      : String(row[column] ?? '—')}
                  </span>
                </Cell>
              ))}
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
