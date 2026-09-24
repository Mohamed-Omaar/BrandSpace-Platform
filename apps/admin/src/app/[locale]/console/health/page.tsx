import { evaluateHealth, tracingStatus, type DependencyCheck } from '@brandspace/observability';
import { eventsNeedingAttention } from '@brandspace/billing';
import { INTEGRATION_CATEGORY_DEFINITIONS } from '@brandspace/integrations';
import {
  SectionHeader,
  buttonClass,
  buttonStyle,
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
import { replayBillingEventAction } from './actions';

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
  /*
   * THE REPLAY AUTHORITY IS THE UNION OF WHAT A REPLAY CAN DO — assigning a
   * plan and moving credits — and the action re-checks both. A button that is
   * not rendered is not a control (the action is a public HTTP endpoint), so
   * this only decides whether an operator is shown something they could not use.
   */
  const mayReplay =
    actor.permissionKeys.includes('platform.plan.assign') &&
    actor.permissionKeys.includes('platform.credit.adjust');
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

  /*
   * THE BILLING EVENTS NOBODY CAN FINISH WITHOUT BEING TOLD ABOUT THEM.
   *
   * A dead-lettered event is a payment that moved at the provider and did not
   * move here. It writes a CRITICAL audit row when it happens — and an AUDIT ROW
   * IS NOT AN ALERT: nothing pages anybody, so until this list existed the only
   * way to find one was to go looking in a log. Listing it on the page an
   * operator already opens to ask "is anything wrong" is the smallest honest fix.
   *
   * BOUNDED, AND WITHOUT THE PAYLOAD. `eventsNeedingAttention` selects identity
   * and status and never the normalized body.
   */
  const stuckEvents = await eventsNeedingAttention(getPlatformPrisma(), { limit: 25 });

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

      <div style={{ marginBlockStart: spacingTokens.xl }}>
        <SectionHeader
          title={isArabic ? 'أحداث الفوترة المتوقفة' : 'Billing events that stopped'}
          description={
            isArabic
              ? 'أحداث وصلت وتم التحقق من توقيعها ولم تُطبَّق: نفدت محاولاتها، أو رُفضت لعدم تطابق المبلغ، أو تعذّر ربطها بمساحة عمل. لا يوجد تنبيه خارجي — هذه هي القائمة.'
              : 'Events that arrived, had their signature verified, and were not applied: out of attempts, refused on an amount mismatch, or impossible to tie to a workspace. There is no external alert — this list is it.'
          }
        />
      </div>
      {stuckEvents.length === 0 ? (
        <p
          data-testid="billing-inbox-clear"
          style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
        >
          {isArabic ? 'لا شيء ينتظر قرارًا.' : 'Nothing is waiting for a decision.'}
        </p>
      ) : (
        <DataTable
          headers={[
            isArabic ? 'الحدث' : 'Event',
            isArabic ? 'الحالة' : 'Status',
            isArabic ? 'المحاولات' : 'Attempts',
            isArabic ? 'السبب' : 'Reason',
            isArabic ? 'إعادة التشغيل' : 'Replay',
          ]}
        >
          {stuckEvents.map((event) => (
            <tr key={event.id} data-testid={`billing-event-${event.id}`}>
              <Cell>
                <code style={{ ...typographyTokens.caption, fontFamily: fontTokens.mono }}>
                  {event.eventType}
                </code>
                <div style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                  {event.providerKey} · {event.receivedAt.toISOString().slice(0, 19)}Z
                </div>
              </Cell>
              <Cell>
                <span style={{ color: colorTokens.danger, fontWeight: 600 }}>{event.status}</span>
              </Cell>
              <Cell>{event.attempts}</Cell>
              <Cell>{event.failureReason ?? '—'}</Cell>
              <Cell>
                {mayReplay ? (
                  <form action={replayBillingEventAction}>
                    <input type="hidden" name="locale" value={locale} />
                    <input type="hidden" name="billingEventId" value={event.id} />
                    <input type="hidden" name="providerKey" value={event.providerKey} />
                    {/*
                      The design system's button, not the browser's (P6-02):
                      this shipped bare, so a row of replay controls rendered in
                      browser chrome inside a Control Center table. `neutral` at
                      `sm` is the size the table's other row controls use.
                    */}
                    <button
                      type="submit"
                      data-testid={`replay-${event.id}`}
                      className={buttonClass('neutral')}
                      style={buttonStyle('neutral', 'sm')}
                    >
                      {isArabic ? 'أعد التشغيل' : 'Replay'}
                    </button>
                  </form>
                ) : (
                  <span style={{ color: colorTokens.textMuted }}>—</span>
                )}
              </Cell>
            </tr>
          ))}
        </DataTable>
      )}

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
