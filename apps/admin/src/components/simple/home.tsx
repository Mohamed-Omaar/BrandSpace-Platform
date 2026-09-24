import { ContentGrid, MetricCard, Stack, colorTokens, typographyTokens } from '@brandspace/ui';
import type { ConfigDomain } from '@brandspace/config';
import { fill, simpleCopy, type SimpleKey } from '../../i18n/simple';
import {
  loadAiSummary,
  loadBillingIssues,
  loadCustomerCounts,
  loadPendingChanges,
  loadReadiness,
  loadSystemState,
  loadTrialsEnding,
} from '../../server/owner-overview';
import { currentEnvironment } from '../../server/platform-context';
import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import {
  ActionLink,
  AreaBadge,
  AttentionList,
  ReadinessCard,
  SimpleSection,
  stateLabel,
  type AttentionItem,
} from '../simple-ui';

/** Where each kind of unfinished change is finished, in Simple terms. */
const PENDING_HREF: Partial<Record<ConfigDomain, string>> = {
  plans: '/plans',
  entitlements: '/plans',
  'feature-flags': '/features',
  'ai.capability-routing': '/ai/profile',
};

export function pendingLabel(locale: string, domain: ConfigDomain): string {
  const copy = simpleCopy(locale);
  const key = `pending.${domain}` as SimpleKey;
  const known: readonly string[] = [
    'plans',
    'entitlements',
    'feature-flags',
    'ai.capability-routing',
    'ai.providers',
  ];
  return known.includes(domain) ? copy(key) : fill(copy('pending.other'), { domain });
}

/**
 * THE OWNER'S HOME (contract §5, §6).
 *
 * Top to bottom it answers three questions, in the order an owner asks them:
 * what needs me, is the platform ready for customers, and how is it doing.
 * Every number is read from the service that owns it (`owner-overview.ts`),
 * every attention item links to the screen that resolves it, and anything
 * the reader's role may not see says so instead of showing a zero.
 */
