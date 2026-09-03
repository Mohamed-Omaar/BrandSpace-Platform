import { SECRET_CATEGORY_DEFINITIONS } from '@brandspace/secrets';
import { colorTokens, radiusTokens, spacingTokens } from '@brandspace/ui';
import { errorMessage, successMessage } from '../../../../i18n/status-messages';
import { Cell, DataTable, EmptyState, PageHeading } from '../../../../components/admin-shell';
import {
  currentEnvironment,
  getSecretService,
  requirePageActor,
  serviceActor,
} from '../../../../server/platform-context';
import { createSecretAction, disableSecretAction, rotateSecretAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Secret management.
 *
 * THERE IS NO REVEAL. This page renders masked hints and fingerprints only, and
 * no secret value is ever serialised into the HTML or into client JavaScript.
 * The value exists in the request body on the way in, and nowhere else.
 */
export default async function SecretsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string; ok?: string; ref?: string }>;
}) {
  const { locale } = await params;
  const search = await searchParams;
  const { error, ok } = search;
  const actor = await requirePageActor(locale, 'platform.secret.read');
  const mayManage = actor.permissionKeys.includes('platform.secret.manage');

  const environment = currentEnvironment();
  const secrets = await getSecretService().listSecrets(serviceActor(actor), { environment });
  const isArabic = locale === 'ar';

  return (
    <>
      <PageHeading
        title={isArabic ? 'إدارة المفاتيح السرية' : 'Secret management'}
        description={
          isArabic
            ? 'تُخزَّن مشفّرة بتشفير موثَّق. لا توجد أي طريقة لإظهار القيمة بعد الحفظ.'
            : 'Stored with authenticated encryption. There is no way to display a value after saving.'
        }
      />

      <p
        data-testid="no-reveal-notice"
        style={{
          border: 'none',
          background: colorTokens.surfaceLavender,
          padding: spacingTokens.md,
          borderRadius: radiusTokens.lg,
        }}
      >
        {isArabic
          ? 'يُعرض فقط: الاسم، الفئة، آخر أربعة أحرف، بصمة غير قابلة للعكس، والتواريخ.'
          : 'Shown only: name, category, last four characters, a non-reversible fingerprint, and timestamps.'}
      </p>

      {error ? (
        <p role="alert" data-testid="secret-error" style={{ color: colorTokens.danger }}>
          {errorMessage(error, locale, search.ref)}
        </p>
      ) : null}
      {ok ? (
        <p role="status" data-testid="secret-ok" style={{ color: colorTokens.success }}>
          {successMessage(ok, locale)}
        </p>
      ) : null}

      <h2 style={{ fontSize: '1.1rem' }}>{isArabic ? 'إضافة مفتاح' : 'Add a secret'}</h2>
      {mayManage ? (
        <form
          action={createSecretAction}
          style={{
            display: 'grid',
            gap: spacingTokens.sm,
            maxInlineSize: '40rem',
            marginBlockEnd: spacingTokens.xl,
          }}
        >
          <input type="hidden" name="locale" value={locale} />
          <div>
            <label htmlFor="name" style={labelStyle}>
              {isArabic ? 'الاسم' : 'Name'}
            </label>
            <input
              className="bs-control"
              id="name"
              name="name"
              required
              data-testid="secret-name"
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="category" style={labelStyle}>
              {isArabic ? 'الفئة' : 'Category'}
            </label>
            <select
              className="bs-control"
              id="category"
              name="category"
              required
              data-testid="secret-category"
              style={inputStyle}
            >
              {SECRET_CATEGORY_DEFINITIONS.map((c) => (
                <option key={c.key} value={c.key}>
                  {isArabic ? c.labelAr : c.labelEn}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="provider" style={labelStyle}>
              {isArabic ? 'المزود' : 'Provider'}
            </label>
            <input
              className="bs-control"
              id="provider"
              name="provider"
              required
              data-testid="secret-provider"
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="value" style={labelStyle}>
              {isArabic ? 'القيمة' : 'Value'}
            </label>
            {/* type=password so it is not shoulder-readable; autoComplete off so a
              browser never stores a platform credential. */}
            <input
              className="bs-control"
              id="value"
              name="value"
              type="password"
              required
              autoComplete="off"
              data-testid="secret-value"
              style={inputStyle}
            />
          </div>
          <button type="submit" data-testid="secret-save" style={buttonStyle}>
            {isArabic ? 'حفظ' : 'Save'}
          </button>
        </form>
      ) : null}

      <h2 style={{ fontSize: '1.1rem' }}>{isArabic ? 'المفاتيح المخزَّنة' : 'Stored secrets'}</h2>
      {secrets.length === 0 ? (
        <EmptyState message={isArabic ? 'لا توجد مفاتيح بعد.' : 'No secrets stored yet.'} />
      ) : (
        <DataTable
          headers={[
            isArabic ? 'الاسم' : 'Name',
            isArabic ? 'المرجع' : 'Ref',
            isArabic ? 'الفئة' : 'Category',
            isArabic ? 'مقنّع' : 'Masked',
            isArabic ? 'البصمة' : 'Fingerprint',
            isArabic ? 'الحالة' : 'Status',
            isArabic ? 'إجراءات' : 'Actions',
          ]}
        >
          {secrets.map((secret) => (
            <tr key={secret.id} data-testid={`secret-row-${secret.ref}`}>
              <Cell>{secret.name}</Cell>
              <Cell>
                <code style={{ fontSize: '0.8rem' }}>{secret.ref}</code>
              </Cell>
              <Cell>{secret.category}</Cell>
              <Cell>
                <span data-testid={`masked-${secret.ref}`}>{secret.maskedHint}</span>
              </Cell>
              <Cell>
                <code style={{ fontSize: '0.75rem' }} data-testid={`fingerprint-${secret.ref}`}>
                  {secret.fingerprint?.slice(0, 12)}…
                </code>
              </Cell>
              <Cell>
                <span data-testid={`status-${secret.ref}`}>{secret.status}</span>
              </Cell>
              <Cell>
                <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                  {!mayManage ? (
                    <span data-testid={`readonly-${secret.ref}`}>
                      {isArabic ? 'للعرض فقط' : 'Read-only'}
                    </span>
                  ) : null}
                  {mayManage ? (
                    <>
                      <form action={rotateSecretAction} style={{ display: 'grid', gap: '2px' }}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="secretId" value={secret.id} />
                        <input
                          type="password"
                          name="value"
                          required
                          autoComplete="off"
                          placeholder={isArabic ? 'القيمة الجديدة' : 'New value'}
                          data-testid={`rotate-value-${secret.ref}`}
                          style={smallInput}
                        />
                        <input
                          type="text"
                          name="reason"
                          required
                          minLength={8}
                          placeholder={isArabic ? 'السبب' : 'Reason'}
                          data-testid={`rotate-reason-${secret.ref}`}
                          style={smallInput}
                        />
                        <button
                          type="submit"
                          data-testid={`rotate-${secret.ref}`}
                          style={smallButton}
                        >
                          {isArabic ? 'تدوير' : 'Rotate'}
                        </button>
                      </form>
                      {secret.status === 'ACTIVE' ? (
                        <form action={disableSecretAction} style={{ display: 'grid', gap: '2px' }}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="secretId" value={secret.id} />
                          <input
                            type="text"
                            name="reason"
                            required
                            minLength={8}
                            placeholder={isArabic ? 'سبب التعطيل' : 'Disable reason'}
                            data-testid={`disable-reason-${secret.ref}`}
                            style={smallInput}
                          />
                          <button
                            type="submit"
                            data-testid={`disable-${secret.ref}`}
                            style={smallButton}
                          >
                            {isArabic ? 'تعطيل' : 'Disable'}
                          </button>
                        </form>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </Cell>
            </tr>
          ))}
        </DataTable>
      )}
    </>
  );
}

const labelStyle = { display: 'block', marginBlockEnd: spacingTokens.xs } as const;
const inputStyle = { inlineSize: '100%', padding: spacingTokens.sm } as const;
const smallInput = { padding: '2px 4px', fontSize: '0.8rem', inlineSize: '10rem' } as const;
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
