import { CopilotLink } from '../../../components/copilot-link';
import {
  Card,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonClass,
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
import { brandIdQueryFilter, brandScopeFilter } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { copilotHref } from '../../../server/copilot-surface';
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
  const mayPublish = workspace.permissionKeys.includes('publishing.manage');

  /*
   * THE RAIL'S BRAND (P6-12, D-190). The page computed the brand context and
   * then ignored it, listing every in-scope brand's rules whatever the rail
   * said. One selected brand now narrows the lists and the authoring form;
   * "all brands" shows the whole scope, as before.
   */
  const brandContext = await brandContextFor(
    session.workspace,
    '/automations',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const selectedBrand = requiredBrand(brandContext);

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
      rules: await engine.listRules({
        brandId: selectedBrand?.id,
        brandScope: workspace.brandScope,
      }),
      runs: await engine.listRuns({
        brandId: selectedBrand?.id,
        brandScope: workspace.brandScope,
        take: 25,
      }),
    };
  });

  /*
   * WHAT A PROPOSED PUBLISH WOULD PUBLISH (P6-12). The confirm button used to
   * stand alone — no rule, no content — so a person authorised an external
   * action on trust. Each waiting run is resolved to its rule's name and the
   * content item's title, through the same brand-scope predicate as every
   * other read here; a title the reader cannot see is reported as such, never
   * shown.
   */
  const awaiting = runs.filter(
    (run) =>
      run.status === 'AWAITING_CONFIRMATION' &&
      run.confirmationExpiresAt !== null &&
      run.confirmationExpiresAt.getTime() > Date.now(),
  );
  const proposals = new Map<string, { rule: string | null; content: string | null }>();
  if (awaiting.length > 0) {
    await inWorkspace(workspace.workspaceId, async ({ db }) => {
      const scoped = brandIdQueryFilter({ brandScope: workspace.brandScope });
      const ruleRows = await db.automationRule.findMany({
        where: {
          workspaceId: workspace.workspaceId,
          id: { in: awaiting.map((r) => r.ruleId) },
          ...scoped,
        },
        select: { id: true, name: true },
      });
      const ruleNames = new Map(ruleRows.map((row) => [row.id, row.name]));
      for (const run of awaiting) {
        let contentItemId: string | null = null;
        if (run.resourceId && run.resourceType === 'ContentItem') contentItemId = run.resourceId;
        if (run.resourceId && run.resourceType === 'CalendarSlot') {
          const slot = await db.calendarSlot.findFirst({
            where: { id: run.resourceId, workspaceId: workspace.workspaceId, ...scoped },
            select: { contentItemId: true },
          });
          contentItemId = slot?.contentItemId ?? null;
        }
        if (run.resourceId && run.resourceType === 'PublishJob') {
          const job = await db.publishJob.findFirst({
            where: { id: run.resourceId, workspaceId: workspace.workspaceId, ...scoped },
            select: { contentItemId: true },
          });
          contentItemId = job?.contentItemId ?? null;
        }
        const item = contentItemId
          ? await db.contentItem.findFirst({
              where: { id: contentItemId, workspaceId: workspace.workspaceId, ...scoped },
              select: { title: true },
            })
          : null;
        proposals.set(run.id, {
          rule: ruleNames.get(run.ruleId) ?? null,
          content: item?.title ?? null,
        });
      }
    });
  }
  const formBrands = selectedBrand
    ? brands.filter((brand) => brand.id === selectedBrand.id)
    : brands;

  const stamp = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });

  return (
    <WorkspaceShell
      brandContext={brandContext}
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

        {selectedBrand || workspace.permissionKeys.includes('copilot.use') ? (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.sm,
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            {selectedBrand ? (
              <p
                data-testid="automations-brand-filter"
                style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}
              >
                {t('automations.brandFilter').replace('{brand}', selectedBrand.name)}
              </p>
            ) : (
              <span />
            )}
            {workspace.permissionKeys.includes('copilot.use') ? (
              <CopilotLink
                href={copilotHref(locale, 'automations')}
                style={buttonStyle('ghost', 'sm')}
                className={buttonClass('ghost')}
                data-testid="automations-ask-copilot"
              >
                {t('copilot.ask')}
              </CopilotLink>
            ) : null}
          </div>
        ) : null}

        {/*
          D-277 §39, D-296 — HOW MOST PEOPLE SHOULD FIND AUTOMATION: by asking
          the Copilot in their own words, or from a recurring workflow Home
          noticed. The trigger/condition/action form below stays for people who
          want to build a rule by hand. What is true is said plainly: a rule the
          Copilot prepares starts switched off, and a proposed publish still
          asks before anything goes out.
        */}
        {workspace.permissionKeys.includes('copilot.use') ? (
          <Card testId="automations-discover">
            <SectionHeader
              title={t('automations.discover.title')}
              description={t('automations.discover.body')}
            />
            <ul
              style={{
                margin: 0,
                paddingInlineStart: '1.1rem',
                display: 'grid',
                gap: spacingTokens['3xs'],
                ...typographyTokens.caption,
                color: colorTokens.textSecondary,
              }}
            >
              <li>{t('automations.discover.off')}</li>
              <li>{t('automations.discover.publish')}</li>
              <li>{t('automations.discover.home')}</li>
            </ul>
            <div style={{ marginBlockStart: spacingTokens.sm }}>
              <CopilotLink
                href={copilotHref(locale, 'automations')}
                request={t('automations.discover.example')}
                style={buttonStyle('primary', 'sm')}
                className={buttonClass('primary')}
                testId="automations-discover-copilot"
              >
                {t('automations.discover.cta')}
              </CopilotLink>
            </div>
          </Card>
        ) : null}

        {mayManage && formBrands.length > 0 ? (
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
              brands={formBrands.map((brand) => ({ id: brand.id, name: brand.name }))}
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
            <StateMessage
              kind="empty"
              title={t('automations.empty')}
              description={t('automations.emptyBody')}
            />
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
                        {/*
                          DELETE ASKS TWICE (P6-12). It was one click away from
                          the toggle beside it. A native disclosure, so it works
                          without script and is keyboard-operable as is.
                        */}
                        <details data-testid={`automation-delete-${rule.id}`}>
                          <summary
                            style={{ ...buttonStyle('ghost', 'sm'), listStyle: 'none' }}
                            className={buttonClass('ghost')}
                          >
                            {t('automations.deleteConfirm')}
                          </summary>
                          <form
                            action={deleteAutomationAction}
                            style={{
                              display: 'grid',
                              gap: spacingTokens.xs,
                              marginBlockStart: spacingTokens.xs,
                            }}
                          >
                            <input type="hidden" name="locale" value={locale} />
                            <input type="hidden" name="ruleId" value={rule.id} />
                            <span
                              style={{
                                ...typographyTokens.caption,
                                color: colorTokens.textSecondary,
                              }}
                            >
                              {t('automations.deleteConfirmBody')}
                            </span>
                            <button
                              type="submit"
                              style={buttonStyle('danger', 'sm')}
                              className={buttonClass('danger')}
                            >
                              {t('automations.deleteConfirmSubmit')}
                            </button>
                          </form>
                        </details>
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
            <StateMessage
              kind="empty"
              title={t('automations.runsEmpty')}
              description={t('automations.runsEmptyBody')}
            />
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
                  <span style={{ display: 'grid', gap: '0.125rem' }}>
                    <span>
                      {t(`automations.trigger.${run.triggerType}` as MessageKey)} →{' '}
                      {t(`automations.action.${run.actionType}` as MessageKey)}
                    </span>
                    {run.failureCode ? (
                      <span data-testid={`automation-run-failure-${run.id}`}>
                        {t('automations.failure').replace('{code}', run.failureCode)}
                      </span>
                    ) : null}
                    {proposals.has(run.id) ? (
                      <span data-testid={`automation-proposal-${run.id}`}>
                        <strong>{t('automations.previewTitle')}</strong>
                        {' — '}
                        {t('automations.previewRule').replace(
                          '{rule}',
                          proposals.get(run.id)?.rule ?? '—',
                        )}
                        {' · '}
                        {proposals.get(run.id)?.content
                          ? t('automations.previewContent').replace(
                              '{content}',
                              proposals.get(run.id)?.content ?? '',
                            )
                          : t('automations.previewUnknown')}
                      </span>
                    ) : null}
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
                    {proposals.has(run.id) && !mayPublish ? (
                      <span>{t('automations.confirmNeedsPermission')}</span>
                    ) : null}
                    {proposals.has(run.id) && mayPublish ? (
                      <form action={confirmAutomationRunAction}>
                        <input type="hidden" name="locale" value={locale} />
                        <input type="hidden" name="runId" value={run.id} />
                        <button
                          type="submit"
                          style={buttonStyle('primary', 'sm')}
                          className={buttonClass('primary')}
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
