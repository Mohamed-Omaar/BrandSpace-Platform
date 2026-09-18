import Link from 'next/link';
import { notFound } from 'next/navigation';
import { findIntegration, findIntegrationCategory } from '@brandspace/integrations';
import {
  SectionHeader,
  colorTokens,
  fontTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { Cell, DataTable, EmptyState, PageIntro } from '../../../../../../components/admin-shell';
import {
  primaryButtonStyle,
  secondaryButtonStyle,
  inputStyle,
} from '../../../../../../components/console-ui';
import {
  currentEnvironment,
  getIntegrationsService,
  requirePageActor,
  serviceActor,
} from '../../../../../../server/platform-context';
import { setIntegrationStateAction, testIntegrationAction } from '../../actions';

export const dynamic = 'force-dynamic';

/**
 * One integration, in full — Phase 10 §2.
 *
 * WHAT AN OWNER GETS HERE, and why each part is on the page rather than
 * somewhere else:
 *
 *   CAPABILITIES, declared. §4's rule that capabilities are never assumed
 *   equal only helps if somebody can see them before they commit to a vendor.
 *
 *   CREDENTIAL STATUS, MASKED. A hint, a fingerprint and a rotation date, and
 *   there is no reveal button anywhere in this product — not hidden, absent.
 *   An owner confirms "same key" from the fingerprint, which is what they
 *   actually need, and a database dump yields nothing.
 *
 *   THE VERIFICATION HISTORY. "It worked when I pressed the button" is not an
 *   operational record. Every check — including the refusals and the ones that
 *   never left the building — is kept, so the next operator can see whether
 *   this has been failing since Tuesday.
 *
 *   AND WHY IT CANNOT BE ACTIVATED, when it cannot. A disabled Activate button
 *   teaches nothing; a sentence saying "this is a development double and can
 *   never be activated in production" teaches what to do next.
 */
export default async function IntegrationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; category: string; providerKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale, category, providerKey: rawProviderKey } = await params;
  const query = await searchParams;
  const providerKey = decodeURIComponent(rawProviderKey);

  const actor = await requirePageActor(locale, 'platform.configuration.read');
  const isArabic = locale === 'ar';
  const environment = currentEnvironment();

  const definition = findIntegration(category, providerKey);
  const categoryDefinition = findIntegrationCategory(category);
  // An unregistered pair is a 404, not an error page: there is nothing here.
  if (!definition || !categoryDefinition) notFound();

  const service = getIntegrationsService();
  const view = await service.get(serviceActor(actor), category, providerKey, environment);
  const history = await service.history(category, providerKey, environment, 20);

  const mayActivate = actor.permissionKeys.includes('platform.configuration.activate');
  const notice = typeof query['ok'] === 'string' ? query['ok'] : null;
  const errorCode = typeof query['error'] === 'string' ? query['error'] : null;

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? `${view.displayNameAr} — بيئة ${environment}. ${view.noteAr}`
            : `${view.displayNameEn} — ${environment} environment. ${view.noteEn}`
        }
      />

      <p style={{ marginBlockEnd: spacingTokens.lg }}>
        <Link href={`/${locale}/console/integrations`} style={{ color: colorTokens.brandPurple }}>
          {isArabic ? '← كل التكاملات' : '← All integrations'}
        </Link>
      </p>

      {notice ? (
        <p role="status" data-testid="integration-notice" style={{ color: colorTokens.success }}>
          {noticeText(notice, isArabic)}
        </p>
      ) : null}
      {errorCode ? (
        <p role="alert" data-testid="integration-error" style={{ color: colorTokens.danger }}>
          {isArabic
            ? `تعذّر إتمام العملية (${errorCode}). راجع سجل التدقيق.`
            : `That did not complete (${errorCode}). The detail is in the audit log.`}
        </p>
      ) : null}

      {view.selectionRefusal ? (
        <p
          role="note"
          data-testid="integration-refusal"
          style={{
            padding: spacingTokens.md,
            border: `1px solid ${colorTokens.warning}`,
            borderRadius: 8,
            marginBlockEnd: spacingTokens.lg,
          }}
        >
          {view.selectionRefusal}
        </p>
      ) : null}

      <SectionHeader
        title={isArabic ? 'الحالة' : 'Status'}
        description={
          isArabic
            ? 'الإعداد يأتي من التهيئة المُفعّلة؛ الاتصال من آخر فحص فعلي.'
            : 'Configuration comes from the active version; connection comes from the last real check.'
        }
      />
      <DataTable headers={[isArabic ? 'البند' : 'Item', isArabic ? 'القيمة' : 'Value']}>
        <tr data-testid="detail-enabled">
          <Cell>{isArabic ? 'مفعّل' : 'Active'}</Cell>
          <Cell>{view.enabled ? (isArabic ? 'نعم' : 'Yes') : isArabic ? 'لا' : 'No'}</Cell>
        </tr>
        <tr data-testid="detail-complete">
          <Cell>{isArabic ? 'اكتمال الإعداد' : 'Configuration complete'}</Cell>
          <Cell>
            {view.configurationComplete ? (isArabic ? 'نعم' : 'Yes') : isArabic ? 'لا' : 'No'}
          </Cell>
        </tr>
        <tr data-testid="detail-connection">
          <Cell>{isArabic ? 'حالة الاتصال' : 'Connection'}</Cell>
          <Cell>{view.connection}</Cell>
        </tr>
        <tr data-testid="detail-last-success">
          <Cell>{isArabic ? 'آخر نجاح' : 'Last success'}</Cell>
          <Cell>{view.lastSuccessAt ? view.lastSuccessAt.toISOString() : '—'}</Cell>
        </tr>
        <tr data-testid="detail-last-failure">
          <Cell>{isArabic ? 'آخر فشل' : 'Last failure'}</Cell>
          <Cell>{view.lastFailureAt ? view.lastFailureAt.toISOString() : '—'}</Cell>
        </tr>
        <tr>
          <Cell>{isArabic ? 'البيئات المدعومة' : 'Supported environments'}</Cell>
          <Cell>{view.supportedEnvironments.join(', ')}</Cell>
        </tr>
      </DataTable>

      <div style={{ marginBlockStart: spacingTokens.xl }}>
        <SectionHeader
          title={isArabic ? 'القدرات المعلنة' : 'Declared capabilities'}
          description={
            isArabic
              ? 'تُقرأ من المحوّل ولا تُفترض متساوية بين المزودين.'
              : 'Read from the adapter. Never assumed equal between providers.'
          }
        />
        <DataTable
          headers={[isArabic ? 'القدرة' : 'Capability', isArabic ? 'مدعومة' : 'Supported']}
        >
          {Object.entries(view.capabilities).map(([key, supported]) => (
            <tr key={key} data-testid={`capability-${key}`}>
              <Cell>
                <code style={{ ...typographyTokens.caption, fontFamily: fontTokens.mono }}>
                  {key}
                </code>
              </Cell>
              <Cell>
                <span style={{ color: supported ? colorTokens.success : colorTokens.textMuted }}>
                  {supported ? (isArabic ? 'نعم' : 'Yes') : isArabic ? 'لا' : 'No'}
                </span>
              </Cell>
            </tr>
          ))}
        </DataTable>
      </div>

      <div style={{ marginBlockStart: spacingTokens.xl }}>
        <SectionHeader
          title={isArabic ? 'بيانات الاعتماد' : 'Credentials'}
          description={
            isArabic
              ? 'مُقنّعة دائمًا. لا يوجد أي مسار في المنتج لاسترجاع القيمة بعد حفظها — التحديث يستبدلها ولا يتطلب معرفة القديمة.'
              : 'Always masked. Nothing in this product can read a stored value back; an update replaces it and never needs the old one.'
          }
        />
        {view.credentials.length === 0 ? (
          <EmptyState
            message={
              isArabic
                ? 'هذا المزود لا يحتاج أي بيانات اعتماد — وهذا ما يجعله مزود تطوير.'
                : 'This provider needs no credentials, which is part of what makes it a development double.'
            }
          />
        ) : (
          <DataTable
            headers={[
              isArabic ? 'الحقل' : 'Field',
              isArabic ? 'مطلوب' : 'Required',
              isArabic ? 'القيمة' : 'Value',
              isArabic ? 'البصمة' : 'Fingerprint',
              isArabic ? 'آخر تدوير' : 'Last rotated',
            ]}
          >
            {view.credentials.map((credential) => (
              <tr key={credential.fieldKey} data-testid={`credential-${credential.fieldKey}`}>
                <Cell>{credential.fieldKey}</Cell>
                <Cell>
                  {credential.required ? (isArabic ? 'نعم' : 'Yes') : isArabic ? 'لا' : 'No'}
                </Cell>
                <Cell>
                  {credential.present ? (
                    <code style={{ fontFamily: fontTokens.mono }}>
                      {`••••••••••${credential.maskedHint ?? ''}`}
                    </code>
                  ) : (
                    <span style={{ color: colorTokens.warning }}>
                      {isArabic ? 'غير محفوظة' : 'Not set'}
                    </span>
                  )}
                </Cell>
                <Cell>
                  <code style={{ ...typographyTokens.caption, fontFamily: fontTokens.mono }}>
                    {credential.fingerprint ?? '—'}
                  </code>
                </Cell>
                <Cell>
                  {credential.lastRotatedAt ? credential.lastRotatedAt.toISOString() : '—'}
                </Cell>
              </tr>
            ))}
          </DataTable>
        )}
        <p style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
          {isArabic ? 'تُدار القيم من ' : 'Values are managed on '}
          <Link href={`/${locale}/console/secrets`} style={{ color: colorTokens.brandPurple }}>
            {isArabic ? 'صفحة الأسرار' : 'the Secrets page'}
          </Link>
          {isArabic
            ? '، حيث الحفظ والتدوير والإلغاء مُدقّقة.'
            : ', where saving, rotation and revocation are audited.'}
        </p>
      </div>

      <div style={{ marginBlockStart: spacingTokens.xl }}>
        <SectionHeader
          title={isArabic ? 'الإجراءات' : 'Actions'}
          description={
            isArabic
              ? 'الاختبار لا يُفعّل شيئًا، والتفعيل تغيير تهيئة كامل بسبب وسجل وإمكانية تراجع.'
              : 'Testing activates nothing. Activating is a full configuration change, with a reason, an audit trail and a rollback.'
          }
        />
        <div style={{ display: 'flex', gap: spacingTokens.md, flexWrap: 'wrap' }}>
          {view.testable ? (
            <form action={testIntegrationAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="category" value={category} />
              <input type="hidden" name="providerKey" value={providerKey} />
              <button type="submit" style={secondaryButtonStyle()} data-testid="test-connection">
                {isArabic ? 'اختبار الاتصال' : 'Test connection'}
              </button>
            </form>
          ) : null}

          {mayActivate ? (
            <form
              action={setIntegrationStateAction}
              style={{
                display: 'flex',
                gap: spacingTokens.sm,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="category" value={category} />
              <input type="hidden" name="providerKey" value={providerKey} />
              <input type="hidden" name="enable" value={view.enabled ? 'false' : 'true'} />
              <label htmlFor="integration-reason" style={typographyTokens.caption}>
                {isArabic ? 'سبب التغيير' : 'Change reason'}
              </label>
              <input
                id="integration-reason"
                name="reason"
                required
                minLength={8}
                style={inputStyle()}
                data-testid="integration-reason"
                placeholder={
                  isArabic ? 'لماذا يتغيّر هذا الآن؟' : 'Why is this changing, in a sentence?'
                }
              />
              <button
                type="submit"
                style={view.enabled ? secondaryButtonStyle() : primaryButtonStyle()}
                data-testid={view.enabled ? 'disable-integration' : 'activate-integration'}
                disabled={!view.enabled && view.selectionRefusal !== null}
              >
                {view.enabled ? (isArabic ? 'تعطيل' : 'Disable') : isArabic ? 'تفعيل' : 'Activate'}
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div style={{ marginBlockStart: spacingTokens.xl }}>
        <SectionHeader
          title={isArabic ? 'سجل الفحوصات' : 'Verification history'}
          description={
            isArabic
              ? 'كل محاولة، بما فيها ما لم يغادر المنصة أصلًا.'
              : 'Every attempt, including the ones that never left the platform.'
          }
        />
        {history.length === 0 ? (
          <EmptyState
            message={isArabic ? 'لم يُجرَ أي فحص بعد.' : 'Nothing has been checked yet.'}
          />
        ) : (
          <DataTable
            headers={[
              isArabic ? 'النتيجة' : 'Outcome',
              isArabic ? 'الزمن' : 'Latency',
              isArabic ? 'الرسالة' : 'Message',
              isArabic ? 'التاريخ' : 'When',
            ]}
          >
            {history.map((row) => (
              <tr key={row.id} data-testid={`history-${row.id}`}>
                <Cell>{row.outcome}</Cell>
                <Cell>{row.latencyMs === null ? '—' : `${row.latencyMs} ms`}</Cell>
                <Cell>{row.message}</Cell>
                <Cell>
                  <time dateTime={row.checkedAt.toISOString()}>{row.checkedAt.toISOString()}</time>
                </Cell>
              </tr>
            ))}
          </DataTable>
        )}
      </div>
    </>
  );
}

function noticeText(code: string, isArabic: boolean): string {
  switch (code) {
    case 'CONNECTION_TESTED':
      return isArabic ? 'تم الفحص وسُجّلت النتيجة.' : 'Checked, and the result is recorded below.';
    case 'INTEGRATION_ACTIVATED':
      return isArabic ? 'تم التفعيل.' : 'Activated.';
    case 'INTEGRATION_DISABLED':
      return isArabic ? 'تم التعطيل.' : 'Disabled.';
    default:
      return isArabic ? 'تم.' : 'Done.';
  }
}
