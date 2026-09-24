import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import { readPlanCatalogue, type PlanDetail, type PlanQuotas } from '@brandspace/entitlements';
import {
  Banner,
  Card,
  ContentGrid,
  Field,
  Stack,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  textareaStyle,
  typographyTokens,
  type BadgeTone,
} from '@brandspace/ui';
import { fill, simpleCopy, type SimpleKey } from '../../i18n/simple';
import { loadDomainEditor } from '../../server/config-draft';
import { formatMinor, minorToMajorInput } from '../../server/money';
import { loadCustomersPerPlan } from '../../server/owner-overview';
import { describePlanChanges, type PlanFieldChange } from '../../server/plan-diff';
import { currentEnvironment, getConfigService } from '../../server/platform-context';
import {
  activatePlansAction,
  discardPlanDraftAction,
  savePlanAction,
  validatePlansAction,
} from '../../app/[locale]/console/plans/actions';
import { AdvancedLink } from '../mode-switch';
import { ActionLink, ActionOutcome, SimpleSection, flash, formatCount } from '../simple-ui';

/**
 * PLANS & PRICING, FOR THE OWNER (contract §8).
 *
 * The plan engine is untouched. Cards read the ACTIVE `plans` version; the
 * editor posts to the existing `savePlanAction` (in major units, D-313) which
 * writes a DRAFT; and the pending-changes panel walks the existing lifecycle —
 * `validatePlansAction` (validate + impact preview), `activatePlansAction`
 * (dual control and the high-impact acknowledgement enforced by the service),
 * `discardPlanDraftAction`. Rollback and version history stay in Advanced.
 */

const QUOTAS: readonly (keyof PlanQuotas)[] = [
  'seats',
  'brands',
  'socialAccounts',
  'scheduledPostsPerMonth',
  'storageGb',
  'analyticsRetentionDays',
];

function saleState(plan: PlanDetail): { key: SimpleKey; tone: BadgeTone } {
  if (plan.status === 'active') {
    return plan.visibility === 'public'
      ? { key: 'plans.onSale', tone: 'success' }
      : plan.visibility === 'legacy'
        ? { key: 'plans.legacy', tone: 'neutral' }
        : { key: 'plans.hidden', tone: 'info' };
  }
  if (plan.status === 'draft') return { key: 'plans.draft', tone: 'neutral' };
  if (plan.status === 'grandfathered') return { key: 'plans.grandfathered', tone: 'warning' };
  return { key: 'plans.retired', tone: 'neutral' };
}

function name(locale: string, plan: { nameEn: string; nameAr: string }): string {
  return locale === 'ar' ? plan.nameAr || plan.nameEn : plan.nameEn;
}

