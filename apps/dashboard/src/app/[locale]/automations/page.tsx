import {
  Card,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  CONDITION_FIELDS,
  CONDITION_FIELD_CONTRACTS,
  actionSupportsTrigger,
  conditionFieldsFor,
  type ConditionField,
} from '@brandspace/automation';
import { INGESTED_METRIC_KEYS } from '@brandspace/analytics';
import { brandScopeFilter } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { inAnalytics } from '../../../server/analytics-context';
import { statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { AutomationForm } from './automation-form';
import {
  confirmAutomationRunAction,
  createAutomationAction,
  deleteAutomationAction,
  toggleAutomationAction,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * AUTOMATIONS — trigger, condition, action.
 *
 * WHAT THE SCREEN PROMISES AND THE ENGINE KEEPS:
 *
 *  - NO CODE, NO EXPRESSIONS, NO WEBHOOKS. The trigger and action pickers are
 *    rendered FROM THE REGISTRY, so a customer can only ever choose something the
 *    engine declares. There is no free-text field that becomes behaviour.
 *  - AN EXTERNAL ACTION NEVER RUNS ON ITS OWN. The banner says so, and a CHECK
 *    constraint on `automation_rule` makes a rule that claims otherwise
 *    unrepresentable.
 *  - A RULE STORES NO AUTHORITY. The run history renders
 *    `BLOCKED_BY_AUTHORIZATION` in words, so a rule that stopped working because
 *    its author was demoted says so rather than failing silently.
 */
/**
 * A CLOSED FIELD'S CHOICES, ALREADY TRANSLATED.
 *
 * `brand.id` and `metric.key` name things the registry cannot enumerate — one
 * is tenant data, the other is the analytics catalogue — so their lists are
 * supplied by the caller, which already holds both. Everything else comes
 * straight from the contract's own closed set.
 */
function conditionChoicesFor(
  field: ConditionField,
  locale: string,
  brands: readonly { readonly id: string; readonly name: string }[],
): readonly { readonly value: string; readonly label: string }[] {
  const t = translator(locale);
  const contract = CONDITION_FIELD_CONTRACTS[field];

  if (contract.catalogue === 'brands') {
    return brands.map((brand) => ({ value: brand.id, label: brand.name }));
  }
  if (contract.catalogue === 'metricKeys') {
    return INGESTED_METRIC_KEYS.map((key) => ({
      value: key,
      label: t(`analytics.metric.${key}` as MessageKey),
    }));
  }
  if (contract.options === null) return [];

  if (field === 'content.status') {
    return contract.options.map((value) => ({
      value,
      label: t(`content.status.${value}` as MessageKey),
    }));
  }
  if (field === 'publish.provider') {
    return contract.options.map((value) => ({
      value,
      label: t(`integrations.provider.${value.toLowerCase()}` as MessageKey),
    }));
  }
  return contract.options.map((value) => ({
    value,
    label: t(`automations.failureClass.${value}` as MessageKey),
  }));
}

export default async function AutomationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const session = await requireWorkspace(locale, 'automation.read');
  const { workspace } = session;

  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const mayManage = workspace.permissionKeys.includes('automation.manage');

  const brands = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: { status: 'ACTIVE', ...brandScopeFilter(workspace.brandScope) },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    }),
  );
  const brandNames = new Map(brands.map((brand) => [brand.id, brand.name]));
  const conditionChoices = (field: ConditionField): readonly { value: string; label: string }[] =>
    conditionChoicesFor(field, locale, brands);

  const { rules, runs } = await inAnalytics(workspace.workspaceId, async (services) => {
    const engine = await services.automations();
    return {
      rules: await engine.listRules({ brandScope: workspace.brandScope }),
      runs: await engine.listRuns({ brandScope: workspace.brandScope, take: 25 }),
    };
  });

  const stamp = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  return (
    <WorkspaceShell
      locale={locale}
      heading={t('automations.title')}
      description={t('automations.subtitle')}
      activePath="/automations"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={session.customer.name ?? session.customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <Stack gap={spacingTokens.lg}>
        {ok ? (
          <CustomerBanner tone="success">{statusMessage(ok, locale) ?? ok}</CustomerBanner>
        ) : null}
        {error ? (
          <CustomerBanner tone="error">{statusMessage(error, locale) ?? error}</CustomerBanner>
        ) : null}

        <CustomerBanner tone="info">{t('automations.externalNotice')}</CustomerBanner>

        {mayManage && brands.length > 0 ? (
          <Card title={t('automations.create')}>
            {/*
              THE FORM IS BUILT FROM THE REGISTRY, ON THE SERVER, AND HANDED
              PLAIN DATA.

              Every option a customer can choose — trigger, action, condition
              field, operator, metric — is derived here from the engine's own
              closed lists, including which ACTIONS `actionSupportsTrigger`
              allows for each trigger and which CONDITION FIELDS actually have a
              producer in that trigger's context. The client component only
              decides which of these pre-approved options to show.

              STRINGS CROSS THE BOUNDARY, NEVER `t`. Passing a translator into a
              client component is what took the Copilot screen down at render.
            */}
            <AutomationForm
              locale={locale}
              action={createAutomationAction}
              brands={brands.map((brand) => ({ id: brand.id, name: brand.name }))}
              triggers={AUTOMATION_TRIGGERS.map((trigger) => ({
                type: trigger.type,
                label: t(`automations.trigger.${trigger.type}` as MessageKey),
                actionTypes: AUTOMATION_ACTIONS.filter((action) =>
                  actionSupportsTrigger(action.type, trigger.type),
                ).map((action) => action.type),
                conditionFields: [...conditionFieldsFor(trigger.type)],
                needsSchedule: trigger.type === 'SCHEDULED_TIME',
                needsThreshold: trigger.type === 'METRIC_THRESHOLD_CROSSED',
              }))}
              actionLabels={Object.fromEntries(
                AUTOMATION_ACTIONS.map((action) => [
                  action.type,
                  t(`automations.action.${action.type}` as MessageKey),
                ]),
              )}
              /*
                EVERY FIELD'S WHOLE AUTHORING CONTRACT, DERIVED FROM THE ENGINE
                (R4-1).

                The screen used to hand the client every operator in the
                registry and a text box, whatever the field was — so
                `brand.id greater_than 5` and `content.hasCampaign equals
                "true"` were both one click away, both stored, and both false
                for ever. The operators, the value control and the parsing now
                all come from `CONDITION_FIELD_CONTRACTS`, which is also what
                `createRule` and `updateRule` refuse against.

                CLOSED SETS ARE LABELLED HERE, on the server, where `t` lives —
                a raw `PARTIALLY_PUBLISHED` in a picker is untranslated copy,
                and §4 does not make an exception for enum values.
              */
              conditionCatalogue={Object.fromEntries(
                CONDITION_FIELDS.map((field) => {
                  const contract = CONDITION_FIELD_CONTRACTS[field];
                  return [
                    field,
                    {
                      label: t(`automations.field.${field}` as MessageKey),
                      kind: contract.kind,
                      operators: contract.operators.map((operator) => ({
                        value: operator,
                        label: t(`automations.operator.${operator}` as MessageKey),
                      })),
                      options: conditionChoices(field),
                    },
                  ];
                }),
              )}
              metrics={INGESTED_METRIC_KEYS.map((key) => ({
                key,
                label: t(`analytics.metric.${key}` as MessageKey),
              }))}
              labels={{
                name: t('automations.nameLabel'),
                brand: t('analytics.brandLabel'),
                trigger: t('automations.triggerLabel'),
                action: t('automations.actionLabel'),
                submit: t('automations.create'),
                hour: t('automations.hourLabel'),
                days: t('automations.daysLabel'),
                metric: t('automations.metricLabel'),
                direction: t('automations.directionLabel'),
                above: t('automations.directionAbove'),
                below: t('automations.directionBelow'),
                threshold: t('automations.thresholdLabel'),
                windowDays: t('automations.windowLabel'),
                conditionLegend: t('automations.conditionLegend'),
                conditionNone: t('automations.conditionNone'),
                conditionField: t('automations.conditionField'),
                conditionOperator: t('automations.conditionOperator'),
                conditionValue: t('automations.conditionValue'),
                conditionValues: t('automations.conditionValues'),
                conditionValuesHint: t('automations.conditionValuesHint'),
                weekdays: [
                  t('automations.day.0'),
                  t('automations.day.1'),
                  t('automations.day.2'),
                  t('automations.day.3'),
                  t('automations.day.4'),
                  t('automations.day.5'),
                  t('automations.day.6'),
                ],
              }}
            />
          </Card>
        ) : null}

        <Card>
          <SectionHeader title={t('automations.rules')} />
          {rules.length === 0 ? (
            <StateMessage kind="empty" title={t('automations.empty')} />
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'grid',
                gap: spacingTokens.sm,
              }}
              data-testid="automation-rules"
            >
              {rules.map((rule) => (
                <li
                  key={rule.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: spacingTokens.md,
                    flexWrap: 'wrap',
                    ...typographyTokens.bodySm,
                  }}
                >
                  <span>
                    <strong>{rule.name}</strong>{' '}
                    <span style={{ color: colorTokens.textSecondary }}>
                      {brandNames.get(rule.brandId) ?? ''} ·{' '}
                      {t(`automations.trigger.${rule.triggerType}` as MessageKey)} →{' '}
                      {t(`automations.action.${rule.actionType}` as MessageKey)}
                    </span>
                  </span>
                  <span style={{ display: 'flex', gap: spacingTokens.sm, alignItems: 'center' }}>
                    <StatusBadge
                      tone={rule.enabled ? 'success' : 'neutral'}
                      label={t(rule.enabled ? 'automations.enabled' : 'automations.disabled')}
                    />
                    {mayManage ? (
                      <>
                        <form action={toggleAutomationAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="ruleId" value={rule.id} />
                          <input type="hidden" name="enabled" value={rule.enabled ? '0' : '1'} />
                          <button type="submit" style={buttonStyle('ghost', 'sm')}>
                            {t(rule.enabled ? 'automations.disable' : 'automations.enable')}
                          </button>
                        </form>
                        <form action={deleteAutomationAction}>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="ruleId" value={rule.id} />
                          <button type="submit" style={buttonStyle('danger', 'sm')}>
                            {t('automations.delete')}
                          </button>
                        </form>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionHeader title={t('automations.runs')} />
          {runs.length === 0 ? (
            <StateMessage kind="empty" title={t('automations.runsEmpty')} />
          ) : (
            <ul
              style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.25rem' }}
              data-testid="automation-runs"
            >
              {runs.map((run) => (
                <li
                  key={run.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: spacingTokens.md,
                    ...typographyTokens.caption,
                    color: colorTokens.textSecondary,
                  }}
                >
                  <span>
                    {t(`automations.trigger.${run.triggerType}` as MessageKey)} →{' '}
                    {t(`automations.action.${run.actionType}` as MessageKey)}
                  </span>
                  <span style={{ display: 'flex', gap: spacingTokens.sm }}>
                    <StatusBadge
                      tone={
                        run.status === 'SUCCEEDED'
                          ? 'success'
                          : run.status === 'FAILED' || run.status === 'BLOCKED_BY_AUTHORIZATION'
                            ? 'warning'
                            : 'neutral'
                      }
                      label={t(`automations.status.${run.status}` as MessageKey)}
                    />
                    <span>{stamp.format(run.startedAt)}</span>
                    {/*
                      THE BUTTON A PROPOSED EXTERNAL ACTION WAITS FOR, AND ONLY
                      WHILE ITS WINDOW IS OPEN (R3-4).

                      A proposal whose window has closed is EXPIRED by the sweep;
                      until it is, the status alone would still read
                      AWAITING_CONFIRMATION, and a button that cannot work is
                      worse than no button — it offers to authorise something
                      whose content is by now days stale.
                      Without it the run sat at AWAITING_CONFIRMATION for ever:
                      the engine minted a credential the worker dropped, and
                      nothing on any screen called the confirm action at all.
                      It posts the RUN's id and nothing else — the credential is
                      fetched server-side and never reaches this page.
                    */}
                    {run.status === 'AWAITING_CONFIRMATION' &&
                    run.confirmationExpiresAt !== null &&
                    run.confirmationExpiresAt.getTime() > Date.now() ? (
                      <form action={confirmAutomationRunAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="runId" value={run.id} />
                        <button
                          type="submit"
                          style={buttonStyle('primary', 'sm')}
                          data-testid="automation-confirm"
                        >
                          {t('automations.confirmRun')}
                        </button>
                      </form>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Stack>
    </WorkspaceShell>
  );
}
