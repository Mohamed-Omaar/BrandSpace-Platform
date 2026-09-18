import Link from 'next/link';
import {
  INTEGRATION_CATEGORY_DEFINITIONS,
  type ConnectionState,
  type IntegrationView,
} from '@brandspace/integrations';
import { SectionHeader, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { Cell, DataTable, EmptyState, PageIntro } from '../../../../components/admin-shell';
import {
  currentEnvironment,
  getIntegrationsService,
  requirePageActor,
  serviceActor,
} from '../../../../server/platform-context';

export const dynamic = 'force-dynamic';

/**
 * THE INTEGRATIONS HUB — Phase 10 §2.
 *
 * ONE PLACE FOR EVERY EXTERNAL SYSTEM. Before this screen, an owner configuring
 * BrandSpace had to know that AI providers lived under `ai.providers`, social
 * applications under `integrations.social-apps`, the rest under four
 * `integrations.*` domains, and their credentials in a separate Secrets page —
 * six screens and a mental map. This is the map.
 *
 * IT IS GENERATED FROM THE REGISTRY, not hand-written per provider. Adding a
 * provider is an entry in `@brandspace/integrations` plus its adapter; no row
 * of this file changes. That is what makes §4's promise checkable rather than
 * aspirational.
 *
 * AND IT TELLS THE TRUTH ABOUT WHAT IS HERE. Every provider BrandSpace can talk
 * to today is a development double, and each row says so rather than a footnote
 * saying it once. An owner reading this screen should finish it knowing exactly
 * what is connected, what is not, and what it would take.
 */
export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  /*
   * The configuration READ permission, because that is what this page is: a
   * view over configuration and masked credential metadata. Every mutating
   * action on the detail page re-checks its own, stronger permission — a page
   * guard is not authorization for an action (docs/SECURITY.md §4).
   */
  const actor = await requirePageActor(locale, 'platform.configuration.read');
  const isArabic = locale === 'ar';
  const environment = currentEnvironment();

  const views = await getIntegrationsService().list(serviceActor(actor), environment);
  const gaps = await getIntegrationsService().productionGaps(serviceActor(actor), environment);

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? `كل نظام خارجي يمكن ربط BrandSpace به، في بيئة ${environment}. الأسرار تُعرض مُقنّعة فقط ولا تُسترجع أبدًا بعد الحفظ.`
            : `Every external system BrandSpace can be connected to, in the ${environment} environment. Secrets are shown masked and are never readable again after they are saved.`
        }
      />

      {gaps.length > 0 ? (
        <div
          data-testid="integration-gaps"
          role="status"
          style={{
            marginBlockEnd: spacingTokens.lg,
            padding: spacingTokens.md,
            borderRadius: 8,
            border: `1px solid ${colorTokens.warning}`,
            color: colorTokens.textPrimary,
          }}
        >
          <strong>
            {isArabic
              ? 'فئات مطلوبة في الإنتاج ولا يوجد مزود مفعّل لها:'
              : 'Required in production, with no active provider:'}
          </strong>
          <ul style={{ margin: 0, paddingInlineStart: spacingTokens.lg }}>
            {gaps.map((gap) => (
              <li key={gap.category}>{gap.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {INTEGRATION_CATEGORY_DEFINITIONS.map((category) => {
        const rows = views.filter((view) => view.category === category.key);
        return (
          <section key={category.key} style={{ marginBlockEnd: spacingTokens.xl }}>
            <SectionHeader
              title={isArabic ? category.labelAr : category.labelEn}
              description={
                (isArabic ? category.descriptionAr : category.descriptionEn) +
                (category.requiredInProduction
                  ? isArabic
                    ? ' — مطلوبة في الإنتاج.'
                    : ' Required in production.'
                  : '')
              }
            />
            {rows.length === 0 ? (
              <EmptyState
                message={
                  isArabic
                    ? 'لا يوجد محوّل لهذه الفئة في هذا الإصدار. إضافة مزود تعني كتابة محوّل له.'
                    : 'No adapter for this category in this build. Adding a provider means writing its adapter.'
                }
              />
            ) : (
              <DataTable
                headers={[
                  isArabic ? 'المزود' : 'Provider',
                  isArabic ? 'الحالة' : 'Enabled',
                  isArabic ? 'الإعداد' : 'Configuration',
                  isArabic ? 'الاتصال' : 'Connection',
                  isArabic ? 'آخر فحص' : 'Last checked',
                  '',
                ]}
              >
                {rows.map((view) => (
                  <tr
                    key={`${view.category}:${view.providerKey}`}
                    data-testid={`integration-${view.category}-${view.providerKey}`}
                  >
                    <Cell>
                      <div>{isArabic ? view.displayNameAr : view.displayNameEn}</div>
                      <div style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                        {isArabic ? view.noteAr : view.noteEn}
                      </div>
                    </Cell>
                    <Cell>
                      <StateWord
                        tone={view.enabled ? 'ok' : 'off'}
                        text={
                          view.enabled
                            ? isArabic
                              ? 'مفعّل'
                              : 'Active'
                            : isArabic
                              ? 'غير مفعّل'
                              : 'Not active'
                        }
                        testid={`enabled-${view.category}-${view.providerKey}`}
                      />
                    </Cell>
                    <Cell>
                      <StateWord
                        tone={view.configurationComplete ? 'ok' : 'warn'}
                        text={
                          view.configurationComplete
                            ? isArabic
                              ? 'مكتمل'
                              : 'Complete'
                            : isArabic
                              ? 'ناقص'
                              : 'Incomplete'
                        }
                      />
                    </Cell>
                    <Cell>
                      <ConnectionWord state={view.connection} isArabic={isArabic} />
                    </Cell>
                    <Cell>
                      {view.lastCheckedAt ? (
                        <time dateTime={view.lastCheckedAt.toISOString()}>
                          {view.lastCheckedAt.toISOString().slice(0, 16).replace('T', ' ')}
                        </time>
                      ) : (
                        '—'
                      )}
                    </Cell>
                    <Cell>
                      <Link
                        href={`/${locale}/console/integrations/${view.category}/${encodeURIComponent(view.providerKey)}`}
                        style={{ color: colorTokens.brandPurple }}
                      >
                        {isArabic ? 'التفاصيل' : 'Details'}
                      </Link>
                    </Cell>
                  </tr>
                ))}
              </DataTable>
            )}
          </section>
        );
      })}
    </>
  );
}

/**
 * A state word, with colour AND text.
 *
 * WCAG 2.2 AA: colour is never the only carrier of meaning, so every state is
 * a word first and a colour second. A reader who cannot distinguish the two
 * greens still reads "Active" and "Not active".
 */
function StateWord({
  tone,
  text,
  testid,
}: {
  tone: 'ok' | 'warn' | 'off' | 'bad';
  text: string;
  testid?: string;
}) {
  const colour =
    tone === 'ok'
      ? colorTokens.success
      : tone === 'warn'
        ? colorTokens.warning
        : tone === 'bad'
          ? colorTokens.danger
          : colorTokens.textMuted;
  return (
    <span style={{ color: colour, fontWeight: 600 }} {...(testid ? { 'data-testid': testid } : {})}>
      {text}
    </span>
  );
}

function ConnectionWord({ state, isArabic }: { state: ConnectionState; isArabic: boolean }) {
  const labels: Record<
    ConnectionState,
    { ar: string; en: string; tone: 'ok' | 'warn' | 'off' | 'bad' }
  > = {
    ok: { ar: 'يعمل', en: 'Working', tone: 'ok' },
    failed: { ar: 'فشل', en: 'Failed', tone: 'bad' },
    never_tested: { ar: 'لم يُختبر', en: 'Never tested', tone: 'off' },
    not_configured: { ar: 'غير مُهيّأ', en: 'Not configured', tone: 'warn' },
    refused: { ar: 'مرفوض', en: 'Refused', tone: 'warn' },
  };
  const label = labels[state];
  return <StateWord tone={label.tone} text={isArabic ? label.ar : label.en} />;
}

/** Re-exported for the detail page, which renders the same vocabulary. */
export type { IntegrationView };
