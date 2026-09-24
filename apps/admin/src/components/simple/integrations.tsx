import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import {
  INTEGRATION_CATEGORY_DEFINITIONS,
  editableSettingFields,
  findIntegration,
  findIntegrationCategory,
  integrationsInCategory,
  type IntegrationCategory,
  type IntegrationView,
} from '@brandspace/integrations';
import type { AuthenticatedPlatformActor } from '@brandspace/auth';
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
  fontTokens,
  inputStyle,
  spacingTokens,
  typographyTokens,
} from '@brandspace/ui';
import { fill, simpleCopy, type SimpleKey } from '../../i18n/simple';
import { integrationAreaState, type ReadinessAreaKey } from '../../server/owner-readiness';
import {
  currentEnvironment,
  generatedSettingsFor,
  getIntegrationsService,
  serviceActor,
} from '../../server/platform-context';
import {
  saveIntegrationConfigurationAction,
  setIntegrationStateAction,
  testIntegrationAction,
} from '../../app/[locale]/console/integrations/actions';
import { AdvancedLink } from '../mode-switch';
import {
  ActionLink,
  ActionOutcome,
  AreaBadge,
  SimpleSection,
  flash,
  formatWhen,
} from '../simple-ui';

/**
 * INTEGRATIONS, FOR THE OWNER (contract §13, §14, §15).
 *
 * Cards by PURPOSE — AI, email, file storage, social apps, payments — rather
 * than by configuration domain, and a guided setup per provider generated
 * from the SAME registry the Hub renders. Every write goes through the Hub's
 * three existing server actions (save / test / switch on-off), so settings
 * still become a configuration version and credentials still go through the
 * Secret Service; nothing here stores anything itself.
 *
 * Observability is not listed: it has no provider in the registry, and an
 * empty card would be decoration. Advanced shows it.
 */

export const SIMPLE_CATEGORIES: readonly IntegrationCategory[] = [
  'ai',
  'email',
  'storage',
  'social',
  'payment',
];

function areaKey(category: IntegrationCategory): ReadinessAreaKey {
  return category as ReadinessAreaKey;
}

function providerName(
  locale: string,
  view: Pick<IntegrationView, 'displayNameAr' | 'displayNameEn'>,
) {
  return locale === 'ar' ? view.displayNameAr : view.displayNameEn;
}

async function viewsFor(
  actor: AuthenticatedPlatformActor,
): Promise<readonly IntegrationView[] | null> {
  // The views report credential PRESENCE, which the Secret Service withholds
  // without `platform.secret.read`. Said, not crashed on.
  if (!actor.permissionKeys.includes('platform.secret.read')) return null;
  return getIntegrationsService().list(serviceActor(actor), currentEnvironment());
}