export async function SimpleHome({
  locale,
  actor,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console`;
  const mayReadConfig = actor.permissionKeys.includes('platform.configuration.read');

  const [readiness, customers, trials, pending, billing, ai, system] = await Promise.all([
    loadReadiness(actor),
    loadCustomerCounts(actor),
    loadTrialsEnding(3, 0),
    loadPendingChanges(actor),
    loadBillingIssues(),
    mayReadConfig ? loadAiSummary(actor) : Promise.resolve(null),
    loadSystemState(),
  ]);

  const attention: AttentionItem[] = [];
  if (system.report.status === 'not_ready') {
    attention.push({
      id: 'system',
      severity: 'critical',
      title: copy('attn.system'),
      detail: copy('attn.system.detail'),
      href: `${base}/health`,
      actionLabel: copy('common.review'),
    });
  }
  if (billing.count > 0) {
    attention.push({
      id: 'billing',
      severity: 'critical',
      title: fill(copy('attn.billing'), { count: billing.capped ? '200+' : billing.count }),
      detail: copy('attn.billing.detail'),
      href: `${base}/usage#billing`,
      actionLabel: copy('common.review'),
    });
  }
  for (const area of readiness.areas) {
    if (!area.required || area.state === 'ready' || area.state === 'withheld') continue;
    attention.push({
      id: `area-${area.key}`,
      severity: 'warning',
      title: fill(copy('attn.area'), {
        area: copy(`area.${area.key}` as SimpleKey),
        state: stateLabel(locale, area.state, area.key === 'plans'),
      }),
      detail: copy(`reason.${area.reason}` as SimpleKey),
      href: `${base}${area.href}`,
      actionLabel: area.state === 'setup_required' ? copy('common.setUp') : copy('common.fix'),
    });
  }
  if (customers.pastDue > 0) {
    attention.push({
      id: 'past-due',
      severity: 'warning',
      title: fill(copy('attn.pastDue'), { count: customers.pastDue }),
      detail: copy('attn.pastDue.detail'),
      href: `${base}/workspaces?status=PAST_DUE`,
      actionLabel: copy('common.review'),
    });
  }
  if (ai?.stuckRequests) {
    attention.push({
      id: 'stuck-ai',
      severity: 'warning',
      title: fill(copy('attn.stuckAi'), { count: ai.stuckRequests }),
      detail: copy('attn.stuckAi.detail'),
      href: `${base}/ai-usage`,
      actionLabel: copy('common.review'),
    });
  }
  if (trials.count > 0) {
    attention.push({
      id: 'trials',
      severity: 'info',
      title: fill(copy('attn.trials'), { count: trials.count }),
      detail: copy('attn.trials.detail'),
      href: `${base}/usage#trials`,
      actionLabel: copy('common.review'),
    });
  }
  const pendingDomains = [...new Set((pending ?? []).map((change) => change.domain))];
  for (const domain of pendingDomains) {
    attention.push({
      id: `pending-${domain}`,
      severity: 'info',
      title: fill(copy('attn.pending'), { what: pendingLabel(locale, domain) }),
      detail: copy('attn.pending.detail'),
      href: `${base}${PENDING_HREF[domain] ?? `/configuration?domain=${encodeURIComponent(domain)}`}`,
      actionLabel: copy('common.review'),
    });
  }

  const aiArea = readiness.areas.find((area) => area.key === 'ai');
  const verdictText =
    readiness.verdict.status === 'ready'
      ? copy('home.readyYes')
      : readiness.verdict.status === 'unknown'
        ? copy('home.readyUnknown')
        : fill(copy('home.readyNo'), { count: readiness.verdict.remaining });
  const systemWord =
    system.report.status === 'ready'
      ? copy('home.systemOperational')
      : system.report.status === 'degraded'
        ? copy('home.systemAttention')
        : copy('home.systemDown');

  return (
    <Stack>
      <SimpleSection title={copy('home.attention')} testId="home-attention">
        <AttentionList locale={locale} items={attention} />
      </SimpleSection>

      <SimpleSection
        title={copy('home.ready')}
        description={fill(copy('home.readyEnv'), { env: currentEnvironment() })}
        testId="home-readiness"
      >
        <p
          data-testid="readiness-verdict"
          data-status={readiness.verdict.status}
          style={{
            margin: 0,
            ...typographyTokens.h3,
            color:
              readiness.verdict.status === 'ready' ? colorTokens.success : colorTokens.textPrimary,
          }}
        >
          {verdictText}
        </p>
        <ContentGrid min="15rem" testId="readiness-grid">
          {readiness.areas.map((area) => (
            <ReadinessCard key={area.key} locale={locale} area={area} />
          ))}
        </ContentGrid>
      </SimpleSection>

      <SimpleSection title={copy('home.glance')} testId="home-glance">
        <ContentGrid min="11rem" testId="glance-customers">
          <MetricCard
            testId="glance-customers-total"
            label={copy('home.customers')}
            value={String(customers.total)}
            accent
          />
          <MetricCard
            testId="glance-customers-active"
            label={copy('home.customersActive')}
            value={String(customers.active)}
          />
          <MetricCard
            testId="glance-customers-trial"
            label={copy('home.customersTrial')}
            value={String(customers.trialing)}
          />
          <MetricCard
            testId="glance-customers-attention"
            label={copy('home.customersAttention')}
            value={String(customers.pastDue + customers.suspended)}
          />
        </ContentGrid>
        <ContentGrid min="15rem" testId="glance-platform">
          <MetricCard
            testId="glance-ai-provider"
            label={`${copy('home.ai')} · ${copy('home.aiProvider')}`}
            value={
              aiArea?.provider
                ? locale === 'ar'
                  ? aiArea.provider.ar
                  : aiArea.provider.en
                : aiArea?.state === 'withheld'
                  ? undefined
                  : copy('home.noProvider')
            }
            unavailable={aiArea?.state === 'withheld'}
            unavailableLabel={copy('common.noPermission')}
          />
          <MetricCard
            testId="glance-ai-profile"
            label={`${copy('home.ai')} · ${copy('home.aiProfile')}`}
            value={ai ? copy(`profile.${ai.profile}` as SimpleKey) : undefined}
            unavailable={!ai}
            unavailableLabel={copy('common.noPermission')}
          />
          <MetricCard
            testId="glance-ai-usage"
            label={copy('home.aiUsage')}
            value={
              ai?.usage
                ? new Intl.NumberFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en').format(
                    Number(ai.usage.creditsMilli) / 1000,
                  )
                : undefined
            }
            unavailable={!ai?.usage}
            unavailableLabel={copy('common.noPermission')}
          />
          <MetricCard testId="glance-system" label={copy('home.system')} value={systemWord} />
        </ContentGrid>
        {aiArea ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
            <AreaBadge locale={locale} state={aiArea.state} testId="glance-ai-state" />
            <ActionLink href={`${base}/ai`} testId="glance-ai-open">
              {copy('common.open')}
            </ActionLink>
          </div>
        ) : null}
      </SimpleSection>
    </Stack>
  );
}
