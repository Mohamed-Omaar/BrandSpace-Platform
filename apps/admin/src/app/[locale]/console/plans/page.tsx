import {
  SectionHeader,
  colorTokens,
  layoutTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { readPlanCatalogue, type PlanDetail } from '@brandspace/entitlements';
import { errorMessage, successMessage } from '../../../../i18n/status-messages';
import { Cell, DataTable, EmptyState, PageIntro } from '../../../../components/admin-shell';
import {
  Banner,
  Card,
  Field,
  StatusPill,
  inputStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  dangerButtonStyle,
} from '../../../../components/console-ui';
import {
  currentEnvironment,
  getConfigService,
  requirePageActor,
} from '../../../../server/platform-context';
import { loadDomainEditor } from '../../../../server/config-draft';
import {
  activatePlansAction,
  discardPlanDraftAction,
  removePlanAction,
  rollbackPlansAction,
  savePlanAction,
  validatePlansAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * The plan editor — Module 3, docs/ADMIN-CONTROL-CENTER.md §4.
 *
 * A STRUCTURED FORM over a configuration draft, not a JSON textarea. The owner
 * types a price into a labelled field; the Configuration Service versions,
 * validates, previews and activates it. Nothing about a plan lives in source.
 *
 * The lifecycle on this page is the one §4.2 defines:
 *
 *   edit a plan  -> a draft opens if none is (so it is one action, not a ritual)
 *   validate     -> schema + semantic checks, and the impact preview together
 *   activate     -> refused while invalid, and while a high-impact change is
 *                   unacknowledged; dual control applies to `plans`
 *   roll back    -> a previous version is restored atomically
 *
 * The supported currencies come from the `operations` domain, so the price
 * table renders exactly the columns the platform actually sells in. There is no
 * conversion anywhere on this page (D-08).
 */

const compactButton = {
  minBlockSize: layoutTokens.controlHeightSm,
  paddingInline: spacingTokens.md,
  fontSize: typographyTokens.caption.fontSize,
} as const;

export default async function PlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    error?: string;
    ok?: string;
    ref?: string;
    plan?: string;
    changes?: string;
    high?: string;
    over?: string;
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

  const state = await loadDomainEditor(actor, 'plans');
  const operations = (await getConfigService().get('operations', currentEnvironment())) as {
    supportedCurrencies?: string[];
  };
  const currencies = (operations.supportedCurrencies ?? []).map((c) => c.toUpperCase());

  const activePlans = readPlanCatalogue(state.activePayload);
  const draftPlans = state.draft ? readPlanCatalogue(state.draft.payload) : [];

  // Which plan the form is editing. A key that is not in the draft is a NEW
  // plan, which is how "add a plan" works without a second screen.
  const editingKey = search.edit ?? null;
  const editing = editingKey
    ? (draftPlans.find((p) => p.key === editingKey) ??
      activePlans.find((p) => p.key === editingKey) ??
      null)
    : null;

  return (
    <>
      <PageIntro
        description={
          isArabic
            ? 'الخطط إعدادات ذات إصدارات: عدّل مسودة، تحقق منها، عاين الأثر، ثم فعّلها. لا يوجد اسم خطة أو سعر أو حد في الكود.'
            : 'Plans are versioned configuration: edit a draft, validate it, preview the impact, then activate. No plan name, price or limit lives in code.'
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
            // Only numbers reach the message renderer; the URL never carries
            // free-form text.
            new URLSearchParams(
              Object.entries(search).flatMap(([key, value]) =>
                value !== undefined && ['changes', 'high', 'over', 'errors'].includes(key)
                  ? [[key, value] as [string, string]]
                  : [],
              ),
            ),
          )}
        </Banner>
      ) : null}

      {currencies.length === 0 ? (
        <Banner tone="warning">
          {isArabic
            ? 'لم تُحدَّد عملات مدعومة في إعدادات التشغيل، لذا لا يمكن التحقق من اكتمال جدول الأسعار.'
            : 'No supported currencies are set in the operations configuration, so price-table completeness cannot be checked.'}
        </Banner>
      ) : null}

      <div className="bs-section-stack">
        {/* ---- The live catalogue ------------------------------------------ */}
        <Card>
          <SectionHeader
            title={isArabic ? 'الخطط المُفعّلة' : 'Active plans'}
            description={
              isArabic
                ? 'ما يحلّه العملاء الآن. تغيير السعر هنا لا يعيد تسعير اشتراك قائم.'
                : 'What customers resolve against right now. Changing a price here never reprices an existing subscription.'
            }
          />
          {activePlans.length === 0 ? (
            <EmptyState
              message={
                isArabic
                  ? 'لم تُفعَّل أي خطة بعد. أنشئ خطة في المسودة أدناه ثم فعّلها.'
                  : 'No plan has been activated yet. Create one in the draft below, then activate it.'
              }
            />
          ) : (
            <PlanTable
              plans={activePlans}
              currencies={currencies}
              locale={locale}
              editable={false}
            />
          )}
        </Card>

        {/* ---- The draft ---------------------------------------------------- */}
        <Card>
          <SectionHeader
            title={isArabic ? 'المسودة' : 'Draft'}
            description={
              state.draft
                ? isArabic
                  ? `الإصدار ${state.draft.versionNumber} — ${state.draft.status}`
                  : `Version ${state.draft.versionNumber} — ${state.draft.status}`
                : isArabic
                  ? 'لا توجد مسودة مفتوحة. حفظ خطة يفتح واحدة من الإصدار المُفعّل.'
                  : 'No draft is open. Saving a plan opens one from the active version.'
            }
          />

          {state.draft ? (
            <>
              <PlanTable
                plans={draftPlans}
                currencies={currencies}
                locale={locale}
                editable={mayEdit}
              />

              {state.validation && state.validation.issues.length > 0 ? (
                <div data-testid="validation-report" style={{ marginBlockStart: spacingTokens.md }}>
                  <SectionHeader title={isArabic ? 'نتيجة التحقق' : 'Validation report'} />
                  <ul style={{ margin: 0, paddingInlineStart: spacingTokens.lg }}>
                    {state.validation.issues.map((issue, index) => (
                      <li
                        key={`${issue.path}-${index}`}
                        data-testid={`issue-${issue.severity}`}
                        style={{
                          color:
                            issue.severity === 'error'
                              ? colorTokens.danger
                              : colorTokens.textSecondary,
                          fontSize: typographyTokens.bodySm.fontSize,
                        }}
                      >
                        <code>{issue.path}</code> — {issue.message}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {state.impact?.affected ? (
                <div data-testid="impact-preview" style={{ marginBlockStart: spacingTokens.md }}>
                  <SectionHeader
                    title={isArabic ? 'معاينة الأثر' : 'Impact preview'}
                    description={
                      isArabic
                        ? `${state.impact.affected.totalOnChangedPlans} مساحة عمل على الخطط المتغيرة.`
                        : `${state.impact.affected.totalOnChangedPlans} workspace(s) on the changed plans.`
                    }
                  />
                  {state.impact.affected.overLimit.length === 0 ? (
                    <p
                      data-testid="none-over-limit"
                      style={{
                        color: colorTokens.textSecondary,
                        fontSize: typographyTokens.bodySm.fontSize,
                      }}
                    >
                      {isArabic
                        ? 'لا توجد مساحة عمل تتجاوز حدًا جديدًا في الأبعاد التي لدينا بيانات عنها.'
                        : 'No workspace exceeds a new limit, in the dimensions we have data for.'}
                    </p>
                  ) : (
                    <DataTable
                      headers={
                        isArabic
                          ? ['مساحة العمل', 'الخطة', 'البُعد', 'الحالي', 'الحد الجديد']
                          : ['Workspace', 'Plan', 'Dimension', 'Current', 'New limit']
                      }
                    >
                      {state.impact.affected.overLimit.map((row) => (
                        <tr
                          key={`${row.workspaceId}-${row.dimension}`}
                          data-testid="over-limit-row"
                        >
                          <Cell>{row.slug}</Cell>
                          <Cell>{row.planKey}</Cell>
                          <Cell>{row.dimension}</Cell>
                          <Cell>{row.current}</Cell>
                          <Cell>{row.newLimit}</Cell>
                        </tr>
                      ))}
                    </DataTable>
                  )}
                  <p
                    style={{
                      color: colorTokens.textSecondary,
                      fontSize: typographyTokens.caption.fontSize,
                      marginBlockStart: spacingTokens.sm,
                    }}
                  >
                    {isArabic
                      ? 'لا يُحذف أي مورد للعميل عند التخفيض (D-12) — ما يتجاوز الحد يصبح للقراءة فقط.'
                      : 'A downgrade never deletes a customer resource (D-12) — anything over the limit becomes read-only.'}
                  </p>
                </div>
              ) : null}

              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: spacingTokens.sm,
                  marginBlockStart: spacingTokens.md,
                }}
              >
                {mayEdit ? (
                  <form action={validatePlansAction}>
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
                      data-testid="validate-plans"
                    >
                      {isArabic ? 'تحقق وعاين الأثر' : 'Validate and preview impact'}
                    </button>
                  </form>
                ) : null}

                {mayActivate ? (
                  <form action={activatePlansAction}>
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
                      <input
                        className="bs-control"
                        type="checkbox"
                        name="acknowledge"
                        value="yes"
                      />
                      {isArabic ? 'أقرّ بالتغييرات عالية الأثر' : 'Acknowledge high-impact changes'}
                    </label>
                    <button type="submit" style={primaryButtonStyle()} data-testid="activate-plans">
                      {isArabic ? 'تفعيل' : 'Activate'}
                    </button>
                  </form>
                ) : null}

                {mayEdit ? (
                  <form action={discardPlanDraftAction}>
                    <input className="bs-control" type="hidden" name="locale" value={locale} />
                    <input
                      className="bs-control"
                      type="hidden"
                      name="versionId"
                      value={state.draft.id}
                    />
                    <input
                      className="bs-control"
                      type="hidden"
                      name="reason"
                      value="Draft discarded from the Control Center."
                    />
                    <button
                      type="submit"
                      style={dangerButtonStyle()}
                      data-testid="discard-plan-draft"
                    >
                      {isArabic ? 'تجاهل المسودة' : 'Discard draft'}
                    </button>
                  </form>
                ) : null}
              </div>
            </>
          ) : (
            <EmptyState message={isArabic ? 'لا توجد مسودة مفتوحة.' : 'No draft is open.'} />
          )}
        </Card>

        {/* ---- The editor --------------------------------------------------- */}
        {mayEdit ? (
          <Card>
            <SectionHeader
              title={
                editing
                  ? isArabic
                    ? `تحرير «${editing.nameEn || editing.key}»`
                    : `Edit "${editing.nameEn || editing.key}"`
                  : isArabic
                    ? 'خطة جديدة'
                    : 'New plan'
              }
              description={
                isArabic
                  ? 'اترك حدًا فارغًا ليعني «غير محدود / متفاوض عليه» — وليس صفرًا.'
                  : 'Leave a limit blank to mean unlimited / negotiated — not zero.'
              }
            />
            <PlanForm
              plan={editing}
              currencies={currencies}
              locale={locale}
              lockVersion={state.draft?.lockVersion ?? null}
            />
          </Card>
        ) : null}

        {/* ---- Version history ---------------------------------------------- */}
        <Card>
          <SectionHeader title={isArabic ? 'سجل الإصدارات' : 'Version history'} />
          {state.versions.length === 0 ? (
            <EmptyState message={isArabic ? 'لا توجد إصدارات بعد.' : 'No versions yet.'} />
          ) : (
            <DataTable
              headers={
                isArabic
                  ? ['الإصدار', 'الحالة', 'أُنشئ', 'فُعِّل', '']
                  : ['Version', 'Status', 'Created', 'Activated', '']
              }
            >
              {state.versions.map((version) => (
                <tr key={version.id} data-testid={`version-${version.versionNumber}`}>
                  <Cell>{version.versionNumber}</Cell>
                  <Cell>
                    <StatusPill status={version.status} />
                  </Cell>
                  <Cell>{version.createdAt.toISOString().slice(0, 10)}</Cell>
                  <Cell>{version.activatedAt?.toISOString().slice(0, 10) ?? '—'}</Cell>
                  <Cell>
                    {mayActivate && version.status === 'SUPERSEDED' ? (
                      <form action={rollbackPlansAction}>
                        <input className="bs-control" type="hidden" name="locale" value={locale} />
                        <input
                          className="bs-control"
                          type="hidden"
                          name="versionId"
                          value={version.id}
                        />
                        <input
                          className="bs-control"
                          type="hidden"
                          name="reason"
                          value="Rolled back from the Control Center."
                        />
                        <button
                          type="submit"
                          style={{ ...secondaryButtonStyle(), ...compactButton }}
                          data-testid={`rollback-${version.versionNumber}`}
                        >
                          {isArabic ? 'استرجاع' : 'Roll back'}
                        </button>
                      </form>
                    ) : (
                      '—'
                    )}
                  </Cell>
                </tr>
              ))}
            </DataTable>
          )}
        </Card>
      </div>
    </>
  );
}

/** The plan directory. Prices render one column per supported currency. */
function PlanTable({
  plans,
  currencies,
  locale,
  editable,
}: {
  readonly plans: readonly PlanDetail[];
  readonly currencies: readonly string[];
  readonly locale: string;
  readonly editable: boolean;
}) {
  const isArabic = locale === 'ar';
  const headers = [
    isArabic ? 'المفتاح' : 'Key',
    isArabic ? 'الاسم' : 'Name',
    isArabic ? 'الحالة' : 'Status',
    ...currencies.map((c) => `${c} / ${isArabic ? 'شهر' : 'mo'}`),
    isArabic ? 'المقاعد' : 'Seats',
    isArabic ? 'العلامات' : 'Brands',
    isArabic ? 'الرصيد الشهري' : 'Credits',
    isArabic ? 'التجربة' : 'Trial',
    '',
  ];

  return (
    <DataTable headers={headers}>
      {plans.map((plan) => (
        <tr key={plan.key} data-testid={`plan-${plan.key}`}>
          <Cell>
            <code>{plan.key}</code>
          </Cell>
          <Cell>{isArabic ? plan.nameAr : plan.nameEn}</Cell>
          <Cell>
            <StatusPill status={plan.status} />
          </Cell>
          {currencies.map((currency) => {
            const price = plan.prices.find((p) => p.currency === currency);
            return (
              <Cell key={currency}>
                {price ? (
                  // Minor units, shown as the currency's own major unit. No
                  // conversion: this is the price the owner typed for THIS
                  // currency (D-08).
                  <span data-testid={`price-${plan.key}-${currency}`}>
                    {(price.monthlyMinor / 100).toFixed(2)}
                  </span>
                ) : (
                  <span data-testid={`price-missing-${plan.key}-${currency}`}>—</span>
                )}
              </Cell>
            );
          })}
          <Cell>{plan.quotas.seats ?? (isArabic ? 'غير محدود' : 'unlimited')}</Cell>
          <Cell>{plan.quotas.brands ?? (isArabic ? 'غير محدود' : 'unlimited')}</Cell>
          <Cell>{plan.monthlyCredits}</Cell>
          <Cell>
            {plan.trialDays > 0
              ? `${plan.trialDays}${isArabic ? ' يوم' : 'd'} / ${plan.trialCredits}`
              : '—'}
          </Cell>
          <Cell>
            {editable ? (
              <div style={{ display: 'flex', gap: spacingTokens.xs }}>
                <a
                  href={`/${locale}/console/plans?edit=${encodeURIComponent(plan.key)}`}
                  style={{ ...secondaryButtonStyle(), ...compactButton, textDecoration: 'none' }}
                  data-testid={`edit-${plan.key}`}
                >
                  {isArabic ? 'تحرير' : 'Edit'}
                </a>
                <form action={removePlanAction}>
                  <input className="bs-control" type="hidden" name="locale" value={locale} />
                  <input className="bs-control" type="hidden" name="key" value={plan.key} />
                  <button
                    type="submit"
                    style={{ ...dangerButtonStyle(), ...compactButton }}
                    data-testid={`remove-${plan.key}`}
                  >
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
  );
}

/** The structured plan form. Every field is a plan attribute §4.1 names. */
function PlanForm({
  plan,
  currencies,
  locale,
  lockVersion,
}: {
  readonly plan: PlanDetail | null;
  readonly currencies: readonly string[];
  readonly locale: string;
  readonly lockVersion: number | null;
}) {
  const isArabic = locale === 'ar';
  const grid = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))',
    gap: spacingTokens.md,
  } as const;

  return (
    <form action={savePlanAction} data-testid="plan-form">
      <input className="bs-control" type="hidden" name="locale" value={locale} />
      <input className="bs-control" type="hidden" name="currencies" value={currencies.join(',')} />
      {lockVersion !== null ? (
        <input className="bs-control" type="hidden" name="lockVersion" value={lockVersion} />
      ) : null}

      <div style={grid}>
        <Field label={isArabic ? 'المفتاح' : 'Key'} htmlFor="plan-key">
          <input
            className="bs-control"
            id="plan-key"
            name="key"
            defaultValue={plan?.key ?? ''}
            required
            style={inputStyle()}
            data-testid="field-key"
          />
        </Field>
        <Field label={isArabic ? 'الاسم (عربي)' : 'Name (Arabic)'} htmlFor="plan-name-ar">
          <input
            className="bs-control"
            id="plan-name-ar"
            name="name.ar"
            defaultValue={plan?.nameAr ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field label={isArabic ? 'الاسم (إنجليزي)' : 'Name (English)'} htmlFor="plan-name-en">
          <input
            className="bs-control"
            id="plan-name-en"
            name="name.en"
            defaultValue={plan?.nameEn ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field label={isArabic ? 'الوصف (عربي)' : 'Description (Arabic)'} htmlFor="plan-desc-ar">
          <input
            className="bs-control"
            id="plan-desc-ar"
            name="description.ar"
            defaultValue={plan?.descriptionAr ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field
          label={isArabic ? 'الوصف (إنجليزي)' : 'Description (English)'}
          htmlFor="plan-desc-en"
        >
          <input
            className="bs-control"
            id="plan-desc-en"
            name="description.en"
            defaultValue={plan?.descriptionEn ?? ''}
            style={inputStyle()}
          />
        </Field>
        <Field label={isArabic ? 'المستوى' : 'Tier'} htmlFor="plan-tier">
          <input
            className="bs-control"
            id="plan-tier"
            name="tier"
            type="number"
            min={0}
            defaultValue={plan?.tier ?? 0}
            style={inputStyle()}
          />
        </Field>
        <Field label={isArabic ? 'الظهور' : 'Visibility'} htmlFor="plan-visibility">
          <select
            className="bs-control"
            id="plan-visibility"
            name="visibility"
            defaultValue={plan?.visibility ?? 'private'}
            style={inputStyle()}
          >
            <option value="public">{isArabic ? 'عام' : 'public'}</option>
            <option value="private">{isArabic ? 'خاص' : 'private'}</option>
            <option value="legacy">{isArabic ? 'قديم' : 'legacy'}</option>
          </select>
        </Field>
        <Field label={isArabic ? 'الحالة' : 'Status'} htmlFor="plan-status">
          <select
            className="bs-control"
            id="plan-status"
            name="status"
            defaultValue={plan?.status ?? 'draft'}
            style={inputStyle()}
            data-testid="field-status"
          >
            <option value="draft">{isArabic ? 'مسودة' : 'draft'}</option>
            <option value="active">{isArabic ? 'مُفعّل' : 'active'}</option>
            <option value="grandfathered">{isArabic ? 'موروث' : 'grandfathered'}</option>
            <option value="retired">{isArabic ? 'متقاعد' : 'retired'}</option>
          </select>
        </Field>
        <Field label={isArabic ? 'الترتيب' : 'Sort order'} htmlFor="plan-sort">
          <input
            className="bs-control"
            id="plan-sort"
            name="sortOrder"
            type="number"
            defaultValue={plan?.sortOrder ?? 0}
            style={inputStyle()}
          />
        </Field>
      </div>

      <SectionHeader
        title={isArabic ? 'الأسعار' : 'Prices'}
        description={
          isArabic
            ? 'بالوحدات الصغرى. لكل عملة سعرها المُدخل صراحة — لا يوجد تحويل عملة في وقت التشغيل (D-08).'
            : 'In minor units. Each currency has its own explicitly entered price — nothing converts at runtime (D-08).'
        }
      />
      <div style={grid}>
        {currencies.map((currency) => {
          const price = plan?.prices.find((p) => p.currency === currency);
          return (
            <div key={currency}>
              <Field
                label={`${currency} — ${isArabic ? 'شهري' : 'monthly'}`}
                htmlFor={`p-${currency}-m`}
              >
                <input
                  className="bs-control"
                  id={`p-${currency}-m`}
                  name={`price.${currency}.monthly`}
                  type="number"
                  min={0}
                  defaultValue={price?.monthlyMinor ?? 0}
                  style={inputStyle()}
                  data-testid={`field-price-${currency}-monthly`}
                />
              </Field>
              <Field
                label={`${currency} — ${isArabic ? 'سنوي' : 'annual'}`}
                htmlFor={`p-${currency}-a`}
              >
                <input
                  className="bs-control"
                  id={`p-${currency}-a`}
                  name={`price.${currency}.annual`}
                  type="number"
                  min={0}
                  defaultValue={price?.annualMinor ?? 0}
                  style={inputStyle()}
                  data-testid={`field-price-${currency}-annual`}
                />
              </Field>
            </div>
          );
        })}
      </div>

      <SectionHeader title={isArabic ? 'التجربة والرصيد' : 'Trial and credits'} />
      <div style={grid}>
        <Field label={isArabic ? 'أيام التجربة' : 'Trial days'} htmlFor="plan-trial-days">
          <input
            className="bs-control"
            id="plan-trial-days"
            name="trialDays"
            type="number"
            min={0}
            defaultValue={plan?.trialDays ?? 0}
            style={inputStyle()}
            data-testid="field-trialDays"
          />
        </Field>
        <Field label={isArabic ? 'رصيد التجربة' : 'Trial credits'} htmlFor="plan-trial-credits">
          <input
            className="bs-control"
            id="plan-trial-credits"
            name="trialCredits"
            type="number"
            min={0}
            defaultValue={plan?.trialCredits ?? 0}
            style={inputStyle()}
            data-testid="field-trialCredits"
          />
        </Field>
        <Field
          label={isArabic ? 'التجربة تتطلب بطاقة' : 'Trial requires a card'}
          htmlFor="plan-trial-card"
        >
          <select
            className="bs-control"
            id="plan-trial-card"
            name="trialRequiresCard"
            defaultValue={plan?.trialRequiresCard ? 'yes' : 'no'}
            style={inputStyle()}
          >
            <option value="no">{isArabic ? 'لا' : 'no'}</option>
            <option value="yes">{isArabic ? 'نعم' : 'yes'}</option>
          </select>
        </Field>
        <Field label={isArabic ? 'الرصيد الشهري' : 'Monthly credits'} htmlFor="plan-credits">
          <input
            className="bs-control"
            id="plan-credits"
            name="monthlyCredits"
            type="number"
            min={0}
            defaultValue={plan?.monthlyCredits ?? 0}
            style={inputStyle()}
            data-testid="field-monthlyCredits"
          />
        </Field>
        <Field label={isArabic ? 'سياسة الترحيل' : 'Rollover policy'} htmlFor="plan-rollover">
          <select
            className="bs-control"
            id="plan-rollover"
            name="rollover.policy"
            defaultValue={plan?.rolloverPolicy ?? 'none'}
            style={inputStyle()}
            data-testid="field-rollover"
          >
            <option value="none">{isArabic ? 'لا ترحيل' : 'none'}</option>
            <option value="capped">{isArabic ? 'بحد أقصى' : 'capped'}</option>
            <option value="full">{isArabic ? 'كامل' : 'full'}</option>
          </select>
        </Field>
        <Field
          label={isArabic ? 'مضاعف الحد الأقصى' : 'Rollover cap (× allowance)'}
          htmlFor="plan-rollover-cap"
        >
          <input
            className="bs-control"
            id="plan-rollover-cap"
            name="rollover.capMultiplier"
            type="number"
            min={0}
            step="0.5"
            defaultValue={plan?.rolloverCapMultiplier ?? 0}
            style={inputStyle()}
          />
        </Field>
      </div>

      <SectionHeader
        title={isArabic ? 'الحدود' : 'Limits'}
        description={
          isArabic
            ? 'اتركه فارغًا ليعني غير محدود / متفاوض عليه.'
            : 'Leave blank to mean unlimited / negotiated.'
        }
      />
      <div style={grid}>
        {(
          [
            ['seats', isArabic ? 'المقاعد' : 'Seats'],
            ['brands', isArabic ? 'العلامات' : 'Brands'],
            ['socialAccounts', isArabic ? 'الحسابات الاجتماعية' : 'Social accounts'],
            ['scheduledPostsPerMonth', isArabic ? 'منشورات مجدولة/شهر' : 'Scheduled posts / month'],
            ['storageGb', isArabic ? 'التخزين (غيغابايت)' : 'Storage (GB)'],
            [
              'analyticsRetentionDays',
              isArabic ? 'حفظ التحليلات (يوم)' : 'Analytics retention (days)',
            ],
          ] as const
        ).map(([field, label]) => (
          <Field key={field} label={label} htmlFor={`quota-${field}`}>
            <input
              className="bs-control"
              id={`quota-${field}`}
              name={`quota.${field}`}
              type="number"
              min={1}
              defaultValue={plan?.quotas[field] ?? ''}
              style={inputStyle()}
              data-testid={`field-quota-${field}`}
            />
          </Field>
        ))}
      </div>

      <div style={{ marginBlockStart: spacingTokens.md }}>
        <Field
          label={isArabic ? 'سبب التغيير' : 'Change reason'}
          htmlFor="plan-reason"
          hint={
            isArabic
              ? '٨ أحرف على الأقل، وإلا سُجّل سبب افتراضي في سجل التدقيق.'
              : 'At least 8 characters, or a stated default is recorded in the audit trail instead.'
          }
        >
          <input
            className="bs-control"
            id="plan-reason"
            name="reason"
            defaultValue=""
            minLength={8}
            placeholder={isArabic ? 'لماذا تغيّرت هذه الخطة؟' : 'Why is this plan changing?'}
            style={inputStyle()}
          />
        </Field>
      </div>

      <div
        style={{
          display: 'flex',
          gap: spacingTokens.sm,
          marginBlockStart: spacingTokens.md,
          borderStartStartRadius: radiusTokens.sm,
        }}
      >
        <button type="submit" style={primaryButtonStyle()} data-testid="save-plan">
          {isArabic ? 'حفظ في المسودة' : 'Save to draft'}
        </button>
      </div>
    </form>
  );
}
