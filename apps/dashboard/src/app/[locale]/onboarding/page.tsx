import Link from 'next/link';
import type { ReactNode } from 'react';
import { localizedFrom, areaDefinition } from '@brandspace/brand-brain';
import { TenantOnboardingPolicySource } from '@brandspace/onboarding';
import { countryOptions, currentEnvironment } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor, requiredBrand } from '../../../server/brand-context';
import { inBrandBrain } from '../../../server/brand-brain-context';
import { inSocial } from '../../../server/social-context';
import { copilotHref } from '../../../server/copilot-surface';
import { setupFactsFor } from '../../../server/setup-wizard';
import { paletteFrom } from '../../../server/brand-profile';
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
import { CustomerBanner } from '../../../components/workspace-shell';
import { SetupFooter, SetupFrame } from '../../../components/setup-frame';
import { uploadSourceAction } from '../brand-brain/actions';
import { connectAccountAction } from '../integrations/actions';
import { ChannelMark } from '../calendar/prototype-calendar';
import {
  attachSetupLogoAction,
  createSetupBrandAction,
  uploadSetupLogoAction,
  reviewSetupCandidateAction,
  acceptAllSetupCandidatesAction,
  saveFirstGoalAction,
} from './actions';
import { SetupUploadTile } from './upload-tile';
import { LogoPicker, type LogoNow } from './logo-picker';
import { LogoAttach } from './logo-attach';
import { inAssetLibrary } from '../../../server/assets-context';
import { issuePreviewToken } from '../../../server/media-picker';
import { assetUploadRules, sourceUploadRules } from '../../../server/upload-rules';
import { sourceFailureText } from '../../../server/source-failure';
import { UploadForm, type UploadTexts } from '../../../components/upload-field';
import { RefreshWhile } from '../../../components/refresh-while';
import { IndustryField } from '../../../components/industry-field';
import { SetupBrandLanguages } from '../../../components/setup-brand-languages';

export const dynamic = 'force-dynamic';

/**
 * THE FIRST-RUN SETUP WIZARD — `Auth.dc.html` lines 114–200 (D-468; review of
 * #67, round 3).
 *
 * The prototype's five steps and its Ready screen, each with its own form:
 * Business · Brand · Teach · Accounts · Goal, then "<brand> is ready". The work
 * each step does is still the product's own: the workspace form makes the
 * workspace (/onboarding/workspace); creating the brand is the one creation
 * path; uploading and reviewing documents are the Brand Brain's own actions;
 * connecting is the Connections OAuth flow; the goal is a knowledge item in the
 * brand's strategy memory. Each returns here through a closed-set `returnTo`.
 *
 * A STEP ALWAYS SHOWS ITS FORM. Where the data already exists (the workspace,
 * the brand) the form is drawn prefilled; it cannot be saved from here yet
 * (the Settings actions return to Settings), so its fields are read-only and
 * the step says where to change them.
 *
 * NOTHING HERE IS A STORED POSITION. `setupSteps` derives every step from real
 * rows (`server/setup-wizard-state.ts`); `?step=` only chooses which screen to
 * show, and Skip is a link.
 */

type WizardView = SetupView | 'business';

