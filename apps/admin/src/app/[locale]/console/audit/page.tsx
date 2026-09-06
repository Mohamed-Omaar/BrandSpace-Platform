import { typographyTokens, fontTokens } from '@brandspace/ui';
import { Cell, DataTable, EmptyState, PageIntro } from '../../../../components/admin-shell';
import { getPlatformPrisma, requirePageActor } from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * Audit log viewer.
 *
 * Gated on `platform.audit.read`, and reading it is itself an audited action in
 * the operational sense: the query runs on the platform pool, which is the only
 * identity permitted to see platform-scoped events.
 */
export default async function AuditPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  await requirePageActor(locale, 'platform.audit.read');
  const isArabic = locale === 'ar';

  const events = await getPlatformPrisma().auditEvent.findMany({
    orderBy: { occurredAt: 'desc' },
    take: 100,
  });

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? 'سجل غير قابل للتعديل. آخر ١٠٠ حدث.'
            : 'Append-only record. The 100 most recent events.'
        }
      />
      {events.length === 0 ? (
        <EmptyState message={isArabic ? 'لا توجد أحداث.' : 'No events recorded.'} />
      ) : (
        <DataTable
          headers={[
            isArabic ? 'الوقت' : 'Time',
            isArabic ? 'الإجراء' : 'Action',
            isArabic ? 'النوع' : 'Actor',
            isArabic ? 'النتيجة' : 'Outcome',
            isArabic ? 'الخطورة' : 'Severity',
            isArabic ? 'السبب' : 'Reason',
          ]}
        >
          {events.map((event) => (
            <tr key={event.id} data-testid={`audit-${event.id}`}>
              <Cell>{event.occurredAt.toISOString().replace('T', ' ').slice(0, 19)}</Cell>
              <Cell>
                <code style={{ ...typographyTokens.caption, fontFamily: fontTokens.mono }}>
                  {event.action}
                </code>
              </Cell>
              <Cell>{event.actorType}</Cell>
              <Cell>{event.outcome}</Cell>
              <Cell>{event.severity}</Cell>
              <Cell>{event.reason ?? '—'}</Cell>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}
