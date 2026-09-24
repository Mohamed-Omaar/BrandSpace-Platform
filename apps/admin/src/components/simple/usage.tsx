import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import {
  Card,
  ContentGrid,
  MetricCard,
  Stack,
  StatusBadge,
  colorTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { fill, simpleCopy, type SimpleKey } from '../../i18n/simple';
import {
  loadAiSummary,
  loadBillingIssues,
  loadSubscriptionMix,
  loadTrialsEnding,
} from '../../server/owner-overview';
import { getPlanCatalogue } from '../../server/platform-context';
import { AdvancedLink } from '../mode-switch';
import { ActionLink, SimpleSection, formatCount, formatDay, formatWhen } from '../simple-ui';

/**
 * USAGE & BILLING — only what is recorded (contract §17).
 *
 * Subscriptions by status and by plan, trials about to end, AI credits
 * actually charged, and the billing events waiting for a decision. Revenue,
 * MRR, profit and provider cost are named as NOT shown, because the platform
 * has no source of truth for them yet and an estimate on an owner's screen is
 * acted on as fact.
 */
export async function SimpleUsage({
  locale,
  actor,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console`;
  const mayReadConfig = actor.permissionKeys.includes('platform.configuration.read');
  const [mix, trials, billing, ai, catalogue] = await Promise.all([
    loadSubscriptionMix(),
    loadTrialsEnding(7, 10),
    loadBillingIssues(),
    loadAiSummary(actor),
    mayReadConfig ? getPlanCatalogue() : Promise.resolve(null),
  ]);
  const planName = (key: string) => {
    const plan = catalogue?.plans.find((candidate) => candidate.key === key);
    return plan ? (locale === 'ar' ? plan.nameAr : plan.nameEn) : key;
  };
  const listStyle = {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gap: spacingTokens.xs,
  } as const;
  const rowStyle = {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacingTokens.xs,
    padding: spacingTokens.sm,
    borderRadius: radiusTokens.control,
    background: colorTokens.surfaceSoft,
    ...typographyTokens.bodySm,
  } as const;

  return (
    <Stack>
      <p style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
        {copy('usage.intro')}
      </p>

      <SimpleSection title={copy('usage.subscriptions')} testId="usage-subscriptions">
        {mix.byStatus.length === 0 ? (
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('usage.subscriptionsNone')}</p>
        ) : (
          <ContentGrid min="10rem">
            {mix.byStatus.map((row) => (
              <MetricCard
                key={row.status}
                testId={`usage-sub-${row.status}`}
                label={copy(`sub.${row.status}` as SimpleKey)}
                value={formatCount(locale, row.count)}
              />
            ))}
          </ContentGrid>
        )}
      </SimpleSection>

      {mix.byPlan.length > 0 ? (
        <SimpleSection title={copy('usage.byPlan')} testId="usage-by-plan">
          <ul style={listStyle}>
            {mix.byPlan.map((row) => (
              <li key={row.planKey} style={rowStyle} data-testid={`usage-plan-${row.planKey}`}>
                <span style={{ fontWeight: 600 }}>{planName(row.planKey)}</span>
                <span>{formatCount(locale, row.count)}</span>
              </li>
            ))}
          </ul>
        </SimpleSection>
      ) : null}

      <section id="trials">
        <SimpleSection title={copy('usage.trials')} testId="usage-trials">
          {trials.count === 0 ? (
            <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('usage.trialsNone')}</p>
          ) : (
            <ul style={listStyle}>
              {trials.items.map((trial) => (
                <li key={trial.workspaceId} style={rowStyle}>
                  <span style={{ fontWeight: 600 }}>{trial.workspaceName}</span>
                  <span style={{ color: colorTokens.textSecondary }}>
                    {planName(trial.planKey)} ·{' '}
                    {fill(copy('usage.trialEnds'), { when: formatDay(locale, trial.trialEndsAt) })}
                  </span>
                  <ActionLink href={`${base}/workspaces/${trial.workspaceId}`}>
                    {copy('common.open')}
                  </ActionLink>
                </li>
              ))}
            </ul>
          )}
        </SimpleSection>
      </section>

      <SimpleSection title={copy('usage.ai')} testId="usage-ai">
        {ai.usage ? (
          <ContentGrid min="12rem">
            <MetricCard
              testId="usage-ai-credits"
              label={copy('ai.usageCredits')}
              value={formatCount(locale, Number(ai.usage.creditsMilli) / 1000)}
            />
            <MetricCard
              testId="usage-ai-entries"
              label={copy('ai.usageEntries')}
              value={formatCount(locale, ai.usage.entries)}
            />
          </ContentGrid>
        ) : (
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('ai.usageWithheld')}</p>
        )}
      </SimpleSection>

      <section id="billing">
        <SimpleSection
          title={copy('usage.billing')}
          testId="usage-billing"
          actions={
            billing.count > 0 ? (
              <AdvancedLink
                locale={locale}
                href="/health"
                label={copy('usage.billingReview')}
                testId="usage-billing-review"
              />
            ) : undefined
          }
        >
          {billing.count === 0 ? (
            <p style={{ margin: 0, ...typographyTokens.bodySm }} data-testid="usage-billing-clear">
              {copy('usage.billingNone')}
            </p>
          ) : (
            <ul style={listStyle}>
              {billing.items.slice(0, 10).map((event) => (
                <li key={event.id} style={rowStyle} data-testid={`usage-billing-${event.id}`}>
                  <StatusBadge
                    label={copy(`usage.event.${event.status}` as SimpleKey)}
                    tone={event.status === 'UNRESOLVED' ? 'warning' : 'danger'}
                  />
                  <span style={{ color: colorTokens.textSecondary }}>
                    {formatWhen(locale, event.receivedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SimpleSection>
      </section>

      <Card tone="soft" elevated={false} testId="usage-not-measured">
        <p style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
          {copy('usage.notMeasured')}
        </p>
      </Card>
    </Stack>
  );
}