export default async function OnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const { customer, workspace, messageLocale } = await requireWorkspace(locale);
  const t = translator(messageLocale);
  const may = (key: string) => workspace.permissionKeys.includes(key);
  // Batch 7 (A3): the words every upload control here says, before, during and on refusal.
  const uploadTexts: UploadTexts = {
    rules: t('upload.rules'),
    refusedType: t('upload.refusedType'),
    refusedSize: t('upload.refusedSize'),
    refusedEmpty: t('upload.refusedEmpty'),
    uploading: t('upload.uploading'),
    connection: t('upload.connection'),
  };
  const logoTexts = {
    upload: t('setup.wz.brand.uploadLogo'),
    change: t('upload.change'),
    remove: t('upload.remove'),
    chosen: t('upload.chosen'),
  };
  const assetReason = (reason: string) =>
    optionalMessage(messageLocale, `assets.reason.${reason}`) ?? t('upload.connection');

  const brandContext = await brandContextFor(
    workspace,
    '/onboarding',
    typeof query['brand'] === 'string' ? query['brand'] : null,
  );
  const brand = requiredBrand(brandContext);
  const unselected = brandContext.resolution.kind === 'unselected';

  const facts = await setupFactsFor(workspace.workspaceId, brand?.id ?? null);
  const steps = setupSteps(facts);
  // "business" shows the workspace's own form; it never decides a position.
  const view: WizardView =
    query['step'] === 'business' ? 'business' : setupView(query['step'], steps);

  const ok = typeof query['ok'] === 'string' ? query['ok'] : null;
  const error = typeof query['error'] === 'string' ? query['error'] : null;
  const reference = typeof query['ref'] === 'string' ? query['ref'] : undefined;
  const successText = ok ? statusMessage(ok, locale) : null;
  const errorText = error ? (statusMessage(error, locale, reference) ?? t('setup.error')) : null;

  const href = (target: WizardView) => `/${locale}/onboarding?step=${target}`;
  const stepLabel = (key: string) => t(`setup.step.${key}` as MessageKey);
  const pickText = (value: unknown) => {
    const text = localizedFrom(value as never);
    return (locale === 'ar' ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? '';
  };

  /* The footer's controls (`Auth.dc.html` line 196). */
  const backLink = (target: WizardView) => (
    <Link href={href(target)} className="bsp-wz-btn bsp-wz-ghost" data-testid="setup-back">
      {t('setup.wz.back')}
    </Link>
  );
  const skipLink = (target: WizardView) => (
    <Link href={href(target)} className="bsp-wz-btn bsp-wz-ghost" data-testid="setup-skip">
      {t('setup.wz.skip')}
    </Link>
  );
  const continueLink = (target: WizardView) => (
    <Link href={href(target)} className="bsp-wz-btn bsp-wz-pur" data-testid="setup-continue">
      {t('setup.continue')}
    </Link>
  );
  const note = (text: string, testId?: string) => (
    <p className="bsp-wz-hint" data-testid={testId}>
      {text}
    </p>
  );
  const savedNote = t('setup.wz.saved');

  let body: ReactNode = null;
  let footer: ReactNode = null;
  let head: { title: string; description?: string } = { title: t('setup.title') };

  /* --------------------------------------------------------------- business */
  if (view === 'business') {
    const [row, industries, brandRow] = await Promise.all([
      inWorkspace(workspace.workspaceId, ({ db }) =>
        db.workspace.findUniqueOrThrow({
          where: { id: workspace.workspaceId },
          select: { name: true, country: true, timezone: true },
        }),
      ),
      inBrandBrain(
        workspace.workspaceId,
        async ({ db }) =>
          (await new TenantOnboardingPolicySource(db, currentEnvironment()).load()).industries,
      ),
      brand
        ? inWorkspace(workspace.workspaceId, ({ db }) =>
            db.brand.findUnique({ where: { id: brand.id }, select: { industry: true } }),
          )
        : Promise.resolve(null),
    ]);
    const country = countryOptions(locale).find((option) => option.value === row.country);
    head = { title: t('setup.wz.business.title'), description: t('setup.wz.business.body') };
    body = (
      <section className="bsp-wz-body" data-testid="setup-business">
        <div className="bsp-wz-grid2">
          <div>
            <label className="bsp-wz-lb" htmlFor="setup-business-name">
              {t('setup.wz.business.name')}
            </label>
            <input
              id="setup-business-name"
              className="bs-control"
              value={row.name}
              readOnly
              dir="auto"
            />
          </div>
          <div>
            <label className="bsp-wz-lb" htmlFor="setup-business-country">
              {t('setup.wz.business.country')}
            </label>
            <input
              id="setup-business-country"
              className="bs-control"
              value={country?.label ?? row.country ?? ''}
              readOnly
            />
          </div>
          {/* The industry is the brand's; shown here, as the prototype asks it here. */}
          <div className="bsp-wz-full">
            <span className="bsp-wz-lb" id="setup-business-industry">
              {t('setup.wz.business.industry')}
            </span>
            <div className="bsp-wz-chips" role="group" aria-labelledby="setup-business-industry">
              {industries.map((industry) => (
                <span
                  key={industry.key}
                  className="bsp-wz-chip bsp-wz-chip-sm"
                  aria-pressed={brandRow?.industry === industry.key}
                  aria-disabled="true"
                >
                  {locale === 'ar' ? industry.name.ar : industry.name.en}
                </span>
              ))}
            </div>
          </div>
          <span className="bsp-wz-full bsp-wz-hint" data-testid="setup-business-zone">
            {t('setup.wz.business.zone').replace('{zone}', row.timezone)}{' '}
            {may('workspace.update') ? (
              <Link href={`/${locale}/settings`} className="bsp-lnk">
                {t('setup.wz.changeInSettings')}
              </Link>
            ) : null}
          </span>
        </div>
      </section>
    );
    footer = <SetupFooter note={savedNote} next={continueLink('brand')} />;
  } else if (view === 'brand') {
    /* ---------------------------------------------------------------- brand */
    head = { title: t('setup.brand.title'), description: t('setup.wz.brand.body') };
    if (brand) {
      // A STEP ALWAYS SHOWS ITS FORM (round 3): the brand's own answers, prefilled.
      const row = await inWorkspace(workspace.workspaceId, ({ db }) =>
        db.brand.findUnique({
          where: { id: brand.id },
          select: {
            name: true,
            websiteUrl: true,
            supportedLocales: true,
            colorPalette: true,
            primaryLogoAssetId: true,
          },
        }),
      );
      const palette = paletteFrom(row?.colorPalette).slice(0, 3);
      const languages = (row?.supportedLocales as readonly string[] | undefined) ?? [];
      /*
       * BATCH 7 (A3) — THE LOGO'S STATE, IN ITS OWN PLACE: the brand's logo, a
       * file still being checked (`?logo=`), or the reason one was refused
       * (`?logoReason=`). A file that has passed since is attached by the step.
       */
      const logoRules = await inAssetLibrary(workspace.workspaceId, async (services) =>
        assetUploadRules(await services.policy(), ['image']),
      );
      const pendingLogo = typeof query['logo'] === 'string' ? query['logo'] : null;
      const refusedLogo = typeof query['logoReason'] === 'string' ? query['logoReason'] : null;
      let logoNow: LogoNow | null = null;
      let logoReady: string | null = null;
      const viewer = {
        workspaceId: workspace.workspaceId,
        userId: customer.userId,
        permissionKeys: workspace.permissionKeys,
        brandScope: workspace.brandScope,
      };
      if (row?.primaryLogoAssetId) {
        const shown = await issuePreviewToken({ ...viewer, assetId: row.primaryLogoAssetId }).catch(
          () => null,
        );
        logoNow = {
          name: shown?.name ?? '',
          src: shown?.previewToken ? `/${locale}/assets/file/${shown.previewToken}` : null,
          state: 'ready',
          message: t('setup.wz.brand.logoAdded').replace('{name}', shown?.name ?? ''),
        };
      } else if (refusedLogo) {
        logoNow = {
          name: '',
          src: null,
          state: 'failed',
          message: t('setup.wz.brand.logoFailed').replace('{reason}', assetReason(refusedLogo)),
        };
      } else if (pendingLogo) {
        const file = await inBrandBrain(workspace.workspaceId, ({ db }) =>
          db.asset.findFirst({
            where: { id: pendingLogo, brandId: brand.id, deletedAt: null },
            select: { name: true, status: true, scanStatus: true, failureReason: true },
          }),
        );
        if (file && file.status === 'READY' && file.scanStatus === 'CLEAN') {
          logoReady = pendingLogo;
          logoNow = {
            name: file.name,
            src: null,
            state: 'checking',
            message: t('upload.checking').replace('{name}', file.name),
          };
        } else if (
          !file ||
          file.status === 'PROCESSING_FAILED' ||
          file.status === 'QUARANTINED' ||
          file.scanStatus === 'INFECTED'
        ) {
          logoNow = {
            name: file?.name ?? '',
            src: null,
            state: 'failed',
            message: t('setup.wz.brand.logoFailed').replace(
              '{reason}',
              assetReason(file?.failureReason ?? (file ? 'infected' : 'object_missing')),
            ),
          };
        } else {
          logoNow = {
            name: file.name,
            src: null,
            state: 'checking',
            message: t('setup.wz.brand.logoChecking').replace('{name}', file.name),
          };
        }
      }
      body = (
        <section className="bsp-wz-body bsp-wz-scroll" data-testid="setup-brand-ready">
          <div className="bsp-wz-brandgrid">
            <div className="bsp-wz-col">
              <div>
                <label className="bsp-wz-lb" htmlFor="setup-brand-name">
                  {t('setup.brand.name')}
                </label>
                <input
                  id="setup-brand-name"
                  className="bs-control"
                  value={row?.name ?? brand.name}
                  readOnly
                  dir="auto"
                  data-testid="setup-brand-name"
                />
              </div>
              <div>
                <label className="bsp-wz-lb" htmlFor="setup-brand-website">
                  {t('setup.wz.brand.website')}
                </label>
                <input
                  id="setup-brand-website"
                  className="bs-control bsp-ltr"
                  value={row?.websiteUrl ?? ''}
                  readOnly
                  dir="ltr"
                />
              </div>
              <div>
                <span className="bsp-wz-lb" id="setup-brand-langs">
                  {t('setup.wz.brand.languages')}
                </span>
                <div className="bsp-wz-chips" role="group" aria-labelledby="setup-brand-langs">
                  {(['AR', 'EN'] as const).map((code) => (
                    <span
                      key={code}
                      className="bsp-wz-chip bsp-wz-chip-sm"
                      aria-pressed={languages.includes(code)}
                      aria-disabled="true"
                    >
                      {t(code === 'AR' ? 'brandProfile.localeAr' : 'brandProfile.localeEn')}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="bsp-wz-look">
              <span className="bsp-wz-lb">{t('setup.wz.brand.logoColours')}</span>
              {may('brand.manage') && may('assets.upload') ? (
                <UploadForm
                  action={uploadSetupLogoAction}
                  rules={logoRules}
                  locale={locale}
                  texts={uploadTexts}
                  data-testid="setup-logo-form"
                >
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="brandId" value={brand.id} />
                  <LogoPicker
                    initial={(row?.name ?? brand.name).trim().charAt(0).toUpperCase()}
                    now={logoNow}
                    submitOnChoose
                    texts={logoTexts}
                  />
                </UploadForm>
              ) : (
                <div className="bsp-wz-logo-row">
                  <span className="bsp-wz-logo" aria-hidden="true">
                    {logoNow?.src ? (
                      <img src={logoNow.src} alt="" />
                    ) : (
                      (row?.name ?? brand.name).trim().charAt(0).toUpperCase()
                    )}
                  </span>
                </div>
              )}
              <RefreshWhile active={logoNow?.state === 'checking' && logoReady === null} />
              {logoReady ? (
                <LogoAttach
                  action={attachSetupLogoAction}
                  locale={locale}
                  brandId={brand.id}
                  assetId={logoReady}
                />
              ) : null}
              {palette.length > 0 ? (
                <div className="bsp-wz-swatches">
                  {palette.map((hex) => (
                    <span
                      key={hex}
                      className="bsp-wz-swatch"
                      style={{ background: hex }}
                      title={hex}
                      aria-label={hex}
                    />
                  ))}
                </div>
              ) : null}
              <span className="bsp-wz-hint">{t('setup.wz.brand.inSettings')}</span>
            </div>
          </div>
        </section>
      );
      footer = (
        <SetupFooter note={savedNote} back={backLink('business')} next={continueLink('learn')} />
      );
    } else if (unselected) {
      head = { title: t('brand.chooseTitle'), description: t('brand.chooseBody') };
      body = <section className="bsp-wz-body">{note(t('setup.brand.chooseHint'))}</section>;
      footer = <SetupFooter note={savedNote} back={backLink('business')} />;
    } else if (!may('brand.manage')) {
      body = (
        <section className="bsp-wz-body">
          {note(t('setup.noPermission'), 'setup-no-permission')}
        </section>
      );
      footer = <SetupFooter note={savedNote} back={backLink('business')} />;
    } else {
      const industries = await inBrandBrain(
        workspace.workspaceId,
        async ({ db }) =>
          (await new TenantOnboardingPolicySource(db, currentEnvironment()).load()).industries,
      );
      const logoRules = await inAssetLibrary(workspace.workspaceId, async (services) =>
        assetUploadRules(await services.policy(), ['image']),
      );
      body = (
        <section className="bsp-wz-body bsp-wz-scroll" data-testid="setup-brand">
          <UploadForm
            id="setup-brand-form"
            action={createSetupBrandAction}
            rules={logoRules}
            locale={locale}
            texts={uploadTexts}
            data-testid="setup-brand-form"
            className="bsp-wz-brandgrid"
          >
            <input type="hidden" name="locale" value={locale} />
            <div className="bsp-wz-col">
              <div>
                <label className="bsp-wz-lb" htmlFor="setup-brand-name">
                  {t('setup.brand.name')}
                </label>
                <input
                  id="setup-brand-name"
                  name="name"
                  // D-303 — the business name the account was set up with; the
                  // brand is usually the business, and the field stays editable.
                  defaultValue={workspace.workspaceName}
                  required
                  minLength={2}
                  maxLength={120}
                  className="bs-control"
                  dir="auto"
                  data-testid="setup-brand-name"
                />
              </div>
              <div>
                <label className="bsp-wz-lb" htmlFor="setup-brand-website">
                  {t('setup.wz.brand.website')}
                </label>
                <input
                  id="setup-brand-website"
                  name="websiteUrl"
                  type="url"
                  inputMode="url"
                  maxLength={2048}
                  placeholder={t('setup.brand.websitePlaceholder')}
                  dir="ltr"
                  className="bs-control"
                />
              </div>
              {/*
                D-331 (amends D-277): the AI language starts as the creator's
                interface language. D-335: at least one publishing language,
                and exactly one decides the AI language.
              */}
              <SetupBrandLanguages
                initialDefault={locale === 'ar' ? 'AR' : 'EN'}
                moreLabel={t('setup.wz.more')}
                labels={{
                  defaultLanguage: t('setup.brand.defaultLanguage'),
                  defaultLanguageHint: t('setup.brand.defaultLanguageHint'),
                  languages: t('setup.wz.brand.languages'),
                  localeEn: t('brandProfile.localeEn'),
                  localeAr: t('brandProfile.localeAr'),
                  atLeastOne: t('setup.brand.languagesRequired'),
                }}
              />
              {/*
                D-335 — the activated industry list with "Something else". The
                prototype asks it with the business; a workspace does not store
                it, so it stays with the brand, behind its own disclosure.
              */}
              <details className="bsp-wz-more" data-testid="setup-brand-industry-more">
                <summary>{t('setup.brand.industry')}</summary>
                <IndustryField
                  industries={industries.map((industry) => ({
                    value: industry.key,
                    label: locale === 'ar' ? industry.name.ar : industry.name.en,
                  }))}
                  saved={null}
                  labels={{
                    industry: t('setup.brand.industry'),
                    industryHint: t('setup.optional'),
                    industryNone: t('settings.industryNone'),
                    industryOther: t('settings.industryOther'),
                    industryOtherLabel: t('settings.industryOtherLabel'),
                  }}
                  idPrefix="setup-brand-"
                  testIdPrefix="setup-brand"
                />
              </details>
            </div>
            {/* "Logo and colours" — the prototype's soft panel (`.bsp-wz-look`). */}
            <div className="bsp-wz-look">
              <span className="bsp-wz-lb">{t('setup.wz.brand.logoColours')}</span>
              {/*
                BATCH 7 (A3): the logo's own hint (its formats and size) sits
                under the logo's button, the colours' under the colours field —
                they used to stand together under the colours.
              */}
              {may('assets.upload') ? (
                <LogoPicker
                  initial={workspace.workspaceName.trim().charAt(0).toUpperCase()}
                  now={null}
                  submitOnChoose={false}
                  texts={logoTexts}
                />
              ) : null}
              <div>
                <label className="bsp-wz-lb" htmlFor="setup-brand-colours">
                  {t('setup.brand.colours')}
                </label>
                <input
                  id="setup-brand-colours"
                  name="colorPalette"
                  maxLength={120}
                  dir="ltr"
                  className="bs-control"
                  aria-describedby="setup-brand-colours-hint"
                />
                <span id="setup-brand-colours-hint" className="bsp-wz-hint">
                  {t('setup.brand.coloursHint')}
                </span>
              </div>
            </div>
          </UploadForm>
        </section>
      );
      footer = (
        <SetupFooter
          note={savedNote}
          back={backLink('business')}
          next={
            <button
              type="submit"
              form="setup-brand-form"
              className="bsp-wz-btn bsp-wz-pur"
              data-testid="setup-create-brand"
            >
              {t('setup.continue')}
            </button>
          }
        />
      );
    }
  } else if (brand && (view === 'learn' || view === 'review')) {
    /* ---------------------------------------------------- teach (learn + review) */
    const [sources, candidates] = await Promise.all([
      inBrandBrain(workspace.workspaceId, ({ db }) =>
        db.brandSourceDocument.findMany({
          where: { brandId: brand.id, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, fileName: true, status: true, failureMessage: true },
        }),
      ),
      may('brand_brain.review')
        ? inBrandBrain(workspace.workspaceId, ({ db }) =>
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
        : Promise.resolve([]),
    ]);
    const reading = sources.filter(
      (source) => source.status === 'PROCESSING' || source.status === 'UPLOADED',
    ).length;
    // Batch 7 (A4): "everything has been reviewed" only once a file was READ.
    const read = sources.some((source) => source.status === 'READY');
    const sourceRules = may('brand_brain.upload')
      ? await inBrandBrain(workspace.workspaceId, async (services) =>
          sourceUploadRules((await services.policy()).ingestion),
        )
      : null;
    head = { title: t('setup.wz.teach.title'), description: t('setup.wz.teach.body') };
    body = (
      <section className="bsp-wz-body bsp-wz-scroll" data-testid="setup-learn">
        {/*
          The prototype's two sources: "Read my website" is post-launch
          (D-468 (b)), so the one source is "Upload files" — the Brand Brain's
          own upload, back to this step.
        */}
        <div className="bsp-wz-tiles">
          {sourceRules ? (
            <UploadForm
              action={uploadSourceAction}
              rules={sourceRules}
              locale={locale}
              texts={uploadTexts}
              data-testid="setup-upload-form"
              className="bsp-wz-upform"
            >
              <input type="hidden" name="locale" value={locale} />
              <input type="hidden" name="brandId" value={brand.id} />
              <input type="hidden" name="area" value="" />
              <input type="hidden" name="returnTo" value="/onboarding" />
              <input type="hidden" name="step" value="learn" />
              <SetupUploadTile
                title={t('setup.wz.teach.upload')}
                chooseLabel={t('bb.uploadChoose')}
              />
            </UploadForm>
          ) : (
            note(t('setup.noPermission'), 'setup-no-permission')
          )}
        </div>
        {/*
          BATCH 7 (A4) — EACH FILE ON ITS OWN ROW, WITH ITS REASON. A file that
          could not be read said only "Could not read", run together with the
          others on one line, while the banner pointed to a Sources list the
          wizard does not have. The reason is the same words the Brand Brain's
          Sources use.
        */}
        {sources.length > 0 ? (
          <ul className="bsp-wz-srcs" data-testid="setup-sources">
            {sources.map((source) => (
              <li
                key={source.id}
                className="bsp-wz-src"
                data-status={source.status}
                data-testid={`setup-source-${source.id}`}
              >
                <span className="bsp-wz-src-n" dir="auto">
                  {source.fileName}
                </span>
                <span className="bsp-wz-src-s">
                  {t(`setup.source.${source.status}` as MessageKey)}
                </span>
                {source.status === 'FAILED' ? (
                  <span className="bsp-wz-src-r" data-testid="setup-source-reason">
                    {sourceFailureText(source.failureMessage, t)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <RefreshWhile active={reading > 0} />
        {reading > 0 ? note(t('setup.learn.processing'), 'setup-processing') : null}
        {candidates.length > 0 ? (
          /* "We understood n things · review them", one row per fact (lines 156–168). */
          <div className="bsp-wz-facts" data-testid="setup-review-summary">
            <div className="bsp-wz-facts-h">
              <span>
                {candidates.length === 1
                  ? t('setup.wz.teach.understood.one')
                  : t('setup.wz.teach.understood').replace('{count}', String(candidates.length))}
              </span>
              {/* Round 4 (4.3) — the prototype's "Accept all": each fact's own Accept, in turn. */}
              <form action={acceptAllSetupCandidatesAction}>
                <input type="hidden" name="locale" value={locale} />
                {candidates.map((candidate) => (
                  <input key={candidate.id} type="hidden" name="candidateId" value={candidate.id} />
                ))}
                <button
                  type="submit"
                  className="bsp-wz-btn bsp-wz-pur bsp-wz-all"
                  data-testid="setup-accept-all"
                >
                  {t('setup.wz.teach.acceptAll')}
                </button>
              </form>
            </div>
            {candidates.map((candidate) => {
              const hidden = (decision: string) => (
                <>
                  <input type="hidden" name="locale" value={locale} />
                  <input type="hidden" name="area" value={candidate.area} />
                  <input type="hidden" name="candidateId" value={candidate.id} />
                  <input type="hidden" name="decision" value={decision} />
                </>
              );
              return (
                <div
                  key={candidate.id}
                  className="bsp-wz-fact"
                  data-testid={`setup-candidate-${candidate.id}`}
                >
                  <span className="bsp-pill bsp-p-ai">
                    {t(`bb.area.${areaDefinition(candidate.area).messageKey}` as MessageKey)}
                  </span>
                  {/* One line per fact, as the prototype's: the body adds only what the title does not say. */}
                  <span className="bsp-wz-fact-t" dir="auto">
                    {factLine(
                      pickText(candidate.extractedTitle),
                      pickText(candidate.extractedBody),
                    )}
                  </span>
                  <span className="bsp-wz-fact-c bsp-ltr">
                    {Math.round(candidate.confidenceMilli / 10)}%
                  </span>
                  <form action={reviewSetupCandidateAction}>
                    {hidden('accept')}
                    <button
                      type="submit"
                      className="bsp-wz-btn bsp-wz-sec bsp-wz-xs"
                      data-testid={`setup-accept-${candidate.id}`}
                    >
                      {t('setup.wz.teach.accept')}
                    </button>
                  </form>
                  <form action={reviewSetupCandidateAction}>
                    {hidden('reject')}
                    <button
                      type="submit"
                      className="bsp-wz-btn bsp-wz-ghost bsp-wz-xs"
                      data-testid={`setup-reject-${candidate.id}`}
                    >
                      {t('setup.wz.teach.reject')}
                    </button>
                  </form>
                </div>
              );
            })}
          </div>
        ) : read && reading === 0 ? (
          note(
            t('setup.review.allDone').replace('{count}', String(facts.activeKnowledge)),
            'setup-review-done',
          )
        ) : sources.length > 0 && reading === 0 ? (
          note(t('setup.review.noneRead'), 'setup-none-read')
        ) : (
          <div className="bsp-wz-empty">{t('setup.wz.teach.empty')}</div>
        )}
      </section>
    );
    footer = (
      <SetupFooter
        note={savedNote}
        back={backLink('brand')}
        skip={skipLink('connect')}
        next={continueLink('connect')}
      />
    );
  } else if (brand && view === 'connect') {
    /* ---------------------------------------------------------- accounts */
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
      optionalMessage(messageLocale, `integrations.provider.${provider.toLowerCase()}`) ?? provider;

    head = { title: t('setup.wz.connect.title'), description: t('setup.wz.connect.body') };
    body = (
      <section className="bsp-wz-body bsp-wz-scroll" data-testid="setup-connect">
        {social.providers.length === 0 && social.connections.length === 0 ? (
          note(t('setup.connect.none'), 'setup-connect-none')
        ) : (
          /* One card per channel: mark, name, its state, Connect (lines 171–180). */
          <div className="bsp-wz-accs" data-testid="setup-connections">
            {social.providers.map((provider) => {
              const connection = social.connections.find((entry) => entry.provider === provider);
              const name = providerLabel(provider);
              return (
                <div key={provider} className="bsp-wz-acc">
                  <span className="bsp-wz-acc-mark">
                    <ChannelMark
                      channel={{ key: provider.toLowerCase(), name }}
                      size={20}
                      label={false}
                    />
                  </span>
                  <span className="bsp-wz-acc-copy">
                    <span className="bsp-wz-acc-name bsp-ltr">{name}</span>
                    <span className="bsp-wz-acc-sub">
                      {connection
                        ? connection.status === 'ACTIVE'
                          ? connection.displayName
                          : t('setup.connect.attention')
                        : t('setup.wz.connect.notConnected')}
                    </span>
                  </span>
                  {connection?.status === 'ACTIVE' ? (
                    <span className="bsp-pill bsp-p-ok">{t('setup.connect.connected')}</span>
                  ) : may('integrations.manage') ? (
                    <form action={connectAccountAction}>
                      <input type="hidden" name="locale" value={locale} />
                      <input type="hidden" name="provider" value={provider} />
                      <input type="hidden" name="brandId" value={brand.id} />
                      <input type="hidden" name="returnTo" value="/onboarding" />
                      <button
                        type="submit"
                        className="bsp-wz-btn bsp-wz-ink bsp-wz-sm"
                        data-testid={`setup-connect-${provider.toLowerCase()}`}
                        aria-label={t('setup.connect.provider').replace('{provider}', name)}
                      >
                        {t('setup.wz.connect.connect')}
                      </button>
                    </form>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
        {!may('integrations.manage') ? note(t('setup.noPermission'), 'setup-no-permission') : null}
      </section>
    );
    footer = (
      <SetupFooter
        note={savedNote}
        back={backLink('learn')}
        skip={skipLink('goal')}
        next={continueLink('goal')}
      />
    );
  } else if (brand && view === 'goal') {
    /* ------------------------------------------------------------- goal */
    const chosen = facts.goal?.objective ?? null;
    head = { title: t('setup.wz.goal.title'), description: t('setup.wz.goal.body') };
    body = (
      <section className="bsp-wz-body bsp-wz-scroll" data-testid="setup-goal">
        {may('brand_brain.edit') ? (
          <form id="setup-goal-form" action={saveFirstGoalAction} data-testid="setup-goal-form">
            <input type="hidden" name="locale" value={locale} />
            <input type="hidden" name="brandId" value={brand.id} />
            {/* D-468 — the prototype's goal chips: three columns of choices (line 183). */}
            <fieldset className="bsp-wz-goals">
              <legend className="bs-sr-only">{t('setup.wz.goal.title')}</legend>
              {[...SETUP_GOALS, 'unsure' as const].map((goal) => (
                <label key={goal} className="bsp-wz-chip">
                  <input
                    type="radio"
                    name="goal"
                    value={goal}
                    required
                    defaultChecked={goal === chosen}
                    className="bsp-wz-radio"
                    data-testid={`setup-goal-${goal.toLowerCase()}`}
                  />
                  {t(`setup.goal.${goal}` as MessageKey)}
                </label>
              ))}
            </fieldset>
          </form>
        ) : (
          note(t('setup.noPermission'), 'setup-no-permission')
        )}
      </section>
    );
    footer = (
      <SetupFooter
        note={savedNote}
        back={backLink('connect')}
        skip={skipLink('done')}
        next={
          may('brand_brain.edit') ? (
            <button
              type="submit"
              form="setup-goal-form"
              className="bsp-wz-btn bsp-wz-pur"
              data-testid="setup-goal-submit"
            >
              {t('setup.continue')}
            </button>
          ) : null
        }
      />
    );
  } else if (brand) {
    /* ------------------------------------------------------------ ready */
    const recommended = recommendedFirstAction(facts);
    const goalLabel = facts.goal?.objective
      ? t(`setup.goal.${facts.goal.objective}` as MessageKey)
      : null;
    /*
     * THE FIRST IDEAS (line 189): the product's own next steps, not invented
     * posts — writing for the goal just chosen, a first post, and a plan with
     * the Copilot — each only where this member may take it.
     */
    const ideas = [
      goalLabel && may('content.create')
        ? {
            key: 'goal',
            title: t('create.idea.goalTitle').replace('{goal}', goalLabel),
            meta: t('create.idea.goalReason'),
            href: `/${locale}/content/compose?${new URLSearchParams({
              mode: 'ai',
              brief: t('create.idea.goalBrief').replace('{goal}', goalLabel),
            }).toString()}`,
            testId: 'setup-idea-goal',
          }
        : null,
      may('content.create')
        ? {
            key: 'create',
            title: t('setup.done.create'),
            meta: t('setup.done.whyCreate'),
            href: `/${locale}/content/compose`,
            testId: 'setup-create-post',
          }
        : null,
      may('copilot.use')
        ? {
            key: 'plan',
            title: t('setup.done.plan'),
            meta: t('setup.done.whyPlan'),
            href: copilotHref(locale, 'campaigns'),
            testId: 'setup-plan',
          }
        : null,
    ].filter((idea): idea is NonNullable<typeof idea> => idea !== null);
    // The recommended first move (with approved knowledge, a plan) leads.
    if (recommended === 'plan') {
      const plan = ideas.findIndex((idea) => idea.key === 'plan');
      if (plan > 0) ideas.unshift(...ideas.splice(plan, 1));
    }
    head = {
      title: t('setup.wz.ready.title').replace('{brand}', brand.name),
      description: t('setup.wz.ready.body'),
    };
    body = (
      <section className="bsp-wz-body bsp-wz-scroll" data-testid="setup-done">
        <div className="bsp-wz-sum">
          <div>
            <b className="bsp-ltr">{facts.activeKnowledge}</b>
            <span>{t('setup.wz.ready.facts')}</span>
          </div>
          <div>
            <b className="bsp-ltr">{facts.activeConnections}</b>
            <span>{t('setup.wz.ready.accounts')}</span>
          </div>
          <div>
            <b>{goalLabel ?? t('setup.done.noGoal')}</b>
            <span>{t('setup.wz.ready.goal')}</span>
          </div>
        </div>
        {ideas.length > 0 ? (
          <>
            <span className="bsp-wz-sub">{t('setup.wz.ready.ideas')}</span>
            {ideas.map((idea, index) => (
              <div key={idea.key} className="bsp-wz-idea">
                <span className="bsp-wz-idea-art" data-seed={index % 3} aria-hidden="true" />
                <span className="bsp-wz-idea-copy">
                  <b>{idea.title}</b>
                  <span>{idea.meta}</span>
                </span>
                <Link
                  href={idea.href}
                  className="bsp-wz-btn bsp-wz-pur bsp-wz-sm"
                  data-testid={idea.testId}
                >
                  {t('setup.wz.ready.make')}
                </Link>
              </div>
            ))}
          </>
        ) : null}
      </section>
    );
    footer = (
      <SetupFooter
        note={savedNote}
        back={backLink('goal')}
        next={
          <Link
            href={`/${locale}/overview`}
            className="bsp-wz-btn bsp-wz-ink"
            data-testid="setup-home"
          >
            {t('setup.done.home')}
          </Link>
        }
      />
    );
  }

  /*
   * THE PROTOTYPE'S FIVE STEPS (`Auth.dc.html` line 242): Business · Brand ·
   * Teach · Accounts · Goal. Business is the workspace; Teach is the product's
   * learning and reviewing, in one step. Every state is still derived from real
   * rows; nothing saved changes.
   */
  const stepOf = (key: string) => steps.find((step) => step.key === key);
  const teachDone = Boolean(stepOf('learn')?.complete && stepOf('review')?.complete);
  const frameSteps = [
    {
      key: 'workspace',
      label: stepLabel('workspace'),
      complete: true,
      current: view === 'business',
      href: href('business'),
    },
    {
      key: 'brand',
      label: stepLabel('brand'),
      complete: Boolean(stepOf('brand')?.complete),
      current: view === 'brand',
      href: href('brand'),
    },
    {
      key: 'teach',
      label: t('setup.step.teach'),
      complete: teachDone,
      current: view === 'learn' || view === 'review',
      href: brand !== null ? href('learn') : null,
    },
    {
      key: 'connect',
      label: stepLabel('connect'),
      complete: Boolean(stepOf('connect')?.complete),
      current: view === 'connect',
      href: brand !== null ? href('connect') : null,
    },
    {
      key: 'goal',
      label: stepLabel('goal'),
      complete: Boolean(stepOf('goal')?.complete),
      current: view === 'goal',
      href: brand !== null ? href('goal') : null,
    },
  ];
  const at = frameSteps.findIndex((step) => step.current);

  return (
    <SetupFrame
      locale={locale}
      languageHref={`/${locale === 'ar' ? 'en' : 'ar'}/onboarding${view === 'done' ? '' : `?step=${view}`}`}
      stepsLabel={t('setup.stepsLabel')}
      doneLabel={t('setup.stepDone')}
      steps={frameSteps}
      stepText={at >= 0 ? t('setup.wz.stepOf').replace('{n}', String(at + 1)) : undefined}
      heading={head.title}
      description={head.description}
      testId="setup-wizard"
      view={view}
      footer={footer}
    >
      {successText ? <CustomerBanner tone="success">{successText}</CustomerBanner> : null}
      {errorText ? <CustomerBanner tone="error">{errorText}</CustomerBanner> : null}
      {body}
    </SetupFrame>
  );
}

/** A reviewed fact on one line: its title, and its body only where it adds to it. */
function factLine(title: string, body: string): string {
  if (!title) return body;
  if (!body || body === title || body.startsWith(title)) return body || title;
  return `${title} — ${body}`;
}