export async function SimplePlans({
  locale,
  actor,
  query,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly query: Record<string, string | string[] | undefined>;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console/plans`;
  const environment = currentEnvironment();
  const [state, operations, entitlementDoc, perPlan] = await Promise.all([
    loadDomainEditor(actor, 'plans'),
    getConfigService().get('operations', environment),
    getConfigService().get('entitlements', environment),
    loadCustomersPerPlan(),
  ]);
  const active = readPlanCatalogue(state.activePayload);
  const drafted = state.draft ? readPlanCatalogue(state.draft.payload) : null;
  const mayManage = actor.permissionKeys.includes('platform.configuration.manage');
  const mayActivate = actor.permissionKeys.includes('platform.configuration.activate');
  const editKey = typeof query['edit'] === 'string' ? query['edit'] : null;
  const { ok, error, ref } = flash(query);

  if (editKey !== null && mayManage) {
    const source = drafted ?? active;
    const plan =
      editKey === 'new' ? null : (source.find((candidate) => candidate.key === editKey) ?? null);
    if (editKey === 'new' || plan) {
      const currencies = [
        ...new Set([
          ...operations.supportedCurrencies,
          ...(plan?.prices.map((p) => p.currency) ?? []),
        ]),
      ];
      return (
        <PlanEditor
          locale={locale}
          plan={plan}
          currencies={currencies}
          lockVersion={state.draft?.lockVersion ?? null}
        />
      );
    }
  }

  const includedFeatures = (planKey: string) =>
    entitlementDoc.planEntitlements
      .filter((grant) => grant.planKey === planKey && grant.enabled)
      .map((grant) => entitlementDoc.features.find((feature) => feature.key === grant.featureKey))
      .filter(
        (feature): feature is NonNullable<typeof feature> =>
          feature !== undefined && feature.valueType === 'boolean',
      )
      .map((feature) => (locale === 'ar' ? feature.name.ar : feature.name.en));

  return (
    <Stack>
      <ActionOutcome
        locale={locale}
        ok={ok}
        error={error}
        reference={ref}
        okText={(code) =>
          [
            'DRAFT_SAVED',
            'VALIDATION_PASSED',
            'VALIDATION_FAILED',
            'ACTIVATED',
            'DRAFT_DISCARDED',
            'ROLLED_BACK',
          ].includes(code)
            ? copy(`pc.ok.${code}` as SimpleKey)
            : null
        }
      />
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: spacingTokens.sm,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <p
          style={{
            margin: 0,
            ...typographyTokens.bodySm,
            color: colorTokens.textSecondary,
            maxInlineSize: '68ch',
          }}
        >
          {copy('plans.intro')}
        </p>
        {mayManage ? (
          <ActionLink href={`${base}?edit=new`} variant="primary" testId="plan-add">
            {copy('plans.add')}
          </ActionLink>
        ) : null}
      </div>

      {state.draft && drafted ? (
        <PendingPlans
          locale={locale}
          actor={actor}
          versionId={state.draft.id}
          validated={state.draft.status === 'VALIDATED'}
          authorId={state.draft.createdByPlatformUserId}
          active={active}
          drafted={drafted}
          validation={state.validation}
          impact={state.impact}
          perPlan={perPlan}
          mayManage={mayManage}
          mayActivate={mayActivate}
        />
      ) : null}

      {active.length === 0 ? (
        <Card testId="plans-empty">
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('plans.none')}</p>
        </Card>
      ) : (
        <ContentGrid min="18rem" testId="plan-cards">
          {[...active]
            .sort((a, b) => a.sortOrder - b.sortOrder || a.tier - b.tier)
            .map((plan) => {
              const sale = saleState(plan);
              const features = includedFeatures(plan.key);
              return (
                <Card key={plan.key} testId={`plan-${plan.key}`}>
                  <div style={{ display: 'grid', gap: spacingTokens.sm }}>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        gap: spacingTokens.xs,
                      }}
                    >
                      <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{name(locale, plan)}</h3>
                      <StatusBadge
                        label={copy(sale.key)}
                        tone={sale.tone}
                        dot
                        testId={`plan-${plan.key}-state`}
                      />
                    </div>
                    {(locale === 'ar' ? plan.descriptionAr : plan.descriptionEn) ? (
                      <p
                        style={{
                          margin: 0,
                          ...typographyTokens.bodySm,
                          color: colorTokens.textSecondary,
                        }}
                      >
                        {locale === 'ar' ? plan.descriptionAr : plan.descriptionEn}
                      </p>
                    ) : null}
                    <ul
                      style={{
                        listStyle: 'none',
                        margin: 0,
                        padding: 0,
                        display: 'grid',
                        gap: '2px',
                        ...typographyTokens.bodySm,
                      }}
                    >
                      {plan.prices.length === 0 ? (
                        <li style={{ color: colorTokens.warning }}>{copy('plans.noPrice')}</li>
                      ) : (
                        plan.prices.map((price) => (
                          <li
                            key={price.currency}
                            data-testid={`plan-${plan.key}-price-${price.currency}`}
                          >
                            <strong>
                              {fill(copy('plans.perMonth'), {
                                price: formatMinor(price.monthlyMinor, price.currency, locale),
                              })}
                            </strong>
                            {' · '}
                            {fill(copy('plans.perYear'), {
                              price: formatMinor(price.annualMinor, price.currency, locale),
                            })}
                          </li>
                        ))
                      )}
                    </ul>
                    <p
                      style={{
                        margin: 0,
                        ...typographyTokens.caption,
                        color: colorTokens.textSecondary,
                      }}
                    >
                      {plan.trialDays > 0
                        ? fill(copy('plans.trial'), { days: plan.trialDays })
                        : copy('plans.noTrial')}
                      {' · '}
                      {fill(copy('plans.credits'), {
                        credits: formatCount(locale, plan.monthlyCredits),
                      })}
                    </p>
                    <div>
                      <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                        {copy('plans.limits')}
                      </span>
                      <dl
                        style={{
                          margin: 0,
                          display: 'grid',
                          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                          gap: spacingTokens['3xs'],
                          ...typographyTokens.caption,
                        }}
                      >
                        {QUOTAS.map((quota) => (
                          <div
                            key={quota}
                            style={{
                              padding: spacingTokens.xs,
                              borderRadius: radiusTokens.md,
                              background: colorTokens.surfaceSoft,
                            }}
                          >
                            <dt style={{ color: colorTokens.textMuted }}>
                              {copy(`quota.${quota}` as SimpleKey)}
                            </dt>
                            <dd style={{ margin: 0, fontWeight: 700 }}>
                              {plan.quotas[quota] === null
                                ? copy('plans.unlimited')
                                : formatCount(locale, plan.quotas[quota] as number)}
                            </dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                    <div style={{ display: 'grid', gap: '2px', ...typographyTokens.caption }}>
                      <span style={{ color: colorTokens.textMuted }}>{copy('plans.features')}</span>
                      <span data-testid={`plan-${plan.key}-features`}>
                        {features.length === 0 ? copy('plans.featuresNone') : features.join(' · ')}
                      </span>
                    </div>
                    <p
                      style={{ margin: 0, ...typographyTokens.caption, fontWeight: 700 }}
                      data-testid={`plan-${plan.key}-customers`}
                    >
                      {fill(copy('plans.customers'), {
                        count: formatCount(locale, perPlan.get(plan.key) ?? 0),
                      })}
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
                      {mayManage ? (
                        <ActionLink
                          href={`${base}?edit=${encodeURIComponent(plan.key)}`}
                          testId={`plan-${plan.key}-edit`}
                        >
                          {copy('plans.edit')}
                        </ActionLink>
                      ) : null}
                      <ActionLink href={`/${locale}/console/features`} variant="ghost">
                        {copy('plans.featuresChange')}
                      </ActionLink>
                    </div>
                  </div>
                </Card>
              );
            })}
        </ContentGrid>
      )}

      <div>
        <AdvancedLink
          locale={locale}
          href="/plans"
          label={copy('pc.history')}
          testId="plans-technical"
        />
      </div>
    </Stack>
  );
}

function PendingPlans({
  locale,
  actor,
  versionId,
  validated,
  authorId,
  active,
  drafted,
  validation,
  impact,
  perPlan,
  mayManage,
  mayActivate,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly versionId: string;
  readonly validated: boolean;
  readonly authorId: string | null;
  readonly active: readonly PlanDetail[];
  readonly drafted: readonly PlanDetail[];
  readonly validation: {
    readonly valid: boolean;
    readonly issues: readonly { severity: string; message: string }[];
  } | null;
  readonly impact: {
    readonly highImpactCount: number;
    readonly affected?:
      | {
          readonly overLimit: readonly {
            slug: string;
            dimension: string;
            current: number;
            newLimit: number;
          }[];
        }
      | undefined;
  } | null;
  readonly perPlan: ReadonlyMap<string, number>;
  readonly mayManage: boolean;
  readonly mayActivate: boolean;
}) {
  const copy = simpleCopy(locale);
  const changes = describePlanChanges(active, drafted);
  const errors = validation?.issues.filter((issue) => issue.severity === 'error') ?? [];
  const overLimit = impact?.affected?.overLimit ?? [];
  // Dual control on `plans` (D-31): the author may not activate, except the
  // platform owner. Said up front rather than discovered as an error.
  const dualControlBlocks = authorId === actor.platformUserId && actor.roleKey !== 'platform_owner';
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="versionId" value={versionId} />
    </>
  );
  const value = (change: PlanFieldChange, which: 'before' | 'after'): string => {
    const raw = change[which];
    if (raw === null) return change.field === 'price' ? '—' : copy('plans.unlimited');
    if (change.field === 'price' && change.detail && typeof raw === 'number')
      return formatMinor(raw, change.detail.currency, locale);
    return typeof raw === 'number' ? formatCount(locale, raw) : String(raw);
  };
  const fieldLabel = (change: PlanFieldChange): string => {
    if (change.field === 'price' && change.detail) {
      return fill(copy('pc.price'), {
        currency: change.detail.currency,
        period: copy(`pc.period.${change.detail.period}` as SimpleKey),
      });
    }
    if (
      ['name', 'status', 'visibility', 'trialDays', 'trialCredits', 'monthlyCredits'].includes(
        change.field,
      )
    ) {
      return copy(`pc.field.${change.field}` as SimpleKey);
    }
    return copy(`quota.${change.field}` as SimpleKey);
  };

  return (
    <Card tone="lavender" testId="plans-pending">
      <SimpleSection title={copy('pc.title')} description={copy('pc.intro')}>
        {changes.length === 0 ? (
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('pc.none')}</p>
        ) : (
          <ul
            style={{
              margin: 0,
              paddingInlineStart: spacingTokens.lg,
              display: 'grid',
              gap: spacingTokens.xs,
              ...typographyTokens.bodySm,
            }}
            data-testid="plans-pending-changes"
          >
            {changes.map((change) => (
              <li key={change.key}>
                <strong>
                  {fill(
                    copy(
                      change.kind === 'added'
                        ? 'pc.added'
                        : change.kind === 'removed'
                          ? 'pc.removed'
                          : 'pc.changed',
                    ),
                    {
                      name: name(locale, change),
                    },
                  )}
                </strong>
                {change.changes.length > 0 ? (
                  <ul style={{ margin: 0, paddingInlineStart: spacingTokens.lg }}>
                    {change.changes.map((field, index) => (
                      <li key={index}>
                        {fill(copy('pc.field'), {
                          field: fieldLabel(field),
                          before: value(field, 'before'),
                          after: value(field, 'after'),
                        })}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {change.kind !== 'added' ? (
                  <div style={{ color: colorTokens.textSecondary }}>
                    {fill(copy('pc.customers'), {
                      count: formatCount(locale, perPlan.get(change.key) ?? 0),
                    })}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div style={{ display: 'grid', gap: spacingTokens.sm, marginBlockStart: spacingTokens.md }}>
          {validation === null || (!validated && errors.length === 0) ? (
            <p style={{ margin: 0, ...typographyTokens.bodySm, fontWeight: 600 }}>
              {copy('pc.checkFirst')}
            </p>
          ) : errors.length > 0 ? (
            <Banner tone="error" testId="plans-problems">
              {copy('pc.problems')} {errors.map((issue) => issue.message).join(' ')}
            </Banner>
          ) : (
            <p
              style={{
                margin: 0,
                ...typographyTokens.bodySm,
                color: colorTokens.success,
                fontWeight: 700,
              }}
              data-testid="plans-checked"
            >
              {copy('pc.checked')}
            </p>
          )}
          {overLimit.length > 0 ? (
            <Banner tone="warning" testId="plans-over-limit">
              {fill(copy('pc.overLimit'), { count: overLimit.length })}{' '}
              {overLimit
                .slice(0, 10)
                .map((row) =>
                  fill(copy('pc.overLimitRow'), {
                    customer: row.slug,
                    dimension: row.dimension,
                    current: formatCount(locale, row.current),
                    limit: formatCount(locale, row.newLimit),
                  }),
                )
                .join('; ')}
            </Banner>
          ) : null}
          {dualControlBlocks ? <Banner tone="info">{copy('pc.dualControl')}</Banner> : null}
          {!mayManage && !mayActivate ? (
            <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('pc.forbidden')}</p>
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: spacingTokens.sm,
                  alignItems: 'center',
                }}
              >
                {mayManage ? (
                  <form action={validatePlansAction}>
                    {hidden}
                    <button
                      type="submit"
                      className={buttonClass('neutral')}
                      style={buttonStyle('neutral')}
                      data-testid="plans-check"
                    >
                      {copy('pc.check')}
                    </button>
                  </form>
                ) : null}
                {mayManage ? (
                  <form action={discardPlanDraftAction}>
                    {hidden}
                    <button
                      type="submit"
                      className={buttonClass('ghost')}
                      style={buttonStyle('ghost')}
                      data-testid="plans-discard"
                    >
                      {copy('pc.discard')}
                    </button>
                  </form>
                ) : null}
              </div>
              {mayActivate && validated && errors.length === 0 && !dualControlBlocks ? (
                <form
                  action={activatePlansAction}
                  style={{ display: 'grid', gap: spacingTokens.sm, justifyItems: 'start' }}
                >
                  {hidden}
                  <label
                    style={{
                      display: 'flex',
                      gap: spacingTokens.xs,
                      alignItems: 'start',
                      ...typographyTokens.bodySm,
                      maxInlineSize: '40rem',
                    }}
                  >
                    <input
                      type="checkbox"
                      name="acknowledge"
                      value="yes"
                      required
                      data-testid="plans-ack"
                    />
                    {copy('pc.ack')}
                  </label>
                  <button
                    type="submit"
                    className={buttonClass('primary')}
                    style={buttonStyle('primary')}
                    data-testid="plans-activate"
                  >
                    {copy('pc.activate')}
                  </button>
                </form>
              ) : null}
            </>
          )}
        </div>
      </SimpleSection>
    </Card>
  );
}

function PlanEditor({
  locale,
  plan,
  currencies,
  lockVersion,
}: {
  readonly locale: string;
  readonly plan: PlanDetail | null;
  readonly currencies: readonly string[];
  readonly lockVersion: number | null;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console/plans`;
  const input = { ...inputStyle(), maxInlineSize: '28rem' };
  const small = { ...inputStyle(), maxInlineSize: '12rem' };
  const statusOptions: readonly { value: PlanDetail['status']; key: SimpleKey }[] = [
    { value: 'active', key: 'pe.sale.onSale' },
    { value: 'draft', key: 'pe.sale.draft' },
    { value: 'grandfathered', key: 'pe.sale.grandfathered' },
  ];
  return (
    <Stack>
      <p style={{ margin: 0 }}>
        <ActionLink href={base} variant="ghost" testId="plan-editor-back">
          {copy('pe.back')}
        </ActionLink>
      </p>
      <Card
        title={
          plan ? fill(copy('pe.titleEdit'), { name: name(locale, plan) }) : copy('pe.titleNew')
        }
        description={copy('pe.saveHint')}
        testId="plan-editor"
      >
        <form action={savePlanAction} style={{ display: 'grid', gap: spacingTokens.xs }}>
          <input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="priceUnit" value="major" />
          <input type="hidden" name="currencies" value={currencies.join(',')} />
          <input
            type="hidden"
            name="lockVersion"
            value={lockVersion === null ? '' : String(lockVersion)}
          />
          {/* Preserved exactly: the Simple editor does not express these, and
              the action rebuilds the plan from what is posted. */}
          <input type="hidden" name="tier" value={plan?.tier ?? 0} />
          <input type="hidden" name="sortOrder" value={plan?.sortOrder ?? 0} />
          <input
            type="hidden"
            name="trialRequiresCard"
            value={plan?.trialRequiresCard ? 'yes' : 'no'}
          />
          <input type="hidden" name="rollover.policy" value={plan?.rolloverPolicy ?? 'none'} />
          <input
            type="hidden"
            name="rollover.capMultiplier"
            value={plan?.rolloverCapMultiplier ?? 0}
          />
          {plan ? (
            <input type="hidden" name="key" value={plan.key} />
          ) : (
            <Field label={copy('pe.key')} htmlFor="pe-key" hint={copy('pe.keyHint')}>
              <input
                id="pe-key"
                name="key"
                required
                pattern="[a-z0-9-]+"
                className="bs-control"
                style={input}
                data-testid="pe-key"
              />
            </Field>
          )}
          <ContentGrid min="16rem">
            <Field label={copy('pe.nameEn')} htmlFor="pe-name-en">
              <input
                id="pe-name-en"
                name="name.en"
                required
                defaultValue={plan?.nameEn ?? ''}
                className="bs-control"
                style={input}
                data-testid="pe-name-en"
              />
            </Field>
            <Field label={copy('pe.nameAr')} htmlFor="pe-name-ar">
              <input
                id="pe-name-ar"
                name="name.ar"
                dir="rtl"
                lang="ar"
                required
                defaultValue={plan?.nameAr ?? ''}
                className="bs-control"
                style={input}
                data-testid="pe-name-ar"
              />
            </Field>
            <Field label={copy('pe.descEn')} htmlFor="pe-desc-en">
              <textarea
                id="pe-desc-en"
                name="description.en"
                defaultValue={plan?.descriptionEn ?? ''}
                className="bs-control"
                style={{ ...textareaStyle(), maxInlineSize: '28rem' }}
                rows={2}
              />
            </Field>
            <Field label={copy('pe.descAr')} htmlFor="pe-desc-ar">
              <textarea
                id="pe-desc-ar"
                name="description.ar"
                dir="rtl"
                lang="ar"
                defaultValue={plan?.descriptionAr ?? ''}
                className="bs-control"
                style={{ ...textareaStyle(), maxInlineSize: '28rem' }}
                rows={2}
              />
            </Field>
          </ContentGrid>
          <ContentGrid min="16rem">
            <Field label={copy('pe.sale')} htmlFor="pe-status">
              <select
                id="pe-status"
                name="status"
                defaultValue={plan?.status ?? 'draft'}
                className="bs-control"
                style={input}
                data-testid="pe-status"
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {copy(option.key)}
                  </option>
                ))}
                {plan?.status === 'retired' ? (
                  <option value="retired">{copy('plans.retired')}</option>
                ) : null}
              </select>
            </Field>
            <Field label={copy('pc.field.visibility')} htmlFor="pe-visibility">
              <select
                id="pe-visibility"
                name="visibility"
                defaultValue={plan?.visibility ?? 'private'}
                className="bs-control"
                style={input}
                data-testid="pe-visibility"
              >
                <option value="public">{copy('plans.onSale')}</option>
                <option value="private">{copy('pe.sale.hidden')}</option>
                <option value="legacy">{copy('plans.legacy')}</option>
              </select>
            </Field>
          </ContentGrid>

          <SimpleSection title={copy('pe.prices')} description={copy('pe.pricesHint')}>
            <ContentGrid min="12rem">
              {currencies.map((currency) => {
                const price = plan?.prices.find((row) => row.currency === currency);
                return (
                  <div key={currency} style={{ display: 'grid' }}>
                    <Field
                      label={fill(copy('pe.monthly'), { currency })}
                      htmlFor={`pe-${currency}-m`}
                    >
                      <input
                        id={`pe-${currency}-m`}
                        name={`price.${currency}.monthly`}
                        inputMode="decimal"
                        defaultValue={price ? minorToMajorInput(price.monthlyMinor, currency) : ''}
                        className="bs-control"
                        style={small}
                        data-testid={`pe-price-${currency}-monthly`}
                      />
                    </Field>
                    <Field
                      label={fill(copy('pe.annual'), { currency })}
                      htmlFor={`pe-${currency}-a`}
                    >
                      <input
                        id={`pe-${currency}-a`}
                        name={`price.${currency}.annual`}
                        inputMode="decimal"
                        defaultValue={price ? minorToMajorInput(price.annualMinor, currency) : ''}
                        className="bs-control"
                        style={small}
                        data-testid={`pe-price-${currency}-annual`}
                      />
                    </Field>
                  </div>
                );
              })}
            </ContentGrid>
          </SimpleSection>

          <ContentGrid min="12rem">
            <Field label={copy('pe.trialDays')} htmlFor="pe-trial">
              <input
                id="pe-trial"
                name="trialDays"
                type="number"
                min={0}
                step={1}
                defaultValue={plan?.trialDays ?? 0}
                className="bs-control"
                style={small}
                data-testid="pe-trial-days"
              />
            </Field>
            <Field label={copy('pe.trialCredits')} htmlFor="pe-trial-credits">
              <input
                id="pe-trial-credits"
                name="trialCredits"
                type="number"
                min={0}
                step={1}
                defaultValue={plan?.trialCredits ?? 0}
                className="bs-control"
                style={small}
              />
            </Field>
            <Field label={copy('pe.monthlyCredits')} htmlFor="pe-credits">
              <input
                id="pe-credits"
                name="monthlyCredits"
                type="number"
                min={0}
                step={1}
                defaultValue={plan?.monthlyCredits ?? 0}
                className="bs-control"
                style={small}
                data-testid="pe-monthly-credits"
              />
            </Field>
          </ContentGrid>

          <SimpleSection title={copy('plans.limits')} description={copy('pe.limitsHint')}>
            <ContentGrid min="12rem">
              {QUOTAS.map((quota) => (
                <Field
                  key={quota}
                  label={copy(`quota.${quota}` as SimpleKey)}
                  htmlFor={`pe-quota-${quota}`}
                >
                  <input
                    id={`pe-quota-${quota}`}
                    name={`quota.${quota}`}
                    type="number"
                    min={0}
                    step={1}
                    defaultValue={plan?.quotas[quota] ?? ''}
                    placeholder={copy('plans.unlimited')}
                    className="bs-control"
                    style={small}
                    data-testid={`pe-quota-${quota}`}
                  />
                </Field>
              ))}
            </ContentGrid>
          </SimpleSection>

          <Field label={copy('common.reason')} htmlFor="pe-reason" hint={copy('common.reasonHint')}>
            <input
              id="pe-reason"
              name="reason"
              required
              minLength={8}
              className="bs-control"
              style={input}
              data-testid="pe-reason"
            />
          </Field>
          <div>
            <button
              type="submit"
              className={buttonClass('primary')}
              style={buttonStyle('primary')}
              data-testid="pe-save"
            >
              {copy('pe.save')}
            </button>
          </div>
        </form>
      </Card>
    </Stack>
  );
}
