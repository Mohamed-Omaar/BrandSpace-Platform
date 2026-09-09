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

  /*
   * A-11. The cap is stated in words below ("the 100 most recent events"),
   * which was already honest — but a claim is not a number. The total is read
   * so the page can say the most recent 100 OF HOW MANY, which is what tells
   * an operator whether there is history they cannot reach from here.
   *
   * Full pagination of the audit log is scheduled rather than done here: the
   * log is append-only and platform-wide, so paging it usefully needs filters
   * (actor, action, workspace, date) that are their own piece of work.
   * Recorded in docs/DECISIONS.md under A-11.
   */
  const AUDIT_PAGE_CAP = 100;
  const [events, auditTotal] = await Promise.all([
    getPlatformPrisma().auditEvent.findMany({
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_PAGE_CAP,
    }),
    getPlatformPrisma().auditEvent.count(),
  ]);

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? `سجل غير قابل للتعديل. عرض أحدث ${events.length} من ${auditTotal}.`
            : `Append-only record. Showing the most recent ${events.length} of ${auditTotal}.`
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