export async function SimpleIntegrations({
  locale,
  actor,
  category,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly category: string | null;
}) {
  const copy = simpleCopy(locale);
  const base = `/${locale}/console/integrations`;
  const views = await viewsFor(actor);

  if (!views) {
    return (
      <Banner tone="info" testId="integrations-withheld">
        {copy('int.noPermission')}
      </Banner>
    );
  }

  const chosen =
    category && SIMPLE_CATEGORIES.includes(category as IntegrationCategory)
      ? (category as IntegrationCategory)
      : null;

  if (chosen) {
    const inCategory = views.filter((view) => view.category === chosen);
    const area = copy(`area.${areaKey(chosen)}` as SimpleKey);
    return (
      <Stack>
        <p style={{ margin: 0 }}>
          <ActionLink href={base} variant="ghost" testId="integrations-back">
            {copy('int.allIntegrations')}
          </ActionLink>
        </p>
        <SimpleSection
          title={fill(copy('int.choose'), {})}
          description={fill(copy('int.chooseIntro'), { area })}
          testId={`integration-choose-${chosen}`}
        >
          {chosen === 'social' ? <Banner tone="info">{copy('int.socialNote')}</Banner> : null}
          {inCategory.every((view) => view.developmentOnly) ? (
            <Banner tone="warning" testId="integration-no-real">
              {copy('int.noRealProvider')}
            </Banner>
          ) : null}
          <ContentGrid min="16rem">
            {inCategory.map((view) => {
              const state = integrationAreaState([view]);
              return (
                <Card key={view.providerKey} testId={`provider-${view.providerKey}`}>
                  <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        gap: spacingTokens.xs,
                      }}
                    >
                      <h3 style={{ margin: 0, ...typographyTokens.h3 }}>
                        {providerName(locale, view)}
                      </h3>
                      <AreaBadge locale={locale} state={state.state} />
                    </div>
                    <p
                      style={{
                        margin: 0,
                        ...typographyTokens.caption,
                        color: colorTokens.textMuted,
                      }}
                    >
                      {view.enabled ? copy('int.provider.active') : copy('int.provider.notActive')}
                      {view.developmentOnly ? ` · ${copy('int.devDouble')}` : ''}
                    </p>
                    <div>
                      <ActionLink
                        href={`${base}/${view.category}/${encodeURIComponent(view.providerKey)}`}
                        testId={`provider-${view.providerKey}-open`}
                      >
                        {view.enabled ? copy('common.manage') : copy('common.setUp')}
                      </ActionLink>
                    </div>
                  </div>
                </Card>
              );
            })}
          </ContentGrid>
        </SimpleSection>
      </Stack>
    );
  }

  return (
    <Stack>
      <p
        style={{
          margin: 0,
          ...typographyTokens.bodySm,
          color: colorTokens.textSecondary,
          maxInlineSize: '68ch',
        }}
      >
        {copy('int.intro')}
      </p>
      <ContentGrid min="16rem" testId="integration-cards">
        {SIMPLE_CATEGORIES.map((key) => {
          const definition = INTEGRATION_CATEGORY_DEFINITIONS.find((c) => c.key === key);
          const inCategory = views.filter((view) => view.category === key);
          const state = integrationAreaState(inCategory);
          const providers = integrationsInCategory(key);
          const only = providers.length === 1 ? providers[0] : null;
          const href = only
            ? `${base}/${key}/${encodeURIComponent(only.providerKey)}`
            : `${base}?category=${key}`;
          const provider = state.provider
            ? locale === 'ar'
              ? state.provider.ar
              : state.provider.en
            : null;
          return (
            <Card key={key} testId={`integration-card-${key}`}>
              <div style={{ display: 'grid', gap: spacingTokens.xs }}>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    gap: spacingTokens.xs,
                  }}
                >
                  <h3 style={{ margin: 0, ...typographyTokens.h3 }}>
                    {copy(`area.${areaKey(key)}` as SimpleKey)}
                  </h3>
                  <AreaBadge
                    locale={locale}
                    state={state.state}
                    testId={`integration-card-${key}-state`}
                  />
                </div>
                <p style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textMuted }}>
                  {definition?.requiredInProduction
                    ? copy('common.required')
                    : copy('common.optional')}
                  {' · '}
                  {fill(copy('int.options'), { count: providers.length })}
                </p>
                <p
                  style={{
                    margin: 0,
                    ...typographyTokens.bodySm,
                    color: colorTokens.textSecondary,
                  }}
                >
                  {copy(`area.${areaKey(key)}.about` as SimpleKey)}
                </p>
                {provider ? (
                  <p style={{ margin: 0, ...typographyTokens.bodySm, fontWeight: 600 }}>
                    {provider}
                  </p>
                ) : null}
                <p
                  style={{
                    margin: 0,
                    ...typographyTokens.caption,
                    color: colorTokens.textSecondary,
                  }}
                >
                  {copy(`reason.${state.reason}` as SimpleKey)}
                </p>
                <div>
                  <ActionLink href={href} testId={`integration-card-${key}-open`}>
                    {state.state === 'setup_required'
                      ? copy('common.setUp')
                      : copy('common.manage')}
                  </ActionLink>
                </div>
              </div>
            </Card>
          );
        })}
      </ContentGrid>
      <div>
        <AdvancedLink
          locale={locale}
          href="/integrations"
          label={copy('mode.technicalDetails')}
          testId="integrations-technical"
        />
      </div>
    </Stack>
  );
}

type StepStatus = 'done' | 'todo' | 'blocked';

function Step({
  locale,
  n,
  title,
  status,
  description,
  children,
  testId,
}: {
  readonly locale: string;
  readonly n: number;
  readonly title: string;
  readonly status: StepStatus | null;
  readonly description?: string | undefined;
  readonly children?: ReactNode;
  readonly testId: string;
}) {
  const copy = simpleCopy(locale);
  return (
    <li style={{ listStyle: 'none' }}>
      <Card
        testId={testId}
        title={`${fill(copy('setup.step'), { n })} · ${title}`}
        description={description}
        actions={
          status ? (
            <StatusBadge
              label={copy(
                status === 'done'
                  ? 'setup.done'
                  : status === 'todo'
                    ? 'setup.todo'
                    : 'setup.blocked',
              )}
              tone={status === 'done' ? 'success' : status === 'todo' ? 'warning' : 'neutral'}
              dot
              testId={`${testId}-status`}
            />
          ) : null
        }
      >
        {children ? <div style={{ display: 'grid', gap: spacingTokens.sm }}>{children}</div> : null}
      </Card>
    </li>
  );
}

