import {
  Card,
  SectionHeader,
  Stack,
  StateMessage,
  StatusBadge,
  buttonStyle,
  colorTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { AUTOMATION_ACTIONS, AUTOMATION_TRIGGERS } from '@brandspace/automation';
import { brandScopeFilter } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { inAnalytics } from '../../../server/analytics-context';
import { statusMessage, translator, type MessageKey } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
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
            <form action={createAutomationAction} data-testid="automation-form">
              <input type="hidden" name="locale" value={locale} />
              <div
                style={{
                  display: 'flex',
                  gap: spacingTokens.md,
                  flexWrap: 'wrap',
                  alignItems: 'end',
                }}
              >
                <label style={{ display: 'grid', gap: '0.25rem' }}>
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                    {t('automations.nameLabel')}
                  </span>
                  <input
                    name="name"
                    required
                    maxLength={120}
                    className="bs-control"
                    style={inputStyle()}
                  />
                </label>
                <label style={{ display: 'grid', gap: '0.25rem' }}>
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                    {t('analytics.brandLabel')}
                  </span>
                  <select name="brandId" className="bs-control">
                    {brands.map((brand) => (
                      <option key={brand.id} value={brand.id}>
                        {brand.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: '0.25rem' }}>
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                    {t('automations.triggerLabel')}
                  </span>
                  {/*
                   * RENDERED FROM THE REGISTRY. A customer can only choose a
                   * trigger the engine declares — there is no free-text field
                   * that becomes behaviour.
                   */}
                  <select name="triggerType" className="bs-control">
                    {AUTOMATION_TRIGGERS.map((trigger) => (
                      <option key={trigger.type} value={trigger.type}>
                        {t(`automations.trigger.${trigger.type}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'grid', gap: '0.25rem' }}>
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                    {t('automations.actionLabel')}
                  </span>
                  <select name="actionType" className="bs-control">
                    {AUTOMATION_ACTIONS.map((action) => (
                      <option key={action.type} value={action.type}>
                        {t(`automations.action.${action.type}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" style={buttonStyle('brand', 'sm')}>
                  {t('automations.create')}
                </button>
              </div>
            </form>
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
                      THE BUTTON A PROPOSED EXTERNAL ACTION WAITS FOR.
                      Without it the run sat at AWAITING_CONFIRMATION for ever:
                      the engine minted a credential the worker dropped, and
                      nothing on any screen called the confirm action at all.
                      It posts the RUN's id and nothing else — the credential is
                      fetched server-side and never reaches this page.
                    */}
                    {run.status === 'AWAITING_CONFIRMATION' ? (
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
