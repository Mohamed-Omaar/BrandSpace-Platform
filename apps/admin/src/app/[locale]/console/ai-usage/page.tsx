import Link from 'next/link';
import {
  Cell,
  DataTable,
  PageHeader,
  Pagination,
  Stack,
  StatusBadge,
  Toolbar,
  buttonStyle,
  colorTokens,
  statusTone,
  typographyTokens,
} from '@brandspace/ui';
import { AI_TASK_KEYS, DEFAULT_AI_PAGE_SIZE } from '@brandspace/ai-gateway';
import {
  getAiUsageExplorer,
  requirePageActor,
  serviceActor,
} from '../../../../server/platform-context';
import { translator } from '../../../../i18n/messages';
import { Card, EmptyState } from '../../../../components/console-ui';

export const dynamic = 'force-dynamic';

/**
 * The AI usage explorer — docs/AI-GATEWAY.md §12.
 *
 * PAGED, WITH A TRUTHFUL TOTAL. The range line is rendered even on a single
 * page and even when empty: "how many are there" is the assurance that nothing
 * is hidden, and its absence is exactly what made the old 200-row caps silent
 * (A-11, F-53).
 *
 * The screen shows accounting, not content. There is no column here that could
 * contain a prompt or a generated result, and the inspector behind it does not
 * surface them either — reading a customer's content is a Support Mode decision
 * with its own audit trail, not a side effect of opening an operations page.
 */

/** Whole credits from milli-credits (D-14), for display only. */
function credits(milli: bigint): string {
  return (Number(milli) / 1000).toFixed(3);
}

/**
 * Micro-minor to a major-unit string.
 *
 * Provider cost is held at a millionth of a minor unit because token prices are
 * fractions of a cent; four decimal places of a major unit is the smallest
 * scale at which a single request's cost is still readable.
 */
function cost(microMinor: bigint): string {
  return (Number(microMinor) / 100_000_000).toFixed(4);
}

