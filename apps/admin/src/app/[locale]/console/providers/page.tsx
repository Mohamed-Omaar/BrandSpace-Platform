import { colorTokens, StateMessage } from '@brandspace/ui';
import { Cell, DataTable, PageIntro } from '../../../../components/admin-shell';
import {
  currentEnvironment,
  getConfigService,
  requirePageActor,
} from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/** Renders the ACTIVE 'ai.providers' configuration for this environment. */
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requirePageActor(locale, 'platform.configuration.read');
  const isArabic = locale === 'ar';

  const payload = (await getConfigService().get('ai.providers', currentEnvironment())) as Record<
    string,
    unknown
  >;
  const rows = (payload['providers'] ?? []) as Record<string, unknown>[];
  const columns = ['key', 'adapter', 'name', 'baseUrl', 'status', 'noTrainingGuarantee'] as const;
  const allowedHosts = Array.isArray(payload['allowedHosts'])
    ? (payload['allowedHosts'] as unknown[]).map(String)
    : [];

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? 'قيم مقروءة من الإصدار المُفعّل. التعديل يتم عبر صفحة الإعدادات.'
            : 'Read from the active configuration version. Edit via the Configuration page.'
        }
      />
      {/* D-573 — what two of this domain's settings do, and one that does nothing yet. */}
      <p
        data-testid="providers-help"
        style={{ margin: '0 0 12px', color: colorTokens.textSecondary }}
      >
        {isArabic
          ? `المضيفون المسموح بهم غير مضيف المزود الرسمي: ${allowedHosts.length > 0 ? allowedHosts.join('، ') : 'لا أحد'}. لا يُتصل إلا عبر https وبعنوان عام. الحقل maxConcurrency مسجّل لكنه غير مُطبّق: التزامن يُحدّ لكل مساحة عمل في حدود إنفاق الذكاء الاصطناعي، ومن حدود المزود نفسه.`
          : `Hosts allowed besides each provider’s official one: ${allowedHosts.length > 0 ? allowedHosts.join(', ') : 'none'}. Connections are https only, to public addresses only. maxConcurrency is recorded but not enforced: concurrency is limited per workspace in AI spending limits, and by the provider’s own rate limits.`}
      </p>
      {rows.length === 0 ? (
        <StateMessage
          title={
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
