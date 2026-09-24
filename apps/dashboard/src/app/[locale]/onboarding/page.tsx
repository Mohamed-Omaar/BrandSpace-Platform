import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  CONTROL_CLASS,
  Field,
  StatusBadge,
  buttonClass,
  buttonStyle,
  colorTokens,
  inputStyle,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  visuallyHiddenStyle,
} from '@brandspace/ui';
import { areaDefinition, localizedFrom } from '@brandspace/brand-brain';
import { requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inBrandBrain } from '../../../server/brand-brain-context';
import { inSocial } from '../../../server/social-context';
import { copilotHref } from '../../../server/copilot-surface';
import { setupFactsFor } from '../../../server/setup-wizard';
import {
  SETUP_GOALS,
  recommendedFirstAction,
  setupSteps,
  setupView,
  type SetupView,
} from '../../../server/setup-wizard-state';
import {
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
} from '../../../i18n/messages';
import { CustomerBanner, CustomerCard, WorkspaceShell } from '../../../components/workspace-shell';
import { reviewCandidateAction, uploadSourceAction } from '../brand-brain/actions';
import { connectAccountAction } from '../integrations/actions';
import { createSetupBrandAction, saveFirstGoalAction } from './actions';
import { SetupProgress, SetupStepper } from './setup-stepper';

export const dynamic = 'force-dynamic';

/**
 * THE FIRST-RUN SETUP WIZARD (Phase 6 final, D-277 §6).
 *
 * Workspace → Add brand → Let BrandSpace learn → Review what it found →
 * Connect socials → First goal → "You're ready to start".
 *
 * IT REPLACES A CHECKLIST OF LINKS TO OTHER PAGES with one guided journey — but
 * the work each step does is still the product's own. Creating the brand is the
 * one creation path; uploading and reviewing documents are the Brand Brain's
 * own actions; connecting is the Connections OAuth flow; the goal is a knowledge
 * item in the brand's strategy memory. Each returns here through a closed-set
 * `returnTo`, never a caller-supplied URL.
 *
 * NOTHING HERE IS A STORED POSITION. `setupSteps` derives every step from real
 * rows (`server/setup-wizard-state.ts`), `?step=` only chooses which screen to
 * show, and "Skip for now" is a link.
 *
 * NO REFERENCE DESIGN EXISTS for this screen: it is an APPROVED DESIGN-SYSTEM
 * EXTENSION (CLAUDE.md §4.2) composed of the shell, `Card`, `Field`, the
 * button variants and `StatusBadge` — see docs/UI-FIDELITY-CONTRACT.md §6.
 */

const AREA_ORDER = [
  'IDENTITY',
  'AUDIENCE',
  'OFFERS',
  'TONE_OF_VOICE',
  'DO_DONT',
  'PROOF_POINTS',
  'GLOSSARY',
  'COMPETITORS',
  'STRATEGY',
  'LEARNINGS',
] as const;

const SOURCE_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info'> = {
  UPLOADED: 'info',
  PROCESSING: 'info',
  READY: 'success',
  FAILED: 'danger',
  QUARANTINED: 'danger',
};

