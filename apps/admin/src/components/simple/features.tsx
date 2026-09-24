import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import { systemClock } from '@brandspace/shared';
import { readPlanCatalogue, type PlanDetail } from '@brandspace/entitlements';
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
  typographyTokens,
  type BadgeTone,
} from '@brandspace/ui';
import { fill, simpleCopy, type SimpleKey } from '../../i18n/simple';
import {
  featureAccess,
  simpleEditable,
  type FeatureAccess,
  type FlagShape,
  type GrantShape,
  type SimpleChoice,
} from '../../server/feature-access';
import { loadCustomersPerPlan } from '../../server/owner-overview';
import {
  currentEnvironment,
  getConfigService,
  getPlatformPrisma,
} from '../../server/platform-context';
import { setFeatureAccessAction } from '../../app/[locale]/console/features/simple-actions';
import { AdvancedLink } from '../mode-switch';
import { ActionLink, ActionOutcome, flash, formatCount } from '../simple-ui';

/**
 * FEATURES, ON AND OFF (contract §9).
 *
 * Reads the ACTIVE `entitlements` and `feature-flags` documents and says, per
 * feature, who gets it — computed the way the engine decides (see
 * `feature-access.ts`). Changing it is a two-step, deliberate flow: choose,
 * preview in plain language (a GET, so looking changes nothing), then activate
 * with a reason and a confirmation through `setFeatureAccessAction`.
 */

function planLabel(locale: string, plans: readonly PlanDetail[], key: string): string {
  const plan = plans.find((candidate) => candidate.key === key);
  return plan ? (locale === 'ar' ? plan.nameAr || plan.nameEn : plan.nameEn) : key;
}

function summary(
  locale: string,
  access: FeatureAccess,
  plans: readonly PlanDetail[],
): { text: string; tone: BadgeTone } {
  const copy = simpleCopy(locale);
  switch (access.kind) {
    case 'everyone':
      return { text: copy('feat.everyone'), tone: 'success' };
    case 'nobody':
      return { text: copy('feat.nobody'), tone: 'neutral' };
    case 'plans':
      return access.plans.length === 0
        ? { text: copy('feat.plansNone'), tone: 'neutral' }
        : {
            text: fill(copy('feat.plans'), {
              plans: access.plans.map((key) => planLabel(locale, plans, key)).join(', '),
            }),
            tone: 'info',
          };
    case 'kill_switch':
      return { text: copy('feat.killSwitch'), tone: 'danger' };
    case 'custom':
      return { text: copy('feat.custom'), tone: 'accent' };
    case 'not_boolean':
      return { text: copy('feat.perPlan'), tone: 'neutral' };
  }
}

function enabledPlans(access: FeatureAccess, planKeys: readonly string[]): readonly string[] {
  if (access.kind === 'everyone') return planKeys;
  if (access.kind === 'plans') return access.plans;
  return [];
}

