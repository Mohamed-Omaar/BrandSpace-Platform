import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  Cell,
  DataTable,
  PageHeader,
  Stack,
  StatusBadge,
  colorTokens,
  statusTone,
  typographyTokens,
} from '@brandspace/ui';
import { AppError } from '@brandspace/shared';
import {
  getAiUsageExplorer,
  requirePageActor,
  serviceActor,
} from '../../../../../server/platform-context';
import { translator } from '../../../../../i18n/messages';
import { Card, EmptyState } from '../../../../../components/console-ui';

export const dynamic = 'force-dynamic';

/**
 * The request inspector — docs/AI-GATEWAY.md §12.
 *
 * WHAT IS DELIBERATELY ABSENT. There is no prompt here and no generated
 * result, even for a routing rule that opted into storing its output. Reading a
 * customer's content is a Support Mode decision with its own time box and its
 * own audit trail; opening an operations screen is not. What this page shows is
 * the accounting and the mechanics — which models were tried, what was reserved
 * and charged, what it cost us, and why it failed.
 */

function credits(milli: bigint): string {
  return (Number(milli) / 1000).toFixed(3);
}

function cost(microMinor: bigint): string {
  return (Number(microMinor) / 100_000_000).toFixed(4);
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div style={{ display: 'flex', gap: '0.75rem', paddingBlock: '0.25rem' }}>
      <span
        style={{
          ...typographyTokens.caption,
          color: colorTokens.textSecondary,
          minInlineSize: '12rem',
        }}
      >
        {label}
      </span>
      <span style={{ ...typographyTokens.body, color: colorTokens.textPrimary }}>{value}</span>
    </div>
  );
}

export default async function AiRequestPage({
  params,
}: {
  params: Promise<{ locale: string; requestId: string }>;
}) {
  const { locale, requestId } = await params;
  const actor = await requirePageActor(locale, 'platform.ai.usage.read');
  const t = translator(locale);
  const isArabic = locale === 'ar';

  const detail = await getAiUsageExplorer()
    .request(serviceActor(actor), requestId)
    .catch((error: unknown) => {
      // A request that does not exist and one the caller may not see render
      // identically. Anything else is a real fault and must not be swallowed.
      if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
      throw error;
    });

  if (!detail) notFound();

  return (
    <div>
      <PageHeader
        title={t('page.aiRequest')}
        description={
          isArabic
            ? 'محاسبة الطلب وآلياته. لا يعرض هذا العرض أي محتوى للعميل.'
            : 'What this request did and what it cost. No customer content is shown.'
        }
        actions={
          <Link
            href={`/${locale}/console/ai-usage`}
            style={{ color: colorTokens.brandPurple, fontWeight: 600 }}
          >
            {isArabic ? 'رجوع' : 'Back to usage'}
          </Link>
        }
      />

      <Stack>
        <Card testId="ai-request-summary">
          <div style={{ marginBlockEnd: '0.75rem' }}>
            <StatusBadge
              label={detail.status}
              tone={statusTone(detail.status)}
              testId={`ai-status-${detail.status}`}
            />
          </div>
          <Row label={isArabic ? 'المهمة' : 'Task'} value={detail.taskKey} />
          <Row label={isArabic ? 'مساحة العمل' : 'Workspace'} value={detail.workspaceId} />
          <Row
            label={isArabic ? 'النموذج المستخدم' : 'Model used'}
            value={detail.modelKey ?? '—'}
          />
          {/*
            §5.3 point 4: every model tried, in order. Without it a fallback is
            invisible, and "why was this slow" has no answer.
          */}
          <Row
            label={isArabic ? 'النماذج التي جُرِّبت' : 'Models attempted'}
            value={detail.attemptedModelKeys.join(' → ') || '—'}
          />
          <Row label={isArabic ? 'إعادات المحاولة' : 'Retries'} value={String(detail.retryCount)} />
          <Row
            label={isArabic ? 'زمن الاستجابة' : 'Latency'}
            value={detail.latencyMs === null ? '—' : `${detail.latencyMs} ms`}
          />
          <Row
            label={isArabic ? 'المهلة النهائية' : 'Deadline'}
            value={detail.deadlineAt.toISOString()}
          />
        </Card>

        <Card testId="ai-request-accounting">
          <Row
            label={isArabic ? 'الأرصدة المحجوزة' : 'Credits reserved'}
            value={credits(detail.creditsReservedMilli)}
          />
          <Row
            label={isArabic ? 'الأرصدة المخصومة' : 'Credits charged'}
            value={credits(detail.creditsChargedMilli)}
          />
          <Row
            label={isArabic ? 'تكلفة المزود' : 'Provider cost'}
            value={`${cost(detail.providerCostMicroMinor)} ${detail.currency}`}
          />
          <Row
            label={isArabic ? 'وحدات الاستخدام' : 'Usage units'}
            value={
              [
                detail.promptTokens === null ? null : `prompt ${detail.promptTokens}`,
                detail.completionTokens === null ? null : `completion ${detail.completionTokens}`,
                detail.imageCount === null ? null : `images ${detail.imageCount}`,
                detail.durationSeconds === null ? null : `seconds ${detail.durationSeconds}`,
              ]
                .filter((part): part is string => part !== null)
                .join(', ') || '—'
            }
          />
          <Row label={isArabic ? 'مفتاح العميل' : 'BYOK'} value={detail.byok ? 'yes' : 'no'} />
        </Card>

        {detail.failureClass && (
          <Card testId="ai-request-failure">
            <Row label={isArabic ? 'صنف العطل' : 'Failure class'} value={detail.failureClass} />
            {/*
              The message the CUSTOMER was shown, recorded verbatim. The raw
              provider error is never persisted — it can carry an endpoint, an
              account id, or an echo of the prompt (§11).
            */}
            <Row
              label={isArabic ? 'الرسالة المعروضة للعميل' : 'Message shown to the customer'}
              value={detail.failureMessage ?? '—'}
            />
          </Card>
        )}

        <Card testId="ai-request-ledger">
          {detail.ledger.length === 0 ? (
            <EmptyState
              message={
                isArabic
                  ? 'لا توجد قيود في سجل الاستخدام لهذا الطلب.'
                  : 'No usage ledger entries for this request.'
              }
            />
          ) : (
            <DataTable
              headers={[
                isArabic ? 'التاريخ' : 'When',
                isArabic ? 'المزود' : 'Provider',
                isArabic ? 'النموذج' : 'Model',
                isArabic ? 'الأرصدة' : 'Credits',
                isArabic ? 'التكلفة' : 'Cost',
              ]}
              caption={isArabic ? 'سجل الاستخدام' : 'Usage ledger'}
              testId="ai-request-ledger-table"
            >
              {detail.ledger.map((entry) => (
                <tr key={entry.id} data-testid={`ledger-${entry.id}`}>
                  <Cell>{entry.occurredAt.toISOString().slice(0, 19).replace('T', ' ')}</Cell>
                  <Cell>{entry.providerKey}</Cell>
                  <Cell>{entry.modelKey}</Cell>
                  <Cell>{credits(entry.creditsChargedMilli)}</Cell>
                  <Cell>{`${cost(entry.providerCostMicroMinor)} ${entry.currency}`}</Cell>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>
      </Stack>
    </div>
  );
}