export default async function OnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale);
  const may = (key: string) => workspace.permissionKeys.includes(key);

  const brandContext = await brandContextFor(
    workspace,
    '/onboarding',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const brand = requiredBrand(brandContext);
  const unselected = brandContext.resolution.kind === 'unselected';

  const facts = await setupFactsFor(workspace.workspaceId, brand?.id ?? null);
  const steps = setupSteps(facts);
  const view = setupView(query['step'], steps);

  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const reference = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const successText = ok ? statusMessage(ok, locale) : null;
  const errorText = error ? (statusMessage(error, locale, reference) ?? t('setup.error')) : null;

  /*
   * D-303 — THE CUSTOMER'S JOURNEY IS FIVE STEPS. The business account (the
   * workspace, the tenant boundary) already exists by the time the wizard
   * runs, so it is not a step the customer sees; the state model keeps it,
   * complete by construction.
   */
  const journey = steps.filter((step) => step.key !== 'workspace');
  const position =
    view === 'done' ? journey.length : journey.findIndex((step) => step.key === view) + 1;

  const href = (target: SetupView) => `/${locale}/onboarding?step=${target}`;
  const stepLabel = (key: string) => t(`setup.step.${key}` as MessageKey);

  const primaryLink = (target: string, label: string, testId: string) => (
    <Link
      href={target}
      data-testid={testId}
      className={buttonClass('brand')}
      style={buttonStyle('brand')}
    >
      {label}
    </Link>
  );
  const secondaryLink = (target: string, label: string, testId: string) => (
    <Link
      href={target}
      data-testid={testId}
      className={buttonClass('neutral')}
      style={buttonStyle('neutral')}
    >
      {label}
    </Link>
  );
  const skip = (target: SetupView) => secondaryLink(href(target), t('setup.skip'), 'setup-skip');
  const actions = (...children: ReactNode[]) => (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: spacingTokens.sm,
        marginBlockStart: spacingTokens.lg,
      }}
    >
      {children}
    </div>
  );
  const note = (text: string, testId?: string) => (
    <p
      data-testid={testId}
      style={{ margin: 0, ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
    >
      {text}
    </p>
  );

  let body: ReactNode;

  /* ------------------------------------------------------------------ brand */
  if (view === 'brand') {
    if (brand) {
      body = (
        <CustomerCard
          title={t('setup.brand.readyTitle').replace('{brand}', brand.name)}
          description={t('setup.brand.readyBody')}
          testId="setup-brand-ready"
        >
          {actions(
            primaryLink(href('learn'), t('setup.continue'), 'setup-continue'),
            secondaryLink(
              `/${locale}/settings/brand`,
              t('setup.brand.editProfile'),
              'setup-edit-profile',
            ),
          )}
        </CustomerCard>
      );
    } else if (unselected) {
      body = (
        <CustomerCard title={t('brand.chooseTitle')} description={t('brand.chooseBody')}>
          {note(t('setup.brand.chooseHint'))}
        </CustomerCard>
      );
    } else if (!may('brand.manage')) {
      body = (
        <CustomerCard title={t('setup.brand.title')} description={t('setup.brand.body')}>
          {note(t('setup.noPermission'), 'setup-no-permission')}
        </CustomerCard>
      );
    } else {
      body = (
        <CustomerCard
          title={t('setup.brand.title')}
          description={t('setup.brand.body')}
          testId="setup-brand"
        >
          <form
            action={createSetupBrandAction}
            encType="multipart/form-data"
            data-testid="setup-brand-form"
            style={{ display: 'grid', gap: spacingTokens.md, maxInlineSize: '36rem' }}
          >
            <input type="hidden" name="locale" value={locale} />
            <Field label={t('setup.brand.name')} htmlFor="setup-brand-name" required>
              <input
                id="setup-brand-name"
                name="name"
                // D-303 — the business name the account was set up with; the
                // brand is usually the business, and the field stays editable.
                defaultValue={workspace.workspaceName}
                required
                minLength={2}
                maxLength={120}
                className={CONTROL_CLASS}
                style={inputStyle()}
                data-testid="setup-brand-name"
              />
            </Field>
            <Field
              label={t('setup.brand.website')}
              htmlFor="setup-brand-website"
              hint={t('setup.optional')}
            >
              <input
                id="setup-brand-website"
                name="websiteUrl"
                type="url"
                inputMode="url"
                maxLength={2048}
                placeholder={t('setup.brand.websitePlaceholder')}
                dir="ltr"
                className={CONTROL_CLASS}
                style={inputStyle()}
              />
            </Field>
            <Field
              label={t('setup.brand.industry')}
              htmlFor="setup-brand-industry"
              hint={t('setup.optional')}
            >
              <input
                id="setup-brand-industry"
                name="industry"
                maxLength={120}
                className={CONTROL_CLASS}
                style={inputStyle()}
              />
            </Field>
            <Field
              label={t('setup.brand.defaultLanguage')}
              htmlFor="setup-brand-locale"
              hint={t('setup.brand.defaultLanguageHint')}
              required
            >
              <select
                id="setup-brand-locale"
                name="defaultLocale"
                defaultValue="EN"
                className={`${CONTROL_CLASS} bs-select`}
                style={inputStyle()}
                data-testid="setup-brand-locale"
              >
                <option value="EN">{t('brandProfile.localeEn')}</option>
                <option value="AR">{t('brandProfile.localeAr')}</option>
              </select>
            </Field>
            <fieldset
              style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: spacingTokens.xs }}
            >
              <legend style={{ ...typographyTokens.label, marginBlockEnd: spacingTokens.xs }}>
                {t('setup.brand.languages')}
              </legend>
              {(['EN', 'AR'] as const).map((code) => (
                <label
                  key={code}
                  style={{ display: 'inline-flex', gap: spacingTokens.xs, alignItems: 'center' }}
                >
                  <input type="checkbox" name="supportedLocales" value={code} defaultChecked />
                  {t(code === 'EN' ? 'brandProfile.localeEn' : 'brandProfile.localeAr')}
                </label>
              ))}
            </fieldset>
            {/*
              D-303 — the optional identity details sit behind one disclosure,
              so the first step asks only for what the brand needs to exist.
            */}
            <details data-testid="setup-brand-optional">
              <summary
                style={{
                  cursor: 'pointer',
                  ...typographyTokens.label,
                  marginBlockEnd: spacingTokens.sm,
                }}
              >
                {t('setup.brand.optionalDetails')}
              </summary>
              <div style={{ display: 'grid', gap: spacingTokens.md }}>
                <Field
                  label={t('setup.brand.colours')}
                  htmlFor="setup-brand-colours"
                  hint={t('setup.brand.coloursHint')}
                >
                  <input
                    id="setup-brand-colours"
                    name="colorPalette"
                    maxLength={120}
                    dir="ltr"
                    className={CONTROL_CLASS}
                    style={inputStyle()}
                  />
                </Field>
                {may('assets.upload') ? (
                  <Field
                    label={t('setup.brand.logo')}
                    htmlFor="setup-brand-logo"
                    hint={t('setup.brand.logoHint')}
                  >
                    <input
                      id="setup-brand-logo"
                      name="logo"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      style={{ font: 'inherit', ...typographyTokens.bodySm }}
                    />
                  </Field>
                ) : null}
              </div>
            </details>
            <div>
              <button
                type="submit"
                data-testid="setup-create-brand"
                className={buttonClass('brand')}
                style={buttonStyle('brand')}
              >
                {t('setup.brand.submit')}
              </button>
            </div>
          </form>
        </CustomerCard>
      );
    }
  } else if (brand && view === 'learn') {
    /* ------------------------------------------------------------ learn */
    const sources = await inBrandBrain(workspace.workspaceId, ({ db }) =>
      db.brandSourceDocument.findMany({
        where: { brandId: brand.id, deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, fileName: true, status: true },
      }),
    );
    body = (
      <CustomerCard
        title={t('setup.learn.title')}
        description={t('setup.learn.body')}
        testId="setup-learn"
      >
        <ul style={{ margin: 0, paddingInlineStart: spacingTokens.lg, ...typographyTokens.bodySm }}>
          {(['guidelines', 'profile', 'offers', 'presentations', 'faqs'] as const).map((kind) => (
            <li key={kind}>{t(`setup.learn.kind.${kind}` as MessageKey)}</li>
          ))}
        </ul>
        {may('brand_brain.upload') ? (
          <form
            action={uploadSourceAction}
            encType="multipart/form-data"
            data-testid="setup-upload-form"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: spacingTokens.sm,
              alignItems: 'center',
              marginBlockStart: spacingTokens.md,
            }}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="brandId" value={brand.id} />
            <input type="hidden" name="area" value="" />
            <input type="hidden" name="returnTo" value="/onboarding" />
            <input type="hidden" name="step" value="learn" />
            <input
              type="file"
              name="file"
              required
              aria-label={t('bb.uploadChoose')}
              data-testid="setup-upload-input"
              style={{ font: 'inherit', ...typographyTokens.bodySm }}
            />
            <button
              type="submit"
              data-testid="setup-upload-submit"
              className={buttonClass('primary')}
              style={buttonStyle('primary')}
            >
              {t('bb.upload')}
            </button>
          </form>
        ) : (
          note(t('setup.noPermission'), 'setup-no-permission')
        )}
        <p
          style={{
            margin: `${spacingTokens.xs} 0 0`,
            ...typographyTokens.caption,
            color: colorTokens.textMuted,
          }}
        >
          {t('bb.uploadHint')}
        </p>
        {sources.length > 0 ? (
          <ul
            data-testid="setup-sources"
            style={{
              listStyle: 'none',
              margin: `${spacingTokens.md} 0 0`,
              padding: 0,
              display: 'grid',
              gap: spacingTokens.xs,
            }}
          >
            {sources.map((source) => (
              <li
                key={source.id}
                style={{
                  display: 'flex',
                  gap: spacingTokens.sm,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ ...typographyTokens.bodySm, overflowWrap: 'anywhere' }}>
                  {source.fileName}
                </span>
                <StatusBadge
                  label={t(`setup.source.${source.status}` as MessageKey)}
                  tone={SOURCE_TONE[source.status] ?? 'neutral'}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {facts.sources.processing > 0
          ? note(t('setup.learn.processing'), 'setup-processing')
          : null}
        {actions(
          facts.sources.total > 0
            ? primaryLink(href('review'), t('setup.continue'), 'setup-continue')
            : null,
          facts.sources.total > 0 ? null : skip('connect'),
        )}
      </CustomerCard>
    );
  } else if (brand && view === 'review') {
    /* ----------------------------------------------------------- review */
    const candidates = may('brand_brain.review')
      ? await inBrandBrain(workspace.workspaceId, ({ db }) =>
          db.brandKnowledgeCandidate.findMany({
            where: { brandId: brand.id, status: 'PENDING', sourceKind: 'DOCUMENT' },
            orderBy: { createdAt: 'asc' },
            take: 50,
            select: {
              id: true,
              area: true,
              extractedTitle: true,
              extractedBody: true,
              confidenceMilli: true,
            },
          }),
        )
      : [];
    const pick = (value: unknown) => {
      const text = localizedFrom(value as never);
      return (locale === 'ar' ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? '';
    };
    const groups = AREA_ORDER.map((area) => ({
      area,
      items: candidates.filter((candidate) => candidate.area === area),
    })).filter((group) => group.items.length > 0);
    /*
     * D-303 — ONE AREA OPEN AT A TIME. Every area is a disclosure titled with
     * its count; the one the reader just acted in (the review action returns
     * `?area=`) stays open, otherwise the first. Nothing is decided for them —
     * each fact is still accepted, edited or rejected one by one.
     */
    const requestedArea = typeof query['area'] === 'string' ? query['area'] : null;
    const openArea = groups.some((group) => group.area === requestedArea)
      ? requestedArea
      : (groups[0]?.area ?? null);
    const toReview = groups.reduce((total, group) => total + group.items.length, 0);

    body = (
      <CustomerCard
        title={t('setup.review.title')}
        description={t('setup.review.body')}
        testId="setup-review"
      >
        {facts.sources.total === 0 ? (
          <>
            {note(t('setup.review.nothing'), 'setup-review-nothing')}
            {actions(
              secondaryLink(href('learn'), t('setup.review.addDocuments'), 'setup-back-learn'),
              skip('connect'),
            )}
          </>
        ) : !may('brand_brain.review') ? (
          <>
            {note(t('setup.noPermission'), 'setup-no-permission')}
            {actions(skip('connect'))}
          </>
        ) : groups.length === 0 ? (
          <>
            {facts.sources.processing > 0
              ? note(t('setup.learn.processing'), 'setup-processing')
              : note(
                  t('setup.review.allDone').replace('{count}', String(facts.activeKnowledge)),
                  'setup-review-done',
                )}
            {actions(
              facts.sources.processing > 0
                ? secondaryLink(href('review'), t('setup.refresh'), 'setup-refresh')
                : null,
              primaryLink(href('connect'), t('setup.continue'), 'setup-continue'),
            )}
          </>
        ) : (
          <>
            {note(
              t('setup.review.summary')
                .replace('{count}', String(toReview))
                .replace('{areas}', String(groups.length)),
              'setup-review-summary',
            )}
            <div style={{ display: 'grid', gap: spacingTokens.sm }}>
              {groups.map((group) => (
                <details
                  key={group.area}
                  open={group.area === openArea}
                  data-testid={`setup-area-${group.area}`}
                  style={{
                    borderRadius: radiusTokens.lg,
                    border: `1px solid ${colorTokens.border}`,
                    padding: spacingTokens.sm,
                  }}
                >
                  <summary
                    style={{
                      cursor: 'pointer',
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: spacingTokens.xs,
                      ...typographyTokens.cardTitle,
                    }}
                  >
                    {t(`bb.area.${areaDefinition(group.area).messageKey}` as MessageKey)}
                    <span style={{ ...typographyTokens.caption, color: colorTokens.textSecondary }}>
                      {t('setup.review.toReview').replace('{count}', String(group.items.length))}
                    </span>
                  </summary>
                  <ul
                    style={{
                      listStyle: 'none',
                      margin: `${spacingTokens.sm} 0 0`,
                      padding: 0,
                      display: 'grid',
                      gap: spacingTokens.sm,
                    }}
                  >
                    {group.items.map((candidate) => {
                      const title = localizedFrom(candidate.extractedTitle);
                      const text = localizedFrom(candidate.extractedBody);
                      const hidden = (decision: string) => (
                        <>
                          <input type="hidden" name="locale" value={locale} />
                          <input type="hidden" name="area" value={candidate.area} />
                          <input type="hidden" name="candidateId" value={candidate.id} />
                          <input type="hidden" name="decision" value={decision} />
                          <input type="hidden" name="returnTo" value="/onboarding" />
                          <input type="hidden" name="step" value="review" />
                        </>
                      );
                      return (
                        <li
                          key={candidate.id}
                          data-testid={`setup-candidate-${candidate.id}`}
                          style={{
                            display: 'grid',
                            gap: spacingTokens.xs,
                            padding: spacingTokens.md,
                            borderRadius: radiusTokens.lg,
                            background: colorTokens.surfaceSoft,
                          }}
                        >
                          <strong style={typographyTokens.bodySm}>
                            {pick(candidate.extractedTitle)}
                          </strong>
                          <span
                            style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
                          >
                            {pick(candidate.extractedBody)}
                          </span>
                          <span
                            style={{ ...typographyTokens.caption, color: colorTokens.textMuted }}
                          >
                            {t('setup.review.confidence').replace(
                              '{percent}',
                              String(Math.round(candidate.confidenceMilli / 10)),
                            )}
                          </span>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.xs }}>
                            <form action={reviewCandidateAction}>
                              {hidden('accept')}
                              <button
                                type="submit"
                                data-testid={`setup-accept-${candidate.id}`}
                                className={buttonClass('primary')}
                                style={buttonStyle('primary', 'sm')}
                              >
                                {t('bb.reviewAccept')}
                              </button>
                            </form>
                            <form action={reviewCandidateAction}>
                              {hidden('reject')}
                              <button
                                type="submit"
                                data-testid={`setup-reject-${candidate.id}`}
                                className={buttonClass('neutral')}
                                style={buttonStyle('neutral', 'sm')}
                              >
                                {t('bb.reviewReject')}
                              </button>
                            </form>
                          </div>
                          <details>
                            <summary
                              style={{
                                cursor: 'pointer',
                                ...typographyTokens.caption,
                                fontWeight: 700,
                              }}
                            >
                              {t('bb.reviewEdit')}
                            </summary>
                            <form
                              action={reviewCandidateAction}
                              style={{
                                display: 'grid',
                                gap: spacingTokens.xs,
                                marginBlockStart: spacingTokens.xs,
                              }}
                            >
                              {hidden('accept_edited')}
                              <input
                                name="titleEn"
                                defaultValue={title.en ?? ''}
                                aria-label={t('bb.reviewEditTitleEn')}
                                dir="ltr"
                                className={CONTROL_CLASS}
                                style={inputStyle()}
                              />
                              <input
                                name="titleAr"
                                defaultValue={title.ar ?? ''}
                                aria-label={t('bb.reviewEditTitleAr')}
                                dir="rtl"
                                className={CONTROL_CLASS}
                                style={inputStyle()}
                              />
                              <textarea
                                name="bodyEn"
                                rows={3}
                                defaultValue={text.en ?? ''}
                                aria-label={t('bb.reviewEditBodyEn')}
                                dir="ltr"
                                className={CONTROL_CLASS}
                                style={{ ...inputStyle(), resize: 'vertical' }}
                              />
                              <textarea
                                name="bodyAr"
                                rows={3}
                                defaultValue={text.ar ?? ''}
                                aria-label={t('bb.reviewEditBodyAr')}
                                dir="rtl"
                                className={CONTROL_CLASS}
                                style={{ ...inputStyle(), resize: 'vertical' }}
                              />
                              <div>
                                <button
                                  type="submit"
                                  data-testid={`setup-accept-edited-${candidate.id}`}
                                  className={buttonClass('primary')}
                                  style={buttonStyle('primary', 'sm')}
                                >
                                  {t('bb.reviewAcceptEdited')}
                                </button>
                              </div>
                            </form>
                          </details>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ))}
            </div>
            {actions(skip('connect'))}
          </>
        )}
      </CustomerCard>
    );
  } else if (brand && view === 'connect') {
    /* ---------------------------------------------------------- connect */
    const social = may('integrations.read')
      ? await inSocial(workspace.workspaceId, async (services) => {
          const registry = await services.registry();
          const policy = await services.policy();
          const connections = await (
            await services.connections()
          ).list({
            brandScope: workspace.brandScope,
          });
          return {
            providers: registry
              .enabledProviders()
              .filter(
                (provider) => policy.providers[provider.toLowerCase() as never] !== undefined,
              ),
            connections: connections.filter((connection) => connection.brandId === brand.id),
          };
        })
      : { providers: [], connections: [] };
    const providerLabel = (provider: string) =>
      optionalMessage(locale, `integrations.provider.${provider.toLowerCase()}`) ?? provider;

    body = (
      <CustomerCard
        title={t('setup.connect.title')}
        description={t('setup.connect.body')}
        testId="setup-connect"
      >
        {social.connections.length > 0 ? (
          <ul
            data-testid="setup-connections"
            style={{
              listStyle: 'none',
              margin: `0 0 ${spacingTokens.md}`,
              padding: 0,
              display: 'grid',
              gap: spacingTokens.xs,
            }}
          >
            {social.connections.map((connection) => (
              <li
                key={connection.id}
                style={{
                  display: 'flex',
                  gap: spacingTokens.sm,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                <span style={typographyTokens.bodySm}>
                  {providerLabel(connection.provider)} · {connection.displayName}
                </span>
                <StatusBadge
                  label={t(
                    connection.status === 'ACTIVE'
                      ? 'setup.connect.connected'
                      : 'setup.connect.attention',
                  )}
                  tone={connection.status === 'ACTIVE' ? 'success' : 'warning'}
                />
              </li>
            ))}
          </ul>
        ) : null}
        {!may('integrations.manage') ? (
          note(t('setup.noPermission'), 'setup-no-permission')
        ) : social.providers.length === 0 ? (
          note(t('setup.connect.none'), 'setup-connect-none')
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
            {social.providers.map((provider) => (
              <form key={provider} action={connectAccountAction}>
                <input type="hidden" name="locale" value={locale} />
                <input type="hidden" name="provider" value={provider} />
                <input type="hidden" name="brandId" value={brand.id} />
                <input type="hidden" name="returnTo" value="/onboarding" />
                <button
                  type="submit"
                  data-testid={`setup-connect-${provider.toLowerCase()}`}
                  className={buttonClass('primary')}
                  style={buttonStyle('primary')}
                >
                  {t('setup.connect.provider').replace('{provider}', providerLabel(provider))}
                </button>
              </form>
            ))}
          </div>
        )}
        {actions(
          facts.activeConnections > 0
            ? primaryLink(href('goal'), t('setup.continue'), 'setup-continue')
            : skip('goal'),
        )}
      </CustomerCard>
    );
  } else if (brand && view === 'goal') {
    /* ------------------------------------------------------------- goal */
    const chosen = facts.goal?.objective ?? null;
    body = (
      <CustomerCard
        title={t('setup.goal.title')}
        description={t('setup.goal.body')}
        testId="setup-goal"
      >
        {may('brand_brain.edit') ? (
          <form
            action={saveFirstGoalAction}
            data-testid="setup-goal-form"
            style={{ display: 'grid', gap: spacingTokens.md }}
          >
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="brandId" value={brand.id} />
            <fieldset
              style={{ border: 0, margin: 0, padding: 0, display: 'grid', gap: spacingTokens.xs }}
            >
              <legend style={visuallyHiddenStyle()}>{t('setup.goal.title')}</legend>
              {[...SETUP_GOALS, 'unsure' as const].map((goal) => (
                <label
                  key={goal}
                  style={{
                    display: 'flex',
                    gap: spacingTokens.sm,
                    alignItems: 'center',
                    padding: spacingTokens.sm,
                    borderRadius: radiusTokens.md,
                    background: colorTokens.surfaceSoft,
                    cursor: 'pointer',
                    ...typographyTokens.bodySm,
                  }}
                >
                  <input
                    type="radio"
                    name="goal"
                    value={goal}
                    required
                    defaultChecked={goal === chosen}
                    data-testid={`setup-goal-${goal.toLowerCase()}`}
                  />
                  {t(`setup.goal.${goal}` as MessageKey)}
                </label>
              ))}
            </fieldset>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: spacingTokens.sm }}>
              <button
                type="submit"
                data-testid="setup-goal-submit"
                className={buttonClass('brand')}
                style={buttonStyle('brand')}
              >
                {t('setup.goal.submit')}
              </button>
              {skip('done')}
            </div>
          </form>
        ) : (
          <>
            {note(t('setup.noPermission'), 'setup-no-permission')}
            {actions(skip('done'))}
          </>
        )}
      </CustomerCard>
    );
  } else if (brand) {
    /* ------------------------------------------------------------- done */
    const recommended = recommendedFirstAction(facts);
    const plan = may('copilot.use')
      ? {
          href: copilotHref(locale, 'campaigns'),
          label: t('setup.done.plan'),
          testId: 'setup-plan',
        }
      : null;
    const create = may('content.create')
      ? {
          href: `/${locale}/content/compose`,
          label: t('setup.done.create'),
          testId: 'setup-create-post',
        }
      : null;
    const [first, second] =
      recommended === 'plan'
        ? [plan ?? create, plan ? create : null]
        : [create ?? plan, create ? plan : null];
    const summary: readonly [string, string][] = [
      [t('setup.step.brand'), brand.name],
      [t('setup.done.knowledge'), String(facts.activeKnowledge)],
      [t('setup.done.connections'), String(facts.activeConnections)],
      [
        t('setup.step.goal'),
        facts.goal?.objective
          ? t(`setup.goal.${facts.goal.objective}` as MessageKey)
          : t('setup.done.noGoal'),
      ],
    ];
    body = (
      <CustomerCard
        title={t('setup.done.title').replace('{brand}', brand.name)}
        description={t('setup.done.body')}
        testId="setup-done"
      >
        <dl style={{ margin: 0, display: 'grid', gap: spacingTokens.xs }}>
          {summary.map(([term, value]) => (
            <div key={term} style={{ display: 'flex', gap: spacingTokens.sm, flexWrap: 'wrap' }}>
              <dt style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>
                {term}
              </dt>
              <dd style={{ margin: 0, ...typographyTokens.bodySm, fontWeight: 600 }}>{value}</dd>
            </div>
          ))}
        </dl>
        {first
          ? note(t(recommended === 'plan' && plan ? 'setup.done.whyPlan' : 'setup.done.whyCreate'))
          : null}
        {actions(
          first ? primaryLink(first.href, first.label, first.testId) : null,
          second ? secondaryLink(second.href, second.label, second.testId) : null,
          secondaryLink(`/${locale}/overview`, t('setup.done.home'), 'setup-home'),
        )}
      </CustomerCard>
    );
  }

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={t('setup.title')}
      description={t('setup.subtitle')}
      activePath="/onboarding"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={workspace.permissionKeys}
      focus
    >
      {successText ? <CustomerBanner tone="success">{successText}</CustomerBanner> : null}
      {errorText ? <CustomerBanner tone="error">{errorText}</CustomerBanner> : null}
      <div
        data-testid="setup-wizard"
        data-view={view}
        style={{ display: 'grid', gap: spacingTokens.lg }}
      >
        <SetupProgress
          label={t('setup.stepsLabel')}
          position={position}
          total={journey.length}
          text={
            view === 'done'
              ? t('setup.progress.complete')
              : t('setup.progress.step')
                  .replace('{n}', String(position))
                  .replace('{total}', String(journey.length))
                  .replace('{step}', stepLabel(view))
          }
          exit={{ href: `/${locale}/overview`, label: t('setup.progress.exit') }}
        />
        <SetupStepper
          label={t('setup.stepsLabel')}
          steps={journey}
          view={view}
          hasBrand={brand !== null}
          href={href}
          stepLabel={stepLabel}
          doneLabel={t('setup.stepDone')}
        />
        {body}
      </div>
    </WorkspaceShell>
  );
}