export async function SimpleFeatures({
  locale,
  actor,
  query,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly query: Record<string, string | string[] | undefined>;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console/features`;
  const environment = currentEnvironment();
  const config = getConfigService();
  const [entitlements, flagsDoc, plansPayload, perPlan, overrides] = await Promise.all([
    config.get('entitlements', environment),
    config.get('feature-flags', environment),
    config.get('plans', environment),
    loadCustomersPerPlan(),
    getPlatformPrisma().workspaceOverride.groupBy({
      by: ['featureKey'],
      where: { OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: systemClock.now() } }] },
      _count: { _all: true },
    }),
  ]);
  const plans = readPlanCatalogue(plansPayload as unknown as Record<string, unknown>);
  const planKeys = plans.map((plan) => plan.key);
  const mayChange =
    actor.permissionKeys.includes('platform.configuration.manage') &&
    actor.permissionKeys.includes('platform.configuration.activate');
  const flags = flagsDoc.flags as readonly FlagShape[];
  const grants = entitlements.planEntitlements as readonly GrantShape[];
  const rows = [...entitlements.features]
    .sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key))
    .map((feature) => ({
      feature,
      name: locale === 'ar' ? feature.name.ar : feature.name.en,
      exceptions: overrides.find((row) => row.featureKey === feature.key)?._count._all ?? 0,
      access: featureAccess({
        valueType: feature.valueType,
        defaultValue: feature.defaultValue,
        flag: flags.find((flag) => flag.featureKey === feature.key) ?? null,
        grants: grants.filter((grant) => grant.featureKey === feature.key),
        planKeys,
      }),
    }));

  const { ok, error, ref } = flash(query);
  const focusKey = typeof query['feature'] === 'string' ? query['feature'] : null;
  const focus = focusKey ? (rows.find((row) => row.feature.key === focusKey) ?? null) : null;
  const rawChoice = typeof query['access'] === 'string' ? query['access'] : null;
  const choice: SimpleChoice | null =
    rawChoice === 'everyone' || rawChoice === 'plans' || rawChoice === 'nobody' ? rawChoice : null;
  const chosenPlans = (
    Array.isArray(query['plans']) ? query['plans'] : query['plans'] ? [query['plans']] : []
  ).filter((key): key is string => typeof key === 'string' && planKeys.includes(key));

  const outcome = (
    <ActionOutcome
      locale={locale}
      ok={ok}
      error={error}
      reference={ref}
      okText={(code) => (code === 'ACCESS_CHANGED' ? copy('feat.ok') : null)}
      errorText={(code) =>
        ['DRAFT_OPEN', 'UNCHANGED', 'NOT_SIMPLE'].includes(code)
          ? copy(`feat.error.${code}` as SimpleKey)
          : null
      }
    />
  );

  if (focus && mayChange && simpleEditable(focus.access)) {
    const current = focus.access;
    const currentChoice: SimpleChoice =
      current.kind === 'everyone' ? 'everyone' : current.kind === 'nobody' ? 'nobody' : 'plans';
    const currentPlans = enabledPlans(current, planKeys);

    if (!choice) {
      return (
        <Stack>
          {outcome}
          <p style={{ margin: 0 }}>
            <ActionLink href={base} variant="ghost" testId="feature-back">
              {fill(copy('common.backTo'), { page: copy('page.features') })}
            </ActionLink>
          </p>
          <Card title={fill(copy('feat.choose'), { feature: focus.name })} testId="feature-choose">
            <form method="get" action={base} style={{ display: 'grid', gap: spacingTokens.sm }}>
              <input type="hidden" name="feature" value={focus.feature.key} />
              <fieldset
                style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: spacingTokens.sm }}
              >
                <legend
                  style={{
                    ...typographyTokens.caption,
                    color: colorTokens.textMuted,
                    marginBlockEnd: spacingTokens.xs,
                  }}
                >
                  {copy('feat.change')}
                </legend>
                {(['everyone', 'plans', 'nobody'] as const).map((option) => (
                  <label
                    key={option}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr',
                      gap: spacingTokens.xs,
                      padding: spacingTokens.sm,
                      borderRadius: radiusTokens.control,
                      background: colorTokens.surfaceSoft,
                      ...typographyTokens.bodySm,
                    }}
                  >
                    <input
                      type="radio"
                      name="access"
                      value={option}
                      defaultChecked={option === currentChoice}
                      data-testid={`feature-access-${option}`}
                    />
                    <span>
                      <strong>{copy(`feat.opt.${option}` as SimpleKey)}</strong>
                      <span style={{ display: 'block', color: colorTokens.textSecondary }}>
                        {copy(`feat.opt.${option}Hint` as SimpleKey)}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <fieldset
                style={{
                  border: 0,
                  margin: 0,
                  paddingInlineStart: spacingTokens.lg,
                  display: 'grid',
                  gap: spacingTokens.xs,
                }}
              >
                <legend style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                  {copy('feat.opt.plans')}
                </legend>
                {plans.map((plan) => (
                  <label
                    key={plan.key}
                    style={{
                      display: 'flex',
                      gap: spacingTokens.xs,
                      alignItems: 'center',
                      ...typographyTokens.bodySm,
                    }}
                  >
                    <input
                      type="checkbox"
                      name="plans"
                      value={plan.key}
                      defaultChecked={currentPlans.includes(plan.key)}
                      data-testid={`feature-plan-${plan.key}`}
                    />
                    {planLabel(locale, plans, plan.key)}
                  </label>
                ))}
              </fieldset>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
                <button
                  type="submit"
                  className={buttonClass('primary')}
                  style={buttonStyle('primary')}
                  data-testid="feature-preview"
                >
                  {copy('feat.preview')}
                </button>
                <ActionLink href={base} variant="ghost">
                  {copy('feat.cancel')}
                </ActionLink>
              </div>
            </form>
          </Card>
        </Stack>
      );
    }

    const nextPlans = choice === 'everyone' ? planKeys : choice === 'nobody' ? [] : chosenPlans;
    const lines: string[] = [];
    if (choice === 'everyone')
      lines.push(fill(copy('feat.review.everyone'), { feature: focus.name }));
    if (choice === 'nobody') lines.push(fill(copy('feat.review.nobody'), { feature: focus.name }));
    if (choice === 'plans') {
      lines.push(
        fill(copy('feat.review.selected'), {
          plans:
            nextPlans.length === 0
              ? copy('common.none')
              : nextPlans.map((key) => planLabel(locale, plans, key)).join(', '),
        }),
      );
    }
    let movement = 0;
    for (const planKey of planKeys) {
      const before = currentPlans.includes(planKey);
      const after = nextPlans.includes(planKey);
      if (before === after) continue;
      movement += 1;
      lines.push(
        fill(copy(after ? 'feat.review.gain' : 'feat.review.lose'), {
          plan: planLabel(locale, plans, planKey),
          count: formatCount(locale, perPlan.get(planKey) ?? 0),
          feature: focus.name,
        }),
      );
    }
    if (movement === 0 && choice === 'plans') lines.push(copy('feat.review.same'));
    if (focus.exceptions > 0)
      lines.push(fill(copy('feat.review.exceptions'), { count: focus.exceptions }));

    return (
      <Stack>
        {outcome}
        <p style={{ margin: 0 }}>
          <ActionLink
            href={`${base}?feature=${encodeURIComponent(focus.feature.key)}`}
            variant="ghost"
            testId="feature-back"
          >
            {fill(copy('common.backTo'), { page: copy('common.back') })}
          </ActionLink>
        </p>
        <Card
          title={copy('feat.review')}
          description={focus.name}
          tone="lavender"
          testId="feature-review"
        >
          <ul
            style={{
              margin: 0,
              paddingInlineStart: spacingTokens.lg,
              display: 'grid',
              gap: spacingTokens.xs,
              ...typographyTokens.bodySm,
            }}
            data-testid="feature-review-lines"
          >
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <form
            action={setFeatureAccessAction}
            style={{ display: 'grid', gap: spacingTokens.sm, marginBlockStart: spacingTokens.md }}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="featureKey" value={focus.feature.key} />
            <input type="hidden" name="access" value={choice} />
            {nextPlans.map((key) =>
              choice === 'plans' ? (
                <input key={key} type="hidden" name="plans" value={key} />
              ) : null,
            )}
            <Field
              label={copy('common.reason')}
              htmlFor="feature-reason"
              hint={copy('common.reasonHint')}
            >
              <input
                id="feature-reason"
                name="reason"
                required
                minLength={8}
                className="bs-control"
                style={{ ...inputStyle(), maxInlineSize: '28rem' }}
                data-testid="feature-reason"
              />
            </Field>
            <label
              style={{
                display: 'flex',
                gap: spacingTokens.xs,
                alignItems: 'start',
                ...typographyTokens.bodySm,
              }}
            >
              <input
                type="checkbox"
                name="confirm"
                value="yes"
                required
                data-testid="feature-confirm"
              />
              {copy('feat.confirm')}
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
              <button
                type="submit"
                className={buttonClass('primary')}
                style={buttonStyle('primary')}
                data-testid="feature-apply"
              >
                {copy('feat.apply')}
              </button>
              <ActionLink href={base} variant="ghost">
                {copy('feat.cancel')}
              </ActionLink>
            </div>
          </form>
        </Card>
      </Stack>
    );
  }

  return (
    <Stack>
      {outcome}
      <p
        style={{
          margin: 0,
          ...typographyTokens.bodySm,
          color: colorTokens.textSecondary,
          maxInlineSize: '68ch',
        }}
      >
        {copy('feat.intro')}
      </p>
      {!mayChange ? <Banner tone="info">{copy('feat.forbidden')}</Banner> : null}
      {rows.length === 0 ? (
        <Card testId="features-empty">
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('feat.none')}</p>
        </Card>
      ) : (
        <ContentGrid min="17rem" testId="feature-cards">
          {rows.map((row) => {
            const state = summary(locale, row.access, plans);
            const editable = mayChange && simpleEditable(row.access);
            const note =
              row.access.kind === 'kill_switch'
                ? copy('feat.killSwitchNote')
                : row.access.kind === 'custom'
                  ? copy('feat.customNote')
                  : row.access.kind === 'not_boolean'
                    ? copy('feat.perPlanNote')
                    : null;
            return (
              <Card key={row.feature.key} testId={`feature-${row.feature.key}`}>
                <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                      gap: spacingTokens.xs,
                    }}
                  >
                    <h3 style={{ margin: 0, ...typographyTokens.h3 }}>{row.name}</h3>
                    {row.feature.status === 'deprecated' ? (
                      <StatusBadge label={copy('feat.deprecated')} tone="warning" />
                    ) : null}
                  </div>
                  <div>
                    <StatusBadge
                      label={state.text}
                      tone={state.tone}
                      dot
                      testId={`feature-${row.feature.key}-access`}
                    />
                  </div>
                  {note ? (
                    <p
                      style={{
                        margin: 0,
                        ...typographyTokens.caption,
                        color: colorTokens.textSecondary,
                      }}
                    >
                      {note}
                    </p>
                  ) : null}
                  {row.exceptions > 0 ? (
                    <p
                      style={{
                        margin: 0,
                        ...typographyTokens.caption,
                        color: colorTokens.textSecondary,
                      }}
                    >
                      {fill(copy('feat.exceptions'), { count: row.exceptions })}
                    </p>
                  ) : null}
                  {editable ? (
                    <div>
                      <ActionLink
                        href={`${base}?feature=${encodeURIComponent(row.feature.key)}`}
                        testId={`feature-${row.feature.key}-change`}
                      >
                        {copy('feat.change')}
                      </ActionLink>
                    </div>
                  ) : null}
                </div>
              </Card>
            );
          })}
        </ContentGrid>
      )}
      <div>
        <AdvancedLink
          locale={locale}
          href="/flags"
          label={copy('mode.technicalDetails')}
          testId="features-technical"
        />
      </div>
    </Stack>
  );
}
