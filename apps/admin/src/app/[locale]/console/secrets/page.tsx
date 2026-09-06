import { SECRET_CATEGORY_DEFINITIONS } from '@brandspace/secrets';
import {
  SectionHeader,
  colorTokens,
  fontTokens,
  layoutTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { errorMessage, successMessage } from '../../../../i18n/status-messages';
import { Cell, DataTable, EmptyState, PageIntro } from '../../../../components/admin-shell';
import {
  inputStyle as sharedInputStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
} from '../../../../components/console-ui';
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
      <PageIntro
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

      <SectionHeader title={isArabic ? 'إضافة مفتاح' : 'Add a secret'} />
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
              style={fieldStyle}
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
              style={fieldStyle}
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
              style={fieldStyle}
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
              style={fieldStyle}
            />
          </div>
          <button type="submit" data-testid="secret-save" style={buttonStyle}>
            {isArabic ? 'حفظ' : 'Save'}
          </button>
        </form>
      ) : null}

      <SectionHeader title={isArabic ? 'المفاتيح المخزَّنة' : 'Stored secrets'} />
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
                <code style={{ ...typographyTokens.caption, fontFamily: fontTokens.mono }}>
                  {secret.ref}
                </code>
              </Cell>
              <Cell>{secret.category}</Cell>
              <Cell>
                <span data-testid={`masked-${secret.ref}`}>{secret.maskedHint}</span>
              </Cell>
              <Cell>
                <code
                  style={{ ...typographyTokens.caption, fontFamily: fontTokens.mono }}
                  data-testid={`fingerprint-${secret.ref}`}
                >
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
                          className="bs-control"
                          type="password"
                          name="value"
                          required
                          autoComplete="off"
                          aria-label={isArabic ? 'القيمة الجديدة' : 'New value'}
                          placeholder={isArabic ? 'القيمة الجديدة' : 'New value'}
                          data-testid={`rotate-value-${secret.ref}`}
                          style={smallInput}
                        />
                        <input
                          className="bs-control"
                          type="text"
                          name="reason"
                          required
                          minLength={8}
                          aria-label={isArabic ? 'سبب التدوير' : 'Rotation reason'}
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
                            className="bs-control"
                            type="text"
                            name="reason"
                            required
                            minLength={8}
                            aria-label={isArabic ? 'سبب التعطيل' : 'Disable reason'}
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

/*
 * FIVE LOCAL STYLE LITERALS, NOW NONE (§15).
 *
 * `buttonStyle` was the PUBLIC MARKETING SITE's identity blue on a Control
 * Center form — it matched nothing else in the product and predates the design
 * system. `smallInput` was a 0.8rem box with 2px of padding, well under the
 * 24px WCAG 2.5.8 target and invisible without a border. All five are replaced
 * by the design system's own, which is the point of having one.
 */
const labelStyle = {
  display: 'block',
  marginBlockEnd: spacingTokens.xs,
  ...typographyTokens.label,
  color: colorTokens.textSecondary,
} as const;
const fieldStyle = { ...sharedInputStyle(), maxInlineSize: 'none' } as const;
const smallInput = {
  ...sharedInputStyle(),
  minBlockSize: layoutTokens.controlHeightSm,
  maxInlineSize: '11rem',
} as const;
const buttonStyle = primaryButtonStyle();
const smallButton = {
  ...secondaryButtonStyle(),
  minBlockSize: layoutTokens.controlHeightSm,
  paddingInline: spacingTokens.md,
  fontSize: typographyTokens.caption.fontSize,
} as const;