export default async function AiUsagePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const actor = await requirePageActor(locale, 'platform.ai.usage.read');
  const t = translator(locale);
  const isArabic = locale === 'ar';

  const explorer = getAiUsageExplorer();
  const taskKey = typeof query['task'] === 'string' ? query['task'] : undefined;
  const status = typeof query['status'] === 'string' ? query['status'] : undefined;
  const workspaceId = typeof query['workspace'] === 'string' ? query['workspace'] : undefined;

  const requestedPage = Number.parseInt(String(query['page'] ?? '1'), 10);
  const requestedSize = Number.parseInt(String(query['size'] ?? ''), 10);

  const listing = await explorer.requests(serviceActor(actor), {
    ...(taskKey ? { taskKey } : {}),
    ...(status ? { status } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    page: Number.isNaN(requestedPage) ? 1 : requestedPage,
    pageSize: Number.isNaN(requestedSize) ? DEFAULT_AI_PAGE_SIZE : requestedSize,
  });

  const [byModel, leaks] = await Promise.all([
    explorer.rollup(serviceActor(actor), 'modelKey', {}),
    explorer.leakCount(serviceActor(actor)),
  ]);

  const hrefWith = (changes: Record<string, string | number | undefined>): string => {
    const next = new URLSearchParams();
    if (taskKey) next.set('task', taskKey);
    if (status) next.set('status', status);
    if (workspaceId) next.set('workspace', workspaceId);
    next.set('page', String(listing.page));
    next.set('size', String(listing.pageSize));
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, String(value));
    }
    const queryString = next.toString();
    return queryString
      ? `/${locale}/console/ai-usage?${queryString}`
      : `/${locale}/console/ai-usage`;
  };

  return (
    <div>
      <PageHeader
        title={t('page.aiUsage')}
        description={
          isArabic
            ? 'كل طلبات الذكاء الاصطناعي وتكلفتها. لا يعرض هذا السجل أي محتوى للعميل.'
            : 'Every AI request and what it cost. This record shows no customer content.'
        }
      />

      <Stack>
        {/*
          THE RESERVATION-LEAK COUNT, FIRST — §12 says it must stay at zero.
          Shown even when it is zero, because a metric only anybody looks at
          when it is broken is a metric nobody trusts.
        */}
        <Card testId="ai-leak-card">
          <p
            data-testid="ai-leak-count"
            role="status"
            style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
          >
            {isArabic
              ? `حجوزات لم تُغلق بعد انتهاء المهلة: ${leaks}`
              : `Reservations past their deadline and not yet reconciled: ${leaks}`}
          </p>
        </Card>

        <Card testId="ai-rollup">
          {byModel.length === 0 ? (
            <EmptyState
              message={isArabic ? 'لا توجد بيانات استخدام بعد.' : 'No usage recorded yet.'}
            />
          ) : (
            <DataTable
              headers={[
                isArabic ? 'النموذج' : 'Model',
                isArabic ? 'الطلبات' : 'Requests',
                isArabic ? 'الأرصدة' : 'Credits',
                isArabic ? 'تكلفة المزود' : 'Provider cost',
              ]}
              caption={isArabic ? 'الاستخدام حسب النموذج' : 'Usage by model'}
              testId="ai-rollup-table"
            >
              {byModel.map((row) => (
                <tr key={row.key} data-testid={`rollup-${row.key}`}>
                  <Cell>{row.key}</Cell>
                  <Cell>{row.requests}</Cell>
                  <Cell>{credits(row.creditsChargedMilli)}</Cell>
                  <Cell>{cost(row.providerCostMicroMinor)}</Cell>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>

        <Card testId="ai-requests">
          <form method="get">
            <Toolbar>
              <label htmlFor="task" style={typographyTokens.caption}>
                {isArabic ? 'المهمة' : 'Task'}
              </label>
              <select id="task" name="task" defaultValue={taskKey ?? ''} className="bs-control">
                <option value="">{isArabic ? 'الكل' : 'All'}</option>
                {AI_TASK_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
              <label htmlFor="status" style={typographyTokens.caption}>
                {isArabic ? 'الحالة' : 'Status'}
              </label>
              <select id="status" name="status" defaultValue={status ?? ''} className="bs-control">
                <option value="">{isArabic ? 'الكل' : 'All'}</option>
                {['PENDING', 'RESERVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button type="submit" data-testid="ai-filter-submit" style={buttonStyle('neutral')}>
                {isArabic ? 'تصفية' : 'Filter'}
              </button>
            </Toolbar>
          </form>

          {listing.total === 0 ? (
            <EmptyState
              message={
                taskKey || status || workspaceId
                  ? isArabic
                    ? 'لا توجد طلبات مطابقة لهذه التصفية.'
                    : 'No requests match this filter.'
                  : isArabic
                    ? 'لم يُسجَّل أي طلب ذكاء اصطناعي بعد.'
                    : 'No AI requests have been recorded yet.'
              }
            />
          ) : (
            <DataTable
              headers={[
                isArabic ? 'المهمة' : 'Task',
                isArabic ? 'الحالة' : 'Status',
                isArabic ? 'النموذج' : 'Model',
                isArabic ? 'الأرصدة' : 'Credits',
                isArabic ? 'التكلفة' : 'Cost',
                isArabic ? 'زمن الاستجابة' : 'Latency',
                isArabic ? 'التاريخ' : 'When',
              ]}
              caption={t('page.aiUsage')}
              testId="ai-request-table"
            >
              {listing.items.map((row) => (
                <tr key={row.id} data-testid={`ai-request-${row.id}`}>
                  <Cell>
                    <Link
                      href={`/${locale}/console/ai-usage/${row.id}`}
                      style={{ color: colorTokens.brandPurple, fontWeight: 600 }}
                    >
                      {row.taskKey}
                    </Link>
                  </Cell>
                  <Cell>
                    <StatusBadge label={row.status} tone={statusTone(row.status)} />
                  </Cell>
                  <Cell>{row.modelKey ?? '—'}</Cell>
                  <Cell>{credits(row.creditsChargedMilli)}</Cell>
                  <Cell>{cost(row.providerCostMicroMinor)}</Cell>
                  <Cell>{row.latencyMs === null ? '—' : `${row.latencyMs} ms`}</Cell>
                  <Cell>{row.createdAt.toISOString().slice(0, 19).replace('T', ' ')}</Cell>
                </tr>
              ))}
            </DataTable>
          )}

          {/*
            THE RANGE, ALWAYS — even on a single page, and even when empty. The
            pagination nav hides itself at one page; the total must not.
          */}
          <p
            data-testid="ai-request-range"
            role="status"
            style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}
          >
            {isArabic
              ? `عرض ${listing.from}–${listing.to} من ${listing.total}`
              : `Showing ${listing.from}–${listing.to} of ${listing.total}`}
          </p>

          <Pagination
            page={listing.page}
            pageCount={listing.totalPages}
            hrefForPage={(target) => hrefWith({ page: target })}
            labels={{
              navigation: isArabic ? 'تنقل الصفحات' : 'Pagination',
              previous: isArabic ? 'السابق' : 'Previous',
              next: isArabic ? 'التالي' : 'Next',
              summary: isArabic
                ? `صفحة ${listing.page} من ${listing.totalPages}`
                : `Page ${listing.page} of ${listing.totalPages}`,
            }}
            testId="ai-request-pagination"
          />
        </Card>
      </Stack>
    </div>
  );
}
