import { CONFIG_DOMAIN_KEYS, isConfigDomain } from '@brandspace/config';
import { colorTokens, radiusTokens, spacingTokens } from '@brandspace/ui';
import { errorMessage, successMessage } from '../../../../i18n/status-messages';
import Link from 'next/link';
import { Cell, DataTable, EmptyState, PageHeading } from '../../../../components/admin-shell';
import {
  currentEnvironment,
  getConfigService,
  requirePageActor,
  serviceActor,
} from '../../../../server/platform-context';
import {
  activateAction,
  createDraftAction,
  rollbackAction,
  updateDraftAction,
  validateAction,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function ConfigurationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    domain?: string;
    error?: string;
    ok?: string;
    ref?: string;
    changes?: string;
    high?: string;
    errors?: string;
  }>;
}) {
  const { locale } = await params;
  const search = await searchParams;
  const { domain: rawDomain, error, ok } = search;
  const actor = await requirePageActor(locale, 'platform.configuration.read');
  const mayEdit = actor.permissionKeys.includes('platform.configuration.manage');
  const mayActivate = actor.permissionKeys.includes('platform.configuration.activate');

  const environment = currentEnvironment();
  const domain = rawDomain && isConfigDomain(rawDomain) ? rawDomain : CONFIG_DOMAIN_KEYS[0]!;
  const config = getConfigService();
  const versions = await config.listVersions(serviceActor(actor), domain, environment);
  const isArabic = locale === 'ar';

  // The editable draft, if there is one. Only DRAFT and VALIDATED versions can
  // be edited; an ACTIVE version is the record of what was deployed and the
  // database refuses to rewrite it.
  const editable = versions.find((v) => v.status === 'DRAFT' || v.status === 'VALIDATED');
  const editableVersion =
    editable && mayEdit ? await config.getVersion(serviceActor(actor), editable.id) : null;

  return (
    <>
      <PageHeading
        title={isArabic ? 'إدارة الإعدادات' : 'Configuration management'}
        description={
          isArabic
            ? 'مسودة ← تحقق ← معاينة الأثر ← تفعيل. التاريخ غير قابل للتعديل، والتراجع ينشئ إصدارًا جديدًا.'
            : 'Draft → validate → preview impact → activate. History is immutable; rollback creates a new version.'
        }
      />

      {error ? (
        <p role="alert" data-testid="config-error" style={{ color: colorTokens.danger }}>
          {/* A code from a closed set, rendered here. The server never sends
              text derived from an exception. */}
          {errorMessage(error, locale, search.ref)}
        </p>
      ) : null}
      {ok ? (
        <p role="status" data-testid="config-ok" style={{ color: colorTokens.success }}>
          {successMessage(ok, locale, new URLSearchParams(search as Record<string, string>))}
        </p>
      ) : null}

      <nav
        aria-label={isArabic ? 'مجالات الإعدادات' : 'Configuration domains'}
        style={{ marginBlockEnd: spacingTokens.lg }}
      >
        <ul
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.sm,
            listStyle: 'none',
            padding: 0,
          }}
        >
          {CONFIG_DOMAIN_KEYS.map((key) => (
            <li key={key}>
              <Link
                href={`/${locale}/console/configuration?domain=${encodeURIComponent(key)}`}
                data-testid={`domain-${key}`}
                aria-current={key === domain ? 'page' : undefined}
                style={{
                  display: 'inline-block',
                  padding: `${spacingTokens.xs} ${spacingTokens.sm}`,
                  borderRadius: radiusTokens.full,
                  // Selected by FILL, not by an outline — the same treatment the
                  // navigation and the segmented switchers use.
                  background:
                    key === domain ? colorTokens.brandPurpleTint : colorTokens.controlSurface,
                  color:
                    key === domain ? colorTokens.brandPurplePressed : colorTokens.textSecondary,
                  border: 'none',
                  fontWeight: key === domain ? 600 : 500,
                }}
              >
                {key}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {mayEdit ? (
        <form
          action={createDraftAction}
          style={{
            marginBlockEnd: spacingTokens.lg,
            display: 'grid',
            gap: spacingTokens.sm,
            maxInlineSize: '40rem',
          }}
        >
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="domain" value={domain} />
          <label htmlFor="reason">
            {isArabic ? 'سبب التغيير (٨ أحرف على الأقل)' : 'Change reason (min 8 characters)'}
          </label>
          <input
            id="reason"
            name="reason"
            required
            minLength={8}
            data-testid="draft-reason"
            style={{ padding: spacingTokens.sm }}
          />
          <button type="submit" data-testid="create-draft" style={buttonStyle}>
            {isArabic ? 'إنشاء مسودة' : 'Create draft'}
          </button>
        </form>
      ) : null}

      {editableVersion && mayEdit ? (
        <form
          action={updateDraftAction}
          style={{ marginBlockEnd: spacingTokens.lg, display: 'grid', gap: spacingTokens.sm }}
        >
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="domain" value={domain} />
          <input type="hidden" name="versionId" value={editableVersion.id} />
          {/* The value this page was rendered with. If another administrator
              saves first, this no longer matches and the write is refused
              instead of silently overwriting their edit. */}
          <input
            type="hidden"
            name="lockVersion"
            value={editableVersion.lockVersion}
            data-testid="draft-lock-version"
          />
          <label htmlFor="payload" style={{ fontWeight: 600 }}>
            {isArabic
              ? `تحرير المسودة v${editableVersion.versionNumber} (JSON)`
              : `Edit draft v${editableVersion.versionNumber} (JSON)`}
          </label>
          <p style={{ color: colorTokens.textSecondary, margin: 0, fontSize: '0.875rem' }}>
            {isArabic
              ? 'الحفظ يلغي أي تحقق أو معاينة سابقة؛ يجب إعادة التحقق قبل التفعيل.'
              : 'Saving clears any previous validation and impact preview: re-validate before activating.'}
          </p>
          <textarea
            id="payload"
            name="payload"
            required
            rows={14}
            spellCheck={false}
            data-testid="draft-payload"
            defaultValue={JSON.stringify(editableVersion.payload, null, 2)}
            style={{
              inlineSize: '100%',
              padding: spacingTokens.sm,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.8rem',
              // Configuration is data, not prose: it reads left-to-right even in
              // an Arabic interface.
              direction: 'ltr',
              textAlign: 'start',
            }}
          />
          <div>
            <button type="submit" data-testid="save-draft" style={buttonStyle}>
              {isArabic ? 'حفظ المسودة' : 'Save draft'}
            </button>
          </div>
        </form>
      ) : null}

      <h2 style={{ fontSize: '1.1rem' }}>{isArabic ? 'الإصدارات' : 'Versions'}</h2>
      {versions.length === 0 ? (
        <EmptyState message={isArabic ? 'لا توجد إصدارات بعد.' : 'No versions yet.'} />
      ) : (
        <DataTable
          headers={[
            isArabic ? 'الإصدار' : 'Version',
            isArabic ? 'الحالة' : 'Status',
            isArabic ? 'السبب' : 'Reason',
            isArabic ? 'التحقق' : 'Validation',
            isArabic ? 'الأثر' : 'Impact',
            isArabic ? 'إجراءات' : 'Actions',
          ]}
        >
          {versions.map((version) => {
            const errors =
              version.validationReport?.issues.filter((i) => i.severity === 'error').length ?? 0;
            const high = version.impactPreview?.highImpactCount ?? 0;
            return (
              <tr key={version.id} data-testid={`version-${version.versionNumber}`}>
                <Cell>v{version.versionNumber}</Cell>
                <Cell>
                  <span data-testid={`status-${version.versionNumber}`}>{version.status}</span>
                </Cell>
                <Cell>{version.changeReason}</Cell>
                <Cell>
                  {version.validationReport
                    ? errors === 0
                      ? isArabic
                        ? 'صالح'
                        : 'Valid'
                      : `${errors} ${isArabic ? 'أخطاء' : 'errors'}`
                    : '—'}
                </Cell>
                <Cell>
                  {version.impactPreview
                    ? `${version.impactPreview.changes.length} (${high} high)`
                    : '—'}
                </Cell>
                <Cell>
                  <div style={{ display: 'flex', gap: spacingTokens.xs, flexWrap: 'wrap' }}>
                    {(version.status === 'DRAFT' || version.status === 'VALIDATED') && (
                      <>
                        {mayEdit ? (
                          <form action={validateAction}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="versionId" value={version.id} />
                            <input type="hidden" name="domain" value={domain} />
                            <button
                              type="submit"
                              data-testid={`validate-${version.versionNumber}`}
                              style={smallButton}
                            >
                              {isArabic ? 'تحقق ومعاينة' : 'Validate & preview'}
                            </button>
                          </form>
                        ) : null}
                        {mayActivate ? (
                          <form action={activateAction}>
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="versionId" value={version.id} />
                            <input type="hidden" name="domain" value={domain} />
                            {/* High-impact activation requires an explicit tick —
                              never a browser confirm() dialog. */}
                            {high > 0 ? (
                              <label style={{ display: 'block', fontSize: '0.75rem' }}>
                                <input
                                  type="checkbox"
                                  name="acknowledge"
                                  value="yes"
                                  data-testid={`ack-${version.versionNumber}`}
                                  required
                                />{' '}
                                {isArabic
                                  ? `أُقر بـ ${high} تغيير عالي الأثر`
                                  : `I acknowledge ${high} high-impact change(s)`}
                              </label>
                            ) : null}
                            <button
                              type="submit"
                              data-testid={`activate-${version.versionNumber}`}
                              style={smallButton}
                            >
                              {isArabic ? 'تفعيل' : 'Activate'}
                            </button>
                          </form>
                        ) : null}
                      </>
                    )}
                    {version.status === 'SUPERSEDED' && mayActivate && (
                      <form action={rollbackAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="versionId" value={version.id} />
                        <input type="hidden" name="domain" value={domain} />
                        <input
                          type="text"
                          name="reason"
                          required
                          minLength={8}
                          placeholder={isArabic ? 'سبب التراجع' : 'Rollback reason'}
                          data-testid={`rollback-reason-${version.versionNumber}`}
                          style={{ padding: '2px 4px', fontSize: '0.8rem' }}
                        />
                        <button
                          type="submit"
                          data-testid={`rollback-${version.versionNumber}`}
                          style={smallButton}
                        >
                          {isArabic ? 'تراجع' : 'Roll back'}
                        </button>
                      </form>
                    )}
                  </div>
                </Cell>
              </tr>
            );
          })}
        </DataTable>
      )}
    </>
  );
}

const buttonStyle = {
  padding: spacingTokens.sm,
  background: colorTokens.brandBlueSurface,
  color: colorTokens.brandBlueInk,
  border: 'none',
  borderRadius: '0.5rem',
  cursor: 'pointer',
} as const;

const smallButton = {
  padding: '4px 10px',
  fontSize: '0.8rem',
  background: colorTokens.controlSurface,
  color: colorTokens.textPrimary,
  border: 'none',
  borderRadius: radiusTokens.full,
  cursor: 'pointer',
} as const;
