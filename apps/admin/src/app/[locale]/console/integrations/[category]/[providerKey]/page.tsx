import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  editableSettingFields,
  findIntegration,
  findIntegrationCategory,
} from '@brandspace/integrations';
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
  generatedSettingsFor,
  getIntegrationsService,
  requirePageActor,
  serviceActor,
} from '../../../../../../server/platform-context';
import {
  saveIntegrationConfigurationAction,
  setIntegrationStateAction,
  testIntegrationAction,
} from '../../actions';

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
  const mayConfigure = actor.permissionKeys.includes('platform.configuration.manage');
  const settingInputs = editableSettingFields(definition);
  const generatedSettings = generatedSettingsFor(definition);
  const configurableFields = settingInputs.length + definition.credentialFields.length;
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

      {/*
        WHAT THIS PROVIDER ACTUALLY IS, in the body rather than only in the page
        intro. An owner evaluating vendors reads the row they clicked into, and
        "this is a development double" is the single most important sentence on
        the page — it must not depend on having read the intro above the fold.
      */}
      <p data-testid="integration-note" style={{ marginBlockEnd: spacingTokens.lg }}>
        {isArabic ? view.noteAr : view.noteEn}
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
        <tr>
          <Cell>{isArabic ? 'مفعّل' : 'Active'}</Cell>
          <Cell>
            {/*
              THE TEST ID IS ON THE VALUE, not the row. A row's text is its
              label AND its value, so an assertion against the row reads
              "ActiveNo" and cannot distinguish a state change from a relabel.
            */}
            <span data-testid="detail-enabled">
              {view.enabled ? (isArabic ? 'نعم' : 'Yes') : isArabic ? 'لا' : 'No'}
            </span>
          </Cell>
        </tr>
        <tr>
          <Cell>{isArabic ? 'اكتمال الإعداد' : 'Configuration complete'}</Cell>
          <Cell>
            <span data-testid="detail-complete">
              {view.configurationComplete ? (isArabic ? 'نعم' : 'Yes') : isArabic ? 'لا' : 'No'}
            </span>
          </Cell>
        </tr>
        <tr>
          <Cell>{isArabic ? 'حالة الاتصال' : 'Connection'}</Cell>
          <Cell>
            <span data-testid="detail-connection">{view.connection}</span>
          </Cell>
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
          <Cell>
            <span data-testid="detail-environments">{view.supportedEnvironments.join(', ')}</span>
          </Cell>
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
          {isArabic
            ? 'تُحفظ القيم من هذه الصفحة عبر خدمة الأسرار نفسها، حيث الحفظ والتدوير والإلغاء مُدقّقة. '
            : 'Values are saved from this page through the same Secret Service, where saving, rotation and revocation are audited. '}
          <Link href={`/${locale}/console/secrets`} style={{ color: colorTokens.brandPurple }}>
            {isArabic ? 'صفحة الأسرار' : 'The Secrets page'}
          </Link>
          {isArabic
            ? ' تبقى للفحص والإدارة المتقدمة والاسترداد.'
            : ' remains for inspection, advanced administration and recovery.'}
        </p>
      </div>

      {/*
        THE CONFIGURATION FORM — the Phase 10 correction.
 
        GENERATED FROM THE REGISTRY, never written per provider. Every input
        below exists because this provider's definition declares the field; a
        provider that declares nothing gets no form, and a real adapter
        registered next year gets its own form on the day it is registered
        without anybody editing this file.
 
        THE SECRET INPUTS ARE WRITE-ONLY. There is no `defaultValue` on any of
        them and there could not be: nothing in this product can read a stored
        secret back. An empty box means "leave this credential alone", which is
        why editing a URL does not wipe a working key.
      */}
      {configurableFields > 0 ? (
        <div style={{ marginBlockStart: spacingTokens.xl }} data-testid="integration-config">
          <SectionHeader
            title={isArabic ? 'الإعداد' : 'Configuration'}
            description={
              isArabic
                ? 'تُحفظ الإعدادات في خدمة التهيئة وبيانات الاعتماد في خزنة الأسرار. الحفظ لا يُفعّل.'
                : 'Settings go to the Configuration Service, credentials to the secret vault. Saving does not activate.'
            }
          />
          {mayConfigure ? (
            <form action={saveIntegrationConfigurationAction}>
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="category" value={category} />
              <input type="hidden" name="providerKey" value={providerKey} />

              {settingInputs.map((field) => (
                <div
                  key={field.key}
                  style={{
                    display: 'grid',
                    gap: spacingTokens.xs,
                    marginBlockEnd: spacingTokens.md,
                  }}
                >
                  <label htmlFor={`setting-${field.key}`} style={typographyTokens.caption}>
                    {isArabic ? field.labelAr : field.labelEn}
                    {field.required ? ' *' : ''}
                  </label>
                  <input
                    className="bs-control"
                    id={`setting-${field.key}`}
                    name={`setting.${field.key}`}
                    type={field.kind === 'url' ? 'url' : 'text'}
                    required={field.required}
                    defaultValue={view.settings[field.key] ?? ''}
                    style={inputStyle()}
                    data-testid={`setting-${field.key}`}
                  />
                  {field.helpEn ? (
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                      {isArabic ? field.helpAr : field.helpEn}
                    </span>
                  ) : null}
                </div>
              ))}

              {definition.credentialFields.map((field) => {
                const status = view.credentials.find((c) => c.fieldKey === field.key);
                return (
                  <div
                    key={field.key}
                    style={{
                      display: 'grid',
                      gap: spacingTokens.xs,
                      marginBlockEnd: spacingTokens.md,
                    }}
                  >
                    <label htmlFor={`credential-${field.key}`} style={typographyTokens.caption}>
                      {isArabic ? field.labelAr : field.labelEn}
                      {field.required ? ' *' : ''}
                    </label>
                    <input
                      className="bs-control"
                      id={`credential-${field.key}`}
                      name={`credential.${field.key}`}
                      type="password"
                      autoComplete="new-password"
                      // NO defaultValue, and none is possible. A stored secret
                      // cannot be read back by anything in this product.
                      required={field.required && status?.present !== true}
                      style={inputStyle()}
                      data-testid={`credential-input-${field.key}`}
                      placeholder={
                        status?.present
                          ? isArabic
                            ? 'اتركه فارغًا للإبقاء على القيمة الحالية'
                            : 'Leave blank to keep the current value'
                          : isArabic
                            ? 'أدخل القيمة'
                            : 'Enter the value'
                      }
                    />
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                      {status?.present
                        ? isArabic
                          ? 'محفوظة بالفعل. إدخال قيمة جديدة يستبدلها ويُسجَّل كتدوير.'
                          : 'Already saved. Entering a new value replaces it and is recorded as a rotation.'
                        : isArabic
                          ? field.helpAr
                          : field.helpEn}
                    </span>
                  </div>
                );
              })}

              <div
                style={{ display: 'grid', gap: spacingTokens.xs, marginBlockEnd: spacingTokens.md }}
              >
                <label htmlFor="save-reason" style={typographyTokens.caption}>
                  {isArabic ? 'سبب التغيير' : 'Change reason'}
                </label>
                <input
                  className="bs-control"
                  id="save-reason"
                  name="reason"
                  required
                  minLength={8}
                  style={inputStyle()}
                  data-testid="save-reason"
                  placeholder={
                    isArabic ? 'لماذا يتغيّر هذا الآن؟' : 'Why is this changing, in a sentence?'
                  }
                />
              </div>

              <button type="submit" style={primaryButtonStyle()} data-testid="save-configuration">
                {isArabic ? 'حفظ الإعداد' : 'Save configuration'}
              </button>
            </form>
          ) : (
            <p role="note" data-testid="configure-forbidden">
              {isArabic
                ? 'دورك لا يملك صلاحية تعديل التهيئة، لذا هذه الحقول للعرض فقط.'
                : 'Your role may not edit configuration, so these fields are read-only here.'}
            </p>
          )}

          {/*
            WHAT BRANDSPACE GENERATES, shown read-only and copyable. A webhook
            URL is the address of our own route: the owner's job is to paste it
            into the provider's console, and an input for it would be a way to
            point a payment callback somewhere else.
          */}
          {Object.keys(generatedSettings).length > 0 ? (
            <DataTable
              headers={[
                isArabic ? 'قيمة مُولَّدة' : 'Generated value',
                isArabic ? 'القيمة' : 'Value',
              ]}
            >
              {definition.settingFields
                .filter((field) => field.generated === true && generatedSettings[field.key])
                .map((field) => (
                  <tr key={field.key} data-testid={`generated-${field.key}`}>
                    <Cell>{isArabic ? field.labelAr : field.labelEn}</Cell>
                    <Cell>
                      <code style={{ fontFamily: fontTokens.mono }}>
                        {generatedSettings[field.key]}
                      </code>
                    </Cell>
                  </tr>
                ))}
            </DataTable>
          ) : null}
        </div>
      ) : null}

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
                className="bs-control"
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
    case 'CONFIGURATION_SAVED':
      return isArabic
        ? 'تم حفظ الإعداد. لم يُفعَّل شيء.'
        : 'Configuration saved. Nothing was activated.';
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
