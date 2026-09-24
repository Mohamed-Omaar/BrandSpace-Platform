import type { ReactNode } from 'react';
import Link from 'next/link';
import type { AiRoutingProfile } from '@brandspace/ai-gateway';
import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import { integrationsInCategory, type IntegrationView } from '@brandspace/integrations';
import {
  Banner,
  Card,
  ContentGrid,
  Field,
  MetricCard,
  Stack,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { fill, simpleCopy, type SimpleKey } from '../../i18n/simple';
import { loadAiSummary, previewProfile, type CapabilityPreview } from '../../server/owner-overview';
import { integrationAreaState } from '../../server/owner-readiness';
import {
  currentEnvironment,
  getIntegrationsService,
  serviceActor,
} from '../../server/platform-context';
import { setAiProfileAction } from '../../app/[locale]/console/ai/actions';
import { AdvancedLink } from '../mode-switch';
import { ActionLink, ActionOutcome, AreaBadge, SimpleSection, formatCount } from '../simple-ui';

/**
 * AI, FOR THE OWNER (contract §10, §11, §12).
 *
 * Provider-agnostic by construction: the provider list is the registry's AI
 * category, the connection state is the Hub's view, the profile is the one
 * `ai.capability-routing` holds, and the "what AI does" preview is computed
 * by `resolveCapabilityRoute` — the router itself. Nothing here names a
 * vendor, and nothing ranks a model on its own.
 */

export const AI_PROFILES: readonly AiRoutingProfile[] = [
  'economy',
  'balanced',
  'premium',
  'custom',
];

async function aiViews(
  actor: AuthenticatedPlatformActor,
): Promise<readonly IntegrationView[] | null> {
  if (!actor.permissionKeys.includes('platform.secret.read')) return null;
  const views = await getIntegrationsService().list(serviceActor(actor), currentEnvironment());
  return views.filter((view) => view.category === 'ai');
}

function CapabilityList({
  locale,
  rows,
  testId,
}: {
  readonly locale: string;
  readonly rows: readonly CapabilityPreview[];
  readonly testId: string;
}) {
  const copy = simpleCopy(locale);
  return (
    <ul
      data-testid={testId}
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: spacingTokens.xs }}
    >
      {rows.map((row) => (
        <li
          key={row.capability}
          data-testid={`${testId}-${row.capability}`}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            gap: spacingTokens.xs,
            padding: spacingTokens.sm,
            borderRadius: radiusTokens.control,
            background: colorTokens.surfaceSoft,
            ...typographyTokens.bodySm,
          }}
        >
          <span style={{ fontWeight: 600 }}>{copy(`cap.${row.capability}` as SimpleKey)}</span>
          <span
            style={{
              color: row.outcome === 'served' ? colorTokens.textPrimary : colorTokens.textMuted,
            }}
          >
            {row.outcome === 'served'
              ? fill(copy(row.fixedByRule ? 'ai.servedFixed' : 'ai.served'), {
                  model: row.modelKey ?? '',
                })
              : copy(`ai.${row.outcome}` as SimpleKey)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export async function SimpleAiOverview({
  locale,
  actor,
  query,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly query: Record<string, string | string[] | undefined>;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console`;
  const [views, summary] = await Promise.all([aiViews(actor), loadAiSummary(actor)]);
  const preview = await previewProfile(summary.profile);
  const area = views ? integrationAreaState(views) : null;
  const lead = views?.find((view) => view.enabled) ?? null;
  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const okProfile = typeof query['profile'] === 'string' ? query['profile'] : null;
  const profileName = copy(`profile.${summary.profile}` as SimpleKey);

  return (
    <Stack>
      <ActionOutcome
        locale={locale}
        ok={ok}
        error={null}
        okText={(code) =>
          code === 'PROFILE_ACTIVATED' &&
          okProfile &&
          AI_PROFILES.includes(okProfile as AiRoutingProfile)
            ? fill(copy('profile.ok'), { profile: copy(`profile.${okProfile}` as SimpleKey) })
            : null
        }
      />
      <p
        style={{
          margin: 0,
          ...typographyTokens.bodySm,
          color: colorTokens.textSecondary,
          maxInlineSize: '68ch',
        }}
      >
        {copy('ai.agnostic')}
      </p>
      {area && !lead ? (
        <Banner tone="warning" testId="ai-no-provider">
          {copy('ai.noProvider')}
        </Banner>
      ) : null}

      <SimpleSection
        title={copy('ai.current')}
        testId="ai-current"
        actions={
          <ActionLink href={`${base}/ai/connect`} variant="primary" testId="ai-connect">
            {lead ? copy('ai.changeProvider') : copy('ai.connect')}
          </ActionLink>
        }
      >
        <ContentGrid min="14rem">
          <MetricCard
            testId="ai-provider"
            label={copy('ai.provider')}
            value={
              lead
                ? locale === 'ar'
                  ? lead.displayNameAr
                  : lead.displayNameEn
                : area
                  ? copy('home.noProvider')
                  : undefined
            }
            unavailable={!area}
            unavailableLabel={copy('common.noPermission')}
          />
          <MetricCard testId="ai-profile" label={copy('ai.profile')} value={profileName} />
          <Card testId="ai-connection">
            <div style={{ display: 'grid', gap: spacingTokens.xs }}>
              <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                {copy('ai.connection')}
              </span>
              {area ? (
                <>
                  <AreaBadge locale={locale} state={area.state} testId="ai-connection-state" />
                  <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                    {copy(`reason.${area.reason}` as SimpleKey)}
                  </span>
                </>
              ) : (
                <span style={typographyTokens.bodySm}>{copy('common.noPermission')}</span>
              )}
            </div>
          </Card>
        </ContentGrid>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: spacingTokens.xs,
            marginBlockStart: spacingTokens.md,
          }}
        >
          <ActionLink href={`${base}/ai/profile`} testId="ai-change-profile">
            {copy('ai.changeProfile')}
          </ActionLink>
          {lead ? (
            <ActionLink
              href={`${base}/integrations/ai/${encodeURIComponent(lead.providerKey)}`}
              testId="ai-test-connection"
            >
              {copy('ai.testConnection')}
            </ActionLink>
          ) : null}
        </div>
      </SimpleSection>

      <SimpleSection
        title={copy('ai.whatItDoes')}
        description={copy('ai.whatItDoesIntro')}
        testId="ai-capabilities"
      >
        <CapabilityList locale={locale} rows={preview.rows} testId="ai-capability" />
      </SimpleSection>

      <SimpleSection title={copy('ai.usage')} testId="ai-usage">
        {summary.usage ? (
          <ContentGrid min="12rem">
            <MetricCard
              testId="ai-usage-credits"
              label={copy('ai.usageCredits')}
              value={formatCount(locale, Number(summary.usage.creditsMilli) / 1000)}
            />
            <MetricCard
              testId="ai-usage-entries"
              label={copy('ai.usageEntries')}
              value={formatCount(locale, summary.usage.entries)}
            />
          </ContentGrid>
        ) : (
          <p style={{ margin: 0, ...typographyTokens.bodySm }} data-testid="ai-usage-withheld">
            {copy('ai.usageWithheld')}
          </p>
        )}
      </SimpleSection>

      <div>
        <AdvancedLink
          locale={locale}
          href="/routing"
          label={copy('mode.technicalDetails')}
          testId="ai-technical"
        />
      </div>
    </Stack>
  );
}

function ConnectStep({
  n,
  title,
  done,
  locale,
  children,
  testId,
}: {
  readonly n: number;
  readonly title: string;
  readonly done: boolean | null;
  readonly locale: string;
  readonly children: ReactNode;
  readonly testId: string;
}) {
  const copy = simpleCopy(locale);
  return (
    <li style={{ listStyle: 'none' }}>
      <Card
        testId={testId}
        title={`${fill(copy('setup.step'), { n })} · ${title}`}
        actions={
          done === null ? null : (
            <StatusBadge
              label={done ? copy('setup.done') : copy('setup.todo')}
              tone={done ? 'success' : 'warning'}
              dot
              testId={`${testId}-status`}
            />
          )
        }
      >
        <div style={{ display: 'grid', gap: spacingTokens.sm }}>{children}</div>
      </Card>
    </li>
  );
}

/**
 * CONNECT AI — choose, credentials and test, switch on, profile.
 *
 * Steps two and three happen on the provider's guided setup, which is the
 * Hub's own provider page in Simple form: one door, not a second one. Each
 * step's status here is read from the same view, so it cannot claim more
 * than the platform knows.
 */
export async function SimpleAiConnect({
  locale,
  actor,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console`;
  const views = await aiViews(actor);
  const summary = await loadAiSummary(actor);
  if (!views) {
    return (
      <Banner tone="info" testId="integrations-withheld">
        {copy('int.noPermission')}
      </Banner>
    );
  }
  const lead = views.find((view) => view.enabled) ?? null;
  const name = (view: IntegrationView) =>
    locale === 'ar' ? view.displayNameAr : view.displayNameEn;
  const setupHref = (view: IntegrationView) =>
    `${base}/integrations/ai/${encodeURIComponent(view.providerKey)}`;
  const credentialsDone = lead ? lead.configurationComplete && lead.connection === 'ok' : false;

  return (
    <Stack>
      <p style={{ margin: 0 }}>
        <ActionLink href={`${base}/ai`} variant="ghost" testId="ai-back">
          {fill(copy('common.backTo'), { page: copy('page.ai') })}
        </ActionLink>
      </p>
      <p style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
        {copy('connect.intro')}
      </p>
      {integrationsInCategory('ai').every((definition) => definition.developmentOnly) ? (
        <Banner tone="warning" testId="ai-no-real-provider">
          {copy('int.noRealProvider')}
        </Banner>
      ) : null}
      <ol
        style={{ margin: 0, padding: 0, display: 'grid', gap: spacingTokens.md }}
        data-testid="connect-steps"
      >
        <ConnectStep
          locale={locale}
          n={1}
          title={copy('connect.choose')}
          done={lead !== null}
          testId="connect-choose"
        >
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>
            {lead
              ? fill(copy('connect.chooseDone'), { provider: name(lead) })
              : copy('connect.chooseNone')}
          </p>
          <ContentGrid min="15rem">
            {views.map((view) => (
              <Card
                key={view.providerKey}
                testId={`connect-provider-${view.providerKey}`}
                tone="soft"
                elevated={false}
              >
                <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                  <strong style={typographyTokens.bodySm}>{name(view)}</strong>
                  <AreaBadge locale={locale} state={integrationAreaState([view]).state} />
                  {view.developmentOnly ? (
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                      {copy('int.devDouble')}
                    </span>
                  ) : null}
                  <div>
                    <ActionLink
                      href={setupHref(view)}
                      testId={`connect-provider-${view.providerKey}-open`}
                    >
                      {copy('connect.openSetup')}
                    </ActionLink>
                  </div>
                </div>
              </Card>
            ))}
          </ContentGrid>
        </ConnectStep>
        <ConnectStep
          locale={locale}
          n={2}
          title={copy('connect.credentials')}
          done={lead ? credentialsDone : false}
          testId="connect-credentials"
        >
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>
            {copy('connect.credentialsIntro')}
          </p>
          {lead ? (
            <p style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
              {credentialsDone ? copy('connect.credentialsDone') : copy('connect.credentialsTodo')}
            </p>
          ) : null}
        </ConnectStep>
        <ConnectStep
          locale={locale}
          n={3}
          title={copy('connect.activate')}
          done={lead !== null}
          testId="connect-activate"
        >
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>
            {lead ? fill(copy('setup.activeNow'), { provider: name(lead) }) : copy('ai.noProvider')}
          </p>
        </ConnectStep>
        <ConnectStep
          locale={locale}
          n={4}
          title={copy('connect.profile')}
          done={null}
          testId="connect-profile"
        >
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>
            {fill(copy('connect.profileNow'), {
              profile: copy(`profile.${summary.profile}` as SimpleKey),
            })}
          </p>
          <div>
            <ActionLink href={`${base}/ai/profile`} testId="connect-profile-open">
              {copy('ai.changeProfile')}
            </ActionLink>
          </div>
        </ConnectStep>
      </ol>
    </Stack>
  );
}

/**
 * CHOOSE A PROFILE — preview first, then a deliberate activation.
 *
 * The preview is a GET (`?preview=economy`), computed by the router, so
 * looking at a profile changes nothing. Activation is a form with a reason and
 * an explicit confirmation, posted to `setAiProfileAction`.
 */
export async function SimpleAiProfile({
  locale,
  actor,
  query,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly query: Record<string, string | string[] | undefined>;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console`;
  const summary = await loadAiSummary(actor);
  const requested = typeof query['preview'] === 'string' ? query['preview'] : null;
  const candidate: AiRoutingProfile = AI_PROFILES.includes(requested as AiRoutingProfile)
    ? (requested as AiRoutingProfile)
    : summary.profile;
  const preview = await previewProfile(candidate);
  const mayChange =
    actor.permissionKeys.includes('platform.configuration.manage') &&
    actor.permissionKeys.includes('platform.configuration.activate');
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const reference = typeof query['ref'] === 'string' ? query['ref'] : null;
  const candidateName = copy(`profile.${candidate}` as SimpleKey);

  return (
    <Stack>
      <p style={{ margin: 0 }}>
        <ActionLink href={`${base}/ai`} variant="ghost" testId="ai-back">
          {fill(copy('common.backTo'), { page: copy('page.ai') })}
        </ActionLink>
      </p>
      <ActionOutcome
        locale={locale}
        ok={null}
        error={error}
        reference={reference}
        errorText={(code) =>
          code === 'DRAFT_OPEN' || code === 'UNCHANGED'
            ? copy(`profile.error.${code}` as SimpleKey)
            : null
        }
      />
      <p
        style={{
          margin: 0,
          ...typographyTokens.bodySm,
          color: colorTokens.textSecondary,
          maxInlineSize: '68ch',
        }}
      >
        {copy('profile.intro')}
      </p>
      <nav aria-label={copy('page.aiProfile')}>
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: spacingTokens.sm,
            gridTemplateColumns: 'repeat(auto-fit, minmax(13rem, 1fr))',
          }}
        >
          {AI_PROFILES.map((profile) => {
            const selected = profile === candidate;
            return (
              <li key={profile}>
                <Link
                  href={`${base}/ai/profile?preview=${profile}`}
                  aria-current={selected ? 'true' : undefined}
                  data-testid={`profile-option-${profile}`}
                  className="bs-pressable"
                  style={{
                    display: 'grid',
                    gap: '2px',
                    blockSize: '100%',
                    padding: spacingTokens.md,
                    borderRadius: radiusTokens['2xl'],
                    background: selected ? colorTokens.surfaceLavender : colorTokens.surface,
                    border: `1px solid ${selected ? colorTokens.brandPurple : colorTokens.hairline}`,
                    color: colorTokens.textPrimary,
                    textDecoration: 'none',
                  }}
                >
                  <span
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: spacingTokens.xs,
                      alignItems: 'center',
                    }}
                  >
                    <strong style={typographyTokens.h3}>
                      {copy(`profile.${profile}` as SimpleKey)}
                    </strong>
                    {profile === summary.profile ? (
                      <StatusBadge
                        label={copy('profile.active')}
                        tone="success"
                        dot
                        testId={`profile-active-${profile}`}
                      />
                    ) : null}
                  </span>
                  <span style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
                    {copy(`profile.${profile}.about` as SimpleKey)}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <SimpleSection
        title={fill(copy('profile.previewOf'), { profile: candidateName })}
        description={copy('ai.whatItDoesIntro')}
        testId="profile-preview"
      >
        {candidate === 'economy' && preview.pricedModels === 0 ? (
          <Banner tone="info" testId="profile-no-prices">
            {copy('profile.noPrices')}
          </Banner>
        ) : null}
        <CapabilityList locale={locale} rows={preview.rows} testId="profile-capability" />
      </SimpleSection>

      {candidate === summary.profile ? (
        <p
          style={{ margin: 0, ...typographyTokens.bodySm, fontWeight: 600 }}
          data-testid="profile-already-active"
        >
          {fill(copy('profile.alreadyActive'), { profile: candidateName })}
        </p>
      ) : !mayChange ? (
        <p style={{ margin: 0, ...typographyTokens.bodySm }} data-testid="profile-forbidden">
          {copy('profile.forbidden')}
        </p>
      ) : (
        <Card testId="profile-apply">
          <form action={setAiProfileAction} style={{ display: 'grid', gap: spacingTokens.sm }}>
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="profile" value={candidate} />
            <Field
              label={copy('common.reason')}
              htmlFor="profile-reason"
              hint={copy('common.reasonHint')}
            >
              <input
                className="bs-control"
                id="profile-reason"
                name="reason"
                required
                minLength={8}
                style={{ ...inputStyle(), maxInlineSize: '28rem' }}
                data-testid="profile-reason"
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
                data-testid="profile-confirm"
              />
              {copy('profile.confirm')}
            </label>
            <div>
              <button
                type="submit"
                className={buttonClass('primary')}
                style={buttonStyle('primary')}
                data-testid="profile-submit"
              >
                {fill(copy('profile.apply'), { profile: candidateName })}
              </button>
            </div>
          </form>
        </Card>
      )}
      <div>
        <AdvancedLink
          locale={locale}
          href="/routing"
          label={copy('mode.technicalDetails')}
          testId="profile-technical"
        />
      </div>
    </Stack>
  );
}