/**
 * THE GUIDED SETUP — the Hub's provider page as numbered steps.
 *
 * EACH STEP'S STATUS IS READ, NOT REMEMBERED. "Settings" is done when the Hub
 * reports the configuration complete; "Test" is done when the newest recorded
 * check passed; "Switch on" is done when the active configuration version says
 * so. Visiting a step completes nothing (contract §6).
 */
export async function SimpleIntegrationSetup({
  locale,
  actor,
  category,
  providerKey,
  query,
}: {
  readonly locale: string;
  readonly actor: AuthenticatedPlatformActor;
  readonly category: string;
  readonly providerKey: string;
  readonly query: Record<string, string | string[] | undefined>;
}) {
  const copy = simpleCopy(locale);
  const definition = findIntegration(category, providerKey);
  const categoryDefinition = findIntegrationCategory(category);
  if (!definition || !categoryDefinition) notFound();

  if (!actor.permissionKeys.includes('platform.secret.read')) {
    return (
      <Banner tone="info" testId="integrations-withheld">
        {copy('int.noPermission')}
      </Banner>
    );
  }

  const environment = currentEnvironment();
  const view = await getIntegrationsService().get(
    serviceActor(actor),
    category,
    providerKey,
    environment,
  );
  const mayConfigure = actor.permissionKeys.includes('platform.configuration.manage');
  const mayActivate = actor.permissionKeys.includes('platform.configuration.activate');
  const settings = editableSettingFields(definition);
  const generated = generatedSettingsFor(definition);
  const generatedFields = definition.settingFields.filter(
    (field) => field.generated === true && generated[field.key],
  );
  const fieldCount = settings.length + definition.credentialFields.length;
  const name = providerName(locale, view);
  const area = copy(`area.${areaKey(definition.category)}` as SimpleKey);
  const { ok, error, ref } = flash(query);
  const hidden = (
    <>
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="category" value={category} />
      <input type="hidden" name="providerKey" value={providerKey} />
    </>
  );

  let n = 0;
  const next = () => ++n;
  const hasAddresses = generatedFields.length > 0;
  const testStep = 3 + (hasAddresses ? 1 : 0) + 1;

  const testLine = (() => {
    const when = view.lastCheckedAt ? formatWhen(locale, view.lastCheckedAt) : '';
    switch (view.connection) {
      case 'ok':
        return fill(copy('setup.testOk'), { when });
      case 'failed':
        return fill(copy('setup.testFailed'), { when, message: view.lastMessage ?? '' });
      case 'not_configured':
        return copy('setup.testNotConfigured');
      case 'refused':
        return fill(copy('setup.testRefused'), { message: view.lastMessage ?? '' });
      default:
        return copy('setup.testNever');
    }
  })();

  return (
    <Stack>
      <p style={{ margin: 0 }}>
        <ActionLink
          href={`/${locale}/console/integrations`}
          variant="ghost"
          testId="integrations-back"
        >
          {copy('int.allIntegrations')}
        </ActionLink>
      </p>
      <ActionOutcome
        locale={locale}
        ok={ok}
        error={error}
        reference={ref}
        okText={(code) =>
          code === 'CONNECTION_TESTED'
            ? fill(copy('setup.ok.CONNECTION_TESTED'), { n: testStep })
            : ['CONFIGURATION_SAVED', 'INTEGRATION_ACTIVATED', 'INTEGRATION_DISABLED'].includes(
                  code,
                )
              ? copy(`setup.ok.${code}` as SimpleKey)
              : null
        }
      />
      <div
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: spacingTokens.sm }}
      >
        <h2 style={{ margin: 0, ...typographyTokens.h3 }} data-testid="setup-provider">
          {name}
        </h2>
        <AreaBadge
          locale={locale}
          state={integrationAreaState([view]).state}
          testId="setup-state"
        />
      </div>
      {definition.category === 'social' ? (
        <Banner tone="info">{copy('int.socialNote')}</Banner>
      ) : null}

      <ol
        style={{ margin: 0, padding: 0, display: 'grid', gap: spacingTokens.md }}
        data-testid="setup-steps"
      >
        <Step
          locale={locale}
          n={next()}
          title={copy('setup.what')}
          status={null}
          testId="step-what"
        >
          <p style={{ margin: 0, ...typographyTokens.bodySm }}>
            {copy(`area.${areaKey(definition.category)}.about` as SimpleKey)}
          </p>
          <p style={{ margin: 0, ...typographyTokens.caption, color: colorTokens.textSecondary }}>
            {locale === 'ar' ? view.noteAr : view.noteEn}
          </p>
          {view.developmentOnly ? (
            <StatusBadge label={copy('int.devDouble')} tone="info" testId="setup-dev-double" />
          ) : null}
        </Step>

        <Step
          locale={locale}
          n={next()}
          title={fill(copy('setup.need'), { provider: name })}
          status={null}
          testId="step-need"
        >
          {fieldCount === 0 && generatedFields.length === 0 ? (
            <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('setup.needNothing')}</p>
          ) : (
            <ul
              style={{
                margin: 0,
                paddingInlineStart: spacingTokens.lg,
                ...typographyTokens.bodySm,
              }}
            >
              {[...settings, ...definition.credentialFields].map((field) => (
                <li key={field.key}>
                  <strong>{locale === 'ar' ? field.labelAr : field.labelEn}</strong>
                  {field.secret ? ` (${copy('setup.needCredential')})` : ''}
                  {field.required ? '' : ` — ${copy('common.optional')}`}
                  {field.helpEn ? (
                    <span style={{ color: colorTokens.textSecondary }}>
                      {' — '}
                      {locale === 'ar' ? field.helpAr : field.helpEn}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Step>

        {hasAddresses ? (
          <Step
            locale={locale}
            n={next()}
            title={fill(copy('setup.addresses'), { provider: name })}
            description={copy('setup.addressesIntro')}
            status={null}
            testId="step-addresses"
          >
            {generatedFields.map((field) => (
              <div
                key={field.key}
                style={{ display: 'grid', gap: '2px' }}
                data-testid={`generated-${field.key}`}
              >
                <span style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}>
                  {locale === 'ar' ? field.labelAr : field.labelEn}
                </span>
                <code
                  style={{
                    fontFamily: fontTokens.mono,
                    ...typographyTokens.caption,
                    overflowWrap: 'anywhere',
                    userSelect: 'all',
                  }}
                >
                  {generated[field.key]}
                </code>
              </div>
            ))}
          </Step>
        ) : null}

        <Step
          locale={locale}
          n={next()}
          title={copy('setup.details')}
          description={fieldCount > 0 ? copy('setup.detailsIntro') : undefined}
          status={fieldCount === 0 ? null : view.configurationComplete ? 'done' : 'todo'}
          testId="step-details"
        >
          {fieldCount === 0 ? (
            <p style={{ margin: 0, ...typographyTokens.bodySm }}>{copy('setup.detailsNone')}</p>
          ) : !mayConfigure ? (
            <p
              style={{ margin: 0, ...typographyTokens.bodySm }}
              data-testid="setup-details-forbidden"
            >
              {copy('setup.detailsForbidden')}
            </p>
          ) : (
            <form
              action={saveIntegrationConfigurationAction}
              style={{ display: 'grid', gap: spacingTokens.sm }}
            >
              {hidden}
              {settings.map((field) => (
                <Field
                  key={field.key}
                  label={`${locale === 'ar' ? field.labelAr : field.labelEn}${field.required ? ' *' : ''}`}
                  htmlFor={`simple-setting-${field.key}`}
                  hint={field.helpEn ? (locale === 'ar' ? field.helpAr : field.helpEn) : undefined}
                >
                  <input
                    className="bs-control"
                    id={`simple-setting-${field.key}`}
                    name={`setting.${field.key}`}
                    type={field.kind === 'url' ? 'url' : 'text'}
                    required={field.required}
                    defaultValue={view.settings[field.key] ?? ''}
                    style={{ ...inputStyle(), maxInlineSize: '28rem' }}
                    data-testid={`setting-${field.key}`}
                  />
                </Field>
              ))}
              {definition.credentialFields.map((field) => {
                const status = view.credentials.find((c) => c.fieldKey === field.key);
                return (
                  <Field
                    key={field.key}
                    label={`${locale === 'ar' ? field.labelAr : field.labelEn}${field.required ? ' *' : ''}`}
                    htmlFor={`simple-credential-${field.key}`}
                    hint={
                      status?.present
                        ? fill(copy('setup.credentialSaved'), { hint: status.maskedHint ?? '' })
                        : copy('setup.credentialMissing')
                    }
                  >
                    {/* WRITE-ONLY: no defaultValue, and none is possible —
                        nothing in this product can read a stored secret back. */}
                    <input
                      className="bs-control"
                      id={`simple-credential-${field.key}`}
                      name={`credential.${field.key}`}
                      type="password"
                      autoComplete="new-password"
                      required={field.required && status?.present !== true}
                      style={{ ...inputStyle(), maxInlineSize: '28rem' }}
                      data-testid={`credential-input-${field.key}`}
                    />
                  </Field>
                );
              })}
              <Field
                label={copy('common.reason')}
                htmlFor="simple-save-reason"
                hint={copy('common.reasonHint')}
              >
                <input
                  className="bs-control"
                  id="simple-save-reason"
                  name="reason"
                  required
                  minLength={8}
                  style={{ ...inputStyle(), maxInlineSize: '28rem' }}
                  data-testid="save-reason"
                />
              </Field>
              <div>
                <button
                  type="submit"
                  className={buttonClass('primary')}
                  style={buttonStyle('primary')}
                  data-testid="save-configuration"
                >
                  {copy('setup.save')}
                </button>
              </div>
            </form>
          )}
        </Step>

        <Step
          locale={locale}
          n={next()}
          title={copy('setup.test')}
          description={view.testable ? copy('setup.testIntro') : undefined}
          status={!view.testable ? 'blocked' : view.connection === 'ok' ? 'done' : 'todo'}
          testId="step-test"
        >
          <p style={{ margin: 0, ...typographyTokens.bodySm }} data-testid="setup-test-result">
            {view.testable ? testLine : copy('setup.testNotPossible')}
          </p>
          {view.testable ? (
            <form action={testIntegrationAction}>
              {hidden}
              <button
                type="submit"
                className={buttonClass('neutral')}
                style={buttonStyle('neutral')}
                data-testid="test-connection"
              >
                {copy('setup.testRun')}
              </button>
            </form>
          ) : null}
        </Step>

        <Step
          locale={locale}
          n={next()}
          title={copy('setup.activate')}
          description={fill(copy('setup.activateIntro'), { provider: name, area })}
          status={view.enabled ? 'done' : view.selectionRefusal ? 'blocked' : 'todo'}
          testId="step-activate"
        >
          {view.enabled ? (
            <p
              style={{ margin: 0, ...typographyTokens.bodySm, fontWeight: 600 }}
              data-testid="setup-active"
            >
              {fill(copy('setup.activeNow'), { provider: name })}
            </p>
          ) : null}
          {!view.enabled && view.selectionRefusal ? (
            <Banner tone="warning" testId="setup-refused">
              {fill(copy('setup.refused'), { reason: view.selectionRefusal })}
            </Banner>
          ) : null}
          {!mayActivate ? (
            <p
              style={{ margin: 0, ...typographyTokens.bodySm }}
              data-testid="setup-activate-forbidden"
            >
              {copy('setup.forbidden')}
            </p>
          ) : view.enabled || !view.selectionRefusal ? (
            <form
              action={setIntegrationStateAction}
              style={{ display: 'grid', gap: spacingTokens.sm }}
            >
              {hidden}
              <input type="hidden" name="enable" value={view.enabled ? 'false' : 'true'} />
              <Field
                label={copy('common.reason')}
                htmlFor="simple-state-reason"
                hint={copy('common.reasonHint')}
              >
                <input
                  className="bs-control"
                  id="simple-state-reason"
                  name="reason"
                  required
                  minLength={8}
                  style={{ ...inputStyle(), maxInlineSize: '28rem' }}
                  data-testid="integration-reason"
                />
              </Field>
              {view.enabled ? (
                <label
                  style={{
                    display: 'flex',
                    gap: spacingTokens.xs,
                    alignItems: 'start',
                    ...typographyTokens.bodySm,
                  }}
                >
                  <input type="checkbox" required data-testid="switch-off-confirm" />
                  {fill(copy('setup.switchOffConfirm'), { area })}
                </label>
              ) : null}
              <div>
                <button
                  type="submit"
                  className={buttonClass(view.enabled ? 'danger' : 'primary')}
                  style={buttonStyle(view.enabled ? 'danger' : 'primary')}
                  data-testid={view.enabled ? 'disable-integration' : 'activate-integration'}
                >
                  {fill(copy(view.enabled ? 'setup.switchOff' : 'setup.switchOn'), {
                    provider: name,
                  })}
                </button>
              </div>
            </form>
          ) : null}
          {view.enabled && definition.category === 'ai' ? (
            <div>
              <ActionLink href={`/${locale}/console/ai/profile`} testId="setup-next-profile">
                {copy('setup.nextProfile')}
              </ActionLink>
            </div>
          ) : null}
        </Step>
      </ol>

      <div>
        <AdvancedLink
          locale={locale}
          href={`/integrations/${category}/${encodeURIComponent(providerKey)}`}
          label={copy('mode.technicalDetails')}
          testId="integration-technical"
        />
      </div>
    </Stack>
  );
}
