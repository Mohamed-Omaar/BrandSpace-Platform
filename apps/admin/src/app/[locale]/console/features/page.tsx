import { SectionHeader, colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { readPlanCatalogue } from '@brandspace/entitlements';
import { errorMessage, successMessage } from '../../../../i18n/status-messages';
import { Cell, DataTable, EmptyState, PageIntro } from '../../../../components/admin-shell';
import {
  Banner,
  Card,
  Field,
  StatusPill,
  dangerButtonStyle,
  inputStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
} from '../../../../components/console-ui';
import { requirePageActor } from '../../../../server/platform-context';
import { loadDomainEditor } from '../../../../server/config-draft';
import {
  activateFeaturesAction,
  removeFeatureAction,
  saveFeatureAction,
  savePlanGrantAction,
  validateFeaturesAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * The feature registry and the plan grant matrix — §5.1.
 *
 * A feature has a key, a value type, a default, dependencies and a status.
 * Application code asks `entitlements.can(workspace, 'ai.image_generation')`
 * and never `if (plan === 'growth')`, so this screen is where the vocabulary
 * that code uses is defined — and the matrix below is where each plan says what
 * it grants.
 *
 * The grid renders the plan catalogue against the feature registry, so an
 * unfilled cell is visible as an unfilled cell rather than as a silent "off".
 */

interface FeatureRow {
  readonly key: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly category: string;
  readonly valueType: string;
  readonly defaultValue: unknown;
  readonly enumValues: readonly string[];
  readonly dependsOn: readonly string[];
  readonly status: string;
}

interface GrantRow {
  readonly planKey: string;
  readonly featureKey: string;
  readonly enabled: boolean;
  readonly limitValue: number | null;
  readonly enumValue: string | null;
}

function readFeatures(payload: Record<string, unknown>): FeatureRow[] {
  return ((payload['features'] ?? []) as Record<string, unknown>[]).map((f) => {
    const name = (f['name'] ?? {}) as Record<string, string>;
    const key = String(f['key'] ?? '');
    return {
      key,
      nameAr: name['ar'] ?? key,
      nameEn: name['en'] ?? key,
      category: String(f['category'] ?? 'general'),
      valueType: String(f['valueType'] ?? 'boolean'),
      defaultValue: f['defaultValue'] ?? null,
      enumValues: (f['enumValues'] ?? []) as string[],
      dependsOn: (f['dependsOn'] ?? []) as string[],
      status: String(f['status'] ?? 'active'),
    };
  });
}

function readGrants(payload: Record<string, unknown>): GrantRow[] {
  return ((payload['planEntitlements'] ?? []) as Record<string, unknown>[]).map((g) => ({
    planKey: String(g['planKey'] ?? ''),
    featureKey: String(g['featureKey'] ?? ''),
    enabled: g['enabled'] === true,
    limitValue:
      g['limitValue'] === null || g['limitValue'] === undefined ? null : Number(g['limitValue']),
    enumValue:
      g['enumValue'] === null || g['enumValue'] === undefined ? null : String(g['enumValue']),
  }));
}

export default async function FeaturesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    error?: string;
    ok?: string;
    ref?: string;
    errors?: string;
    edit?: string;
  }>;
}) {
  const { locale } = await params;
  const search = await searchParams;
  const isArabic = locale === 'ar';

  const actor = await requirePageActor(locale, 'platform.configuration.read');
  const mayEdit = actor.permissionKeys.includes('platform.configuration.manage');
  const mayActivate = actor.permissionKeys.includes('platform.configuration.activate');

  const state = await loadDomainEditor(actor, 'entitlements');
  const plansState = await loadDomainEditor(actor, 'plans');
  const source = state.draft?.payload ?? state.activePayload;

  const features = readFeatures(source);
  const grants = readGrants(source);
  const plans = readPlanCatalogue(plansState.draft?.payload ?? plansState.activePayload);

  const editing = search.edit ? (features.find((f) => f.key === search.edit) ?? null) : null;

  const grantFor = (planKey: string, featureKey: string): GrantRow | null =>
    grants.find((g) => g.planKey === planKey && g.featureKey === featureKey) ?? null;

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? 'سجل الميزات ومصفوفة المنح لكل خطة. الشيفرة تسأل عن مفتاح الميزة، ولا تسأل عن اسم الخطة أبدًا.'
            : 'The feature registry and the per-plan grant matrix. Code asks for a feature key, never for a plan name.'
        }
      />

      {search.error ? (
        <Banner tone="error">
          {errorMessage(search.error, locale)}
          {search.ref ? ` (${search.ref})` : ''}
        </Banner>
      ) : null}
      {search.ok ? (
        <Banner tone={search.ok === 'VALIDATION_FAILED' ? 'error' : 'success'}>
          {successMessage(
            search.ok,
            locale,
            new URLSearchParams(search.errors ? { errors: search.errors } : {}),
          )}
        </Banner>
      ) : null}

      <Card>
        <SectionHeader
          title={isArabic ? 'سجل الميزات' : 'Feature registry'}
          description={
            isArabic
              ? 'ميزة غير معرّفة تُحلّ إلى «مغلقة» دائمًا — الخطأ الإملائي لا يمنح صلاحية أبدًا.'
              : 'An undefined feature always resolves to off — a typo never grants access.'
          }
        />
        {features.length === 0 ? (
          <EmptyState
            message={isArabic ? 'لم تُعرَّف أي ميزة بعد.' : 'No feature has been defined yet.'}
          />
        ) : (
          <DataTable
            headers={
              isArabic
                ? ['المفتاح', 'الاسم', 'الفئة', 'النوع', 'الافتراضي', 'يعتمد على', 'الحالة', '']
                : ['Key', 'Name', 'Category', 'Type', 'Default', 'Depends on', 'Status', '']
            }
          >
            {features.map((feature) => (
              <tr key={feature.key} data-testid={`feature-${feature.key}`}>
                <Cell>
                  <code>{feature.key}</code>
                </Cell>
                <Cell>{isArabic ? feature.nameAr : feature.nameEn}</Cell>
                <Cell>{feature.category}</Cell>
                <Cell>{feature.valueType}</Cell>
                <Cell>{JSON.stringify(feature.defaultValue)}</Cell>
                <Cell>{feature.dependsOn.join(', ') || '—'}</Cell>
                <Cell>
                  <StatusPill status={feature.status} />
                </Cell>
                <Cell>
                  {mayEdit ? (
                    <div style={{ display: 'flex', gap: spacingTokens.xs }}>
                      <a
                        href={`/${locale}/console/features?edit=${encodeURIComponent(feature.key)}`}
                        style={{ ...secondaryButtonStyle(), textDecoration: 'none' }}
                        data-testid={`edit-feature-${feature.key}`}
                      >
                        {isArabic ? 'تحرير' : 'Edit'}
                      </a>
                      <form action={removeFeatureAction}>
                        <input className="bs-control" type="hidden" name="locale" value={locale} />
                        <input
                          className="bs-control"
                          type="hidden"
                          name="key"
                          value={feature.key}
                        />
                        <button type="submit" style={dangerButtonStyle()}>
                          {isArabic ? 'إزالة' : 'Remove'}
                        </button>
                      </form>
                    </div>
                  ) : (
                    '—'
                  )}
                </Cell>
              </tr>
            ))}
          </DataTable>
        )}
      </Card>

      {/* ---- The grant matrix --------------------------------------------- */}
      <Card>
        <SectionHeader
          title={isArabic ? 'مصفوفة المنح' : 'Plan grant matrix'}
          description={
            isArabic
              ? 'خلية فارغة تعني «لم يُصرَّح» — وتُحلّ إلى الافتراضي، لا إلى «مغلقة» ضمنيًا.'
              : 'An empty cell means "not stated" and resolves to the feature default — not to a silent off.'
          }
        />
        {features.length === 0 || plans.length === 0 ? (
          <EmptyState
            message={
              isArabic
                ? 'تحتاج المصفوفة إلى خطة واحدة وميزة واحدة على الأقل.'
                : 'The matrix needs at least one plan and one feature.'
            }
          />
        ) : (
          <DataTable headers={[isArabic ? 'الميزة' : 'Feature', ...plans.map((p) => p.key)]}>
            {features.map((feature) => (
              <tr key={feature.key} data-testid={`matrix-${feature.key}`}>
                <Cell>
                  <code>{feature.key}</code>
                </Cell>
                {plans.map((plan) => {
                  const grant = grantFor(plan.key, feature.key);
                  return (
                    <Cell key={plan.key}>
                      <span data-testid={`grant-${plan.key}-${feature.key}`}>
                        {grant === null
                          ? '—'
                          : grant.enabled
                            ? (grant.enumValue ??
                              (grant.limitValue === null
                                ? isArabic
                                  ? 'نعم'
                                  : 'yes'
                                : String(grant.limitValue)))
                            : isArabic
                              ? 'لا'
                              : 'no'}
                      </span>
                    </Cell>
                  );
                })}
              </tr>
            ))}
          </DataTable>
        )}

        {mayEdit && plans.length > 0 && features.length > 0 ? (
          <form
            action={savePlanGrantAction}
            style={{ marginBlockStart: spacingTokens.lg }}
            data-testid="grant-form"
          >
            <input className="bs-control" type="hidden" name="locale" value={locale} />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))',
                gap: spacingTokens.md,
              }}
            >
              <Field label={isArabic ? 'الخطة' : 'Plan'} htmlFor="grant-plan">
                <select
                  className="bs-control"
                  id="grant-plan"
                  name="planKey"
                  style={inputStyle()}
                  data-testid="grant-plan"
                >
                  {plans.map((plan) => (
                    <option key={plan.key} value={plan.key}>
                      {plan.key}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={isArabic ? 'الميزة' : 'Feature'} htmlFor="grant-feature">
                <select
                  className="bs-control"
                  id="grant-feature"
                  name="featureKey"
                  style={inputStyle()}
                  data-testid="grant-feature"
                >
                  {features.map((feature) => (
                    <option key={feature.key} value={feature.key}>
                      {feature.key}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={isArabic ? 'مُفعّل' : 'Enabled'} htmlFor="grant-enabled">
                <select
                  className="bs-control"
                  id="grant-enabled"
                  name="enabled"
                  defaultValue="true"
                  style={inputStyle()}
                  data-testid="grant-enabled"
                >
                  <option value="true">{isArabic ? 'نعم' : 'yes'}</option>
                  <option value="false">{isArabic ? 'لا' : 'no'}</option>
                </select>
              </Field>
              <Field
                label={isArabic ? 'الحد' : 'Limit'}
                htmlFor="grant-limit"
                hint={isArabic ? 'فارغ = غير محدود' : 'blank = unlimited'}
              >
                <input
                  className="bs-control"
                  id="grant-limit"
                  name="limitValue"
                  type="number"
                  style={inputStyle()}
                  data-testid="grant-limit"
                />
              </Field>
              <Field label={isArabic ? 'النافذة' : 'Period'} htmlFor="grant-period">
                <select
                  className="bs-control"
                  id="grant-period"
                  name="limitPeriod"
                  defaultValue=""
                  style={inputStyle()}
                >
                  <option value="">—</option>
                  <option value="day">day</option>
                  <option value="month">month</option>
                  <option value="billing_cycle">billing_cycle</option>
                  <option value="total">total</option>
                </select>
              </Field>
              <Field label={isArabic ? 'قيمة التعداد' : 'Enum value'} htmlFor="grant-enum">
                <input
                  className="bs-control"
                  id="grant-enum"
                  name="enumValue"
                  style={inputStyle()}
                />
              </Field>
            </div>
            <button type="submit" style={primaryButtonStyle()} data-testid="save-grant">
              {isArabic ? 'حفظ المنح' : 'Save grant'}
            </button>
          </form>
        ) : null}
      </Card>

      {/* ---- The feature editor -------------------------------------------- */}
      {mayEdit ? (
        <Card>
          <SectionHeader
            title={
              editing
                ? isArabic
                  ? `تحرير «${editing.key}»`
                  : `Edit "${editing.key}"`
                : isArabic
                  ? 'ميزة جديدة'
                  : 'New feature'
            }
          />
          <form action={saveFeatureAction} data-testid="feature-form">
            <input className="bs-control" type="hidden" name="locale" value={locale} />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
                gap: spacingTokens.md,
              }}
            >
              <Field label={isArabic ? 'المفتاح' : 'Key'} htmlFor="feature-key">
                <input
                  className="bs-control"
                  id="feature-key"
                  name="key"
                  required
                  defaultValue={editing?.key ?? ''}
                  style={inputStyle()}
                  data-testid="feature-key"
                />
              </Field>
              <Field label={isArabic ? 'الاسم (عربي)' : 'Name (Arabic)'} htmlFor="feature-name-ar">
                <input
                  className="bs-control"
                  id="feature-name-ar"
                  name="name.ar"
                  defaultValue={editing?.nameAr ?? ''}
                  style={inputStyle()}
                />
              </Field>
              <Field
                label={isArabic ? 'الاسم (إنجليزي)' : 'Name (English)'}
                htmlFor="feature-name-en"
              >
                <input
                  className="bs-control"
                  id="feature-name-en"
                  name="name.en"
                  defaultValue={editing?.nameEn ?? ''}
                  style={inputStyle()}
                />
              </Field>
              <Field label={isArabic ? 'الفئة' : 'Category'} htmlFor="feature-category">
                <input
                  className="bs-control"
                  id="feature-category"
                  name="category"
                  defaultValue={editing?.category ?? 'general'}
                  style={inputStyle()}
                />
              </Field>
              <Field label={isArabic ? 'النوع' : 'Value type'} htmlFor="feature-type">
                <select
                  className="bs-control"
                  id="feature-type"
                  name="valueType"
                  defaultValue={editing?.valueType ?? 'boolean'}
                  style={inputStyle()}
                  data-testid="feature-type"
                >
                  <option value="boolean">boolean</option>
                  <option value="quota">quota</option>
                  <option value="enum">enum</option>
                </select>
              </Field>
              <Field
                label={isArabic ? 'القيمة الافتراضية' : 'Default value'}
                htmlFor="feature-default"
                hint={isArabic ? 'فارغ = لا شيء' : 'blank = none'}
              >
                <input
                  className="bs-control"
                  id="feature-default"
                  name="defaultValue"
                  defaultValue={
                    editing?.defaultValue === null || editing?.defaultValue === undefined
                      ? ''
                      : String(editing.defaultValue)
                  }
                  style={inputStyle()}
                />
              </Field>
              <Field
                label={isArabic ? 'قيم التعداد' : 'Enum values'}
                htmlFor="feature-enum"
                hint={isArabic ? 'مفصولة بفواصل' : 'comma separated'}
              >
                <input
                  className="bs-control"
                  id="feature-enum"
                  name="enumValues"
                  defaultValue={editing?.enumValues.join(', ') ?? ''}
                  style={inputStyle()}
                />
              </Field>
              <Field
                label={isArabic ? 'يعتمد على' : 'Depends on'}
                htmlFor="feature-depends"
                hint={isArabic ? 'مفصولة بفواصل' : 'comma separated'}
              >
                <input
                  className="bs-control"
                  id="feature-depends"
                  name="dependsOn"
                  defaultValue={editing?.dependsOn.join(', ') ?? ''}
                  style={inputStyle()}
                  data-testid="feature-depends"
                />
              </Field>
              <Field label={isArabic ? 'الحالة' : 'Status'} htmlFor="feature-status">
                <select
                  className="bs-control"
                  id="feature-status"
                  name="status"
                  defaultValue={editing?.status ?? 'active'}
                  style={inputStyle()}
                >
                  <option value="active">active</option>
                  <option value="deprecated">deprecated</option>
                </select>
              </Field>
            </div>
            <button type="submit" style={primaryButtonStyle()} data-testid="save-feature">
              {isArabic ? 'حفظ في المسودة' : 'Save to draft'}
            </button>
          </form>
        </Card>
      ) : null}

      {/* ---- Draft lifecycle ----------------------------------------------- */}
      {state.draft ? (
        <Card>
          <SectionHeader
            title={isArabic ? 'المسودة' : 'Draft'}
            description={
              isArabic
                ? `الإصدار ${state.draft.versionNumber} — ${state.draft.status}`
                : `Version ${state.draft.versionNumber} — ${state.draft.status}`
            }
          />
          {state.validation && state.validation.issues.length > 0 ? (
            <ul
              data-testid="feature-validation"
              style={{ margin: 0, paddingInlineStart: spacingTokens.lg }}
            >
              {state.validation.issues.map((issue, index) => (
                <li
                  key={`${issue.path}-${index}`}
                  data-testid={`issue-${issue.severity}`}
                  style={{
                    color:
                      issue.severity === 'error' ? colorTokens.danger : colorTokens.textSecondary,
                    fontSize: typographyTokens.bodySm.fontSize,
                  }}
                >
                  <code>{issue.path}</code> — {issue.message}
                </li>
              ))}
            </ul>
          ) : null}

          <div
            style={{ display: 'flex', gap: spacingTokens.sm, marginBlockStart: spacingTokens.md }}
          >
            {mayEdit ? (
              <form action={validateFeaturesAction}>
                <input className="bs-control" type="hidden" name="locale" value={locale} />
                <input
                  className="bs-control"
                  type="hidden"
                  name="versionId"
                  value={state.draft.id}
                />
                <button
                  type="submit"
                  style={secondaryButtonStyle()}
                  data-testid="validate-features"
                >
                  {isArabic ? 'تحقق' : 'Validate'}
                </button>
              </form>
            ) : null}
            {mayActivate ? (
              <form action={activateFeaturesAction}>
                <input className="bs-control" type="hidden" name="locale" value={locale} />
                <input
                  className="bs-control"
                  type="hidden"
                  name="versionId"
                  value={state.draft.id}
                />
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: spacingTokens.xs,
                    fontSize: typographyTokens.caption.fontSize,
                    marginInlineEnd: spacingTokens.sm,
                  }}
                >
                  <input className="bs-control" type="checkbox" name="acknowledge" value="yes" />
                  {isArabic ? 'أقرّ بالتغييرات عالية الأثر' : 'Acknowledge high-impact changes'}
                </label>
                <button type="submit" style={primaryButtonStyle()} data-testid="activate-features">
                  {isArabic ? 'تفعيل' : 'Activate'}
                </button>
              </form>
            ) : null}
          </div>
        </Card>
      ) : null}
    </>
  );
}
