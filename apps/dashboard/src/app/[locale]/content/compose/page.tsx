import { notFound } from 'next/navigation';
import { CONTENT_TOOLS } from '@brandspace/content';
import { brandScopeFilter } from '@brandspace/shared';
import '@brandspace/ui/content-studio.css';
import { inWorkspace, requireWorkspace } from '../../../../server/customer-context';
import { brandContextFor, defaultBrandFor } from '../../../../server/brand-context';
import { inContentStudio } from '../../../../server/content-context';
import { listMediaOptions } from '../../../../server/media-picker';
import { statusMessage, translator, type MessageKey } from '../../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../../components/workspace-shell';
import {
  cancelReviewAction,
  setContentCampaignAction,
  saveVariantAction,
  submitForReviewAction,
  transitionItemAction,
} from '../actions';
import {
  ComposerView,
  type ComposerDraft,
  type ComposerPlatform,
  type ContentLocale,
} from './composer-view';

export const dynamic = 'force-dynamic';

/**
 * The AI Content Studio composer — Phase 5 scope item 3.
 *
 * A DEMO PORT (`composer()` in `demo/app-2.js`); the client island is the port
 * and this reads under RLS.
 *
 * EVERY CHANNEL, LIMIT AND CEILING ON THIS SCREEN COMES FROM VERSIONED
 * CONFIGURATION. The demo hard-codes four channels and the Phase 5A dashboard
 * hard-coded its Brand Brain numbers; neither happens here. The list of
 * channels, each channel's character limit, the fan-out ceiling and the brief
 * length arrive through `entitlement_catalogue_snapshot`, so an owner who adds
 * a channel in Platform Admin adds it to this screen (CLAUDE.md §2.2).
 */
const CONTENT_TYPES = ['POST', 'CAROUSEL', 'STORY', 'REEL', 'VIDEO', 'ARTICLE', 'THREAD'] as const;

export default async function ComposePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const translate = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'content.read');

  const single = (key: string): string | undefined => {
    const value = query[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  };

  const itemId = single('item');

  const brands = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: {
        deletedAt: null,
        status: { in: ['ACTIVE', 'DRAFT'] },
        ...brandScopeFilter(workspace.brandScope),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    }),
  );

  const { policy, draft, openApprovalId, campaigns } = await inContentStudio(
    workspace.workspaceId,
    async (services) => {
      const resolved = await services.policy();
      /*
       * A DRAFT THE MEMBER MAY NOT SEE IS A 404, shaped exactly like one that
       * never existed. RLS has already made another tenant's draft invisible;
       * this keeps a brand outside the member's scope from being a tell
       * (docs/SECURITY.md §4.2).
       */
      if (itemId === undefined) {
        return {
          policy: resolved,
          draft: null,
          openApprovalId: null as string | null,
          campaigns: [] as readonly { id: string; name: string }[],
        };
      }
      const item = await (
        await services.library()
      )
        .getItem(itemId, workspace.brandScope)
        .catch(() => null);
      if (!item) {
        return { policy: resolved, draft: null as null, openApprovalId: null, campaigns: [] };
      }
      // Phase 5B-3 — the open cycle, so the composer can offer "withdraw" only
      // when there is in fact something to withdraw.
      const open = await (await services.approvals()).openForItem(item.id);
      /*
       * THE CAMPAIGNS THIS DRAFT COULD BE FILED UNDER — this brand's, and only
       * ones this member may act on. Narrowed HERE rather than in the browser,
       * so another brand's campaign is never sent to the page at all.
       */
      const campaigns = await services.campaigns().list({
        brandId: item.brandId,
        brandScope: workspace.brandScope,
        take: 100,
      });
      return {
        policy: resolved,
        draft: item,
        openApprovalId: open?.id ?? null,
        campaigns: campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name })),
      };
    },
  );

  if (itemId !== undefined && draft === null) notFound();

  const platforms: ComposerPlatform[] = policy.platforms.map((platform) => ({
    key: platform.key,
    // The CONFIGURED label key, translated. The demo writes "◎ Instagram"
    // inline; an operator who adds a channel supplies its key, and an
    // untranslated key falls back to the key itself rather than to an
    // empty button.
    label: translateOptional(translate, platform.labelKey) ?? platform.key,
    maxBodyChars: platform.maxBodyChars,
    maxHashtags: platform.maxHashtags,
    maxMediaItems: platform.maxMediaItems,
  }));

  const composerDraft: ComposerDraft | null = draft
    ? {
        id: draft.id,
        title: draft.title,
        status: draft.status as ComposerDraft['status'],
        openApprovalId,
        brandId: draft.brandId,
        campaignId: draft.campaignId,
        arabicDialect: draft.arabicDialect,
        insufficientKnowledge: draft.insufficientKnowledge,
        /*
         * THE CITATION'S LABEL AND NOTHING ELSE.
         *
         * A citation carries the id of the knowledge item or chunk it came
         * from. The label is what a person reads; the id is a handle into
         * another module's rows and has no business in a browser bundle.
         */
        citations: citationLabels(draft.citations),
        variants: draft.variants.map((variant) => ({
          id: variant.id,
          platformKey: variant.platformKey,
          locale: variant.locale as ContentLocale,
          body: variant.body ?? '',
          hashtags: variant.hashtags,
          characterCount: variant.characterCount,
          validationState: variant.validationState as 'VALID' | 'WARNINGS' | 'INVALID',
          assetIds: variant.assetIds,
        })),
      }
    : null;

  /*
   * PHASE 8 — THE MEDIA THIS DRAFT'S BRAND MAY USE (AC-27.2).
   *
   * Loaded only for an EXISTING draft, because media attaches to a variant and
   * there are no variants until the draft exists. Narrowed server-side to the
   * brand plus the workspace-shared shelf, so an option the member may not use
   * is never sent to the page — and re-resolved on save regardless.
   */
  const mediaOptions = composerDraft
    ? await listMediaOptions({
        workspaceId: workspace.workspaceId,
        brandId: composerDraft.brandId,
        userId: customer.userId,
        permissionKeys: workspace.permissionKeys,
        brandScope: workspace.brandScope,
      })
    : [];

  const ok = single('ok') ?? null;
  const error = single('error') ?? null;
  const reference = single('ref');
  const successText = ok ? statusMessage(ok, locale) : null;
  const errorText = error ? statusMessage(error, locale, reference) : null;

  const brandContext = await brandContextFor(workspace, '/content');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={translate('content.composer.title')}
      description={translate('content.subtitle')}
      activePath="/content"
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.name ?? customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {successText ? <CustomerBanner tone="success">{successText}</CustomerBanner> : null}
      {errorText ? <CustomerBanner tone="error">{errorText}</CustomerBanner> : null}
      <ComposerView
        locale={locale}
        t={dictionaryFor(translate)}
        brands={brands}
        defaultBrandId={defaultBrandFor(brandContext)}
        platforms={platforms}
        contentTypes={CONTENT_TYPES}
        maxBriefChars={policy.generation.maxBriefChars}
        maxVariants={policy.generation.maxVariantsPerRequest}
        draft={composerDraft}
        campaigns={campaigns}
        mediaOptions={mediaOptions}
        tools={CONTENT_TOOLS}
        can={{
          create: workspace.permissionKeys.includes('content.create'),
          edit: workspace.permissionKeys.includes('content.edit'),
          submit: workspace.permissionKeys.includes('content.submit'),
          archive: workspace.permissionKeys.includes('content.archive'),
          manageCampaigns: workspace.permissionKeys.includes('campaigns.manage'),
        }}
        actions={{
          save: saveVariantAction,
          transition: transitionItemAction,
          submitForReview: submitForReviewAction,
          cancelReview: cancelReviewAction,
          setCampaign: setContentCampaignAction,
        }}
      />
    </WorkspaceShell>
  );
}

/**
 * The labels retrieval recorded on the draft.
 *
 * `citations` is a Json column, so its runtime shape is whatever was written —
 * this narrows it rather than asserting it, and an unrecognisable entry is
 * dropped instead of rendering `[object Object]`.
 */
function citationLabels(raw: unknown): { label: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const label = (entry as Record<string, unknown>)['label'];
    return typeof label === 'string' && label.trim() !== '' ? [{ label }] : [];
  });
}

/** A configured label key that this build has no translation for. */
function translateOptional(
  translate: (key: MessageKey) => string,
  key: string,
): string | undefined {
  const value = translate(key as MessageKey) as string | undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const COMPOSER_KEYS = [
  // Phase 8 — the campaign control on an existing draft (AC-26.3).
  'campaigns.composerLabel',
  'campaigns.composerNone',
  'content.composer.eyebrow',
  'content.composer.title',
  'content.composer.back',
  'content.composer.brand',
  'content.composer.channels',
  'content.composer.channelsHint',
  'content.composer.brief',
  'content.composer.briefPlaceholder',
  'content.composer.language',
  'content.composer.contentType',
  'content.composer.estimate',
  'content.composer.generate',
  'content.composer.generating',
  'content.composer.quoteLabel',
  'content.composer.quoteUnit',
  'content.composer.quoteHint',
  'content.composer.results',
  'content.composer.resultsEmpty',
  'content.composer.dialect',
  'content.composer.characters',
  'content.composer.of',
  'content.composer.hashtags',
  'content.composer.sources',
  'content.composer.saveEdit',
  'content.composer.submit',
  'content.composer.archive',
  'content.composer.restore',
  'content.tool.rewrite',
  'content.tool.shorten',
  'content.tool.expand',
  'content.tool.tone',
  'content.tool.translate',
  'content.tool.toneArgument',
  'content.tool.running',
  'content.insufficient',
  'content.insufficientBody',
  'content.validation.VALID',
  'content.validation.WARNINGS',
  'content.validation.INVALID',
  'content.dialect.msa',
  'content.dialect.gulf',
  'content.dialect.egyptian',
  'content.dialect.levantine',
  'content.language.AR',
  'content.language.EN',
  'content.type.POST',
  'content.type.CAROUSEL',
  'content.type.STORY',
  'content.type.REEL',
  'content.type.VIDEO',
  'content.type.ARTICLE',
  'content.type.THREAD',
  'content.error.generic',
  'content.error.quota',
  'content.error.invalid',
  'content.error.notFound',
  'content.noBrand',
  'content.noBrandBody',
  'content.noBrandAction',
] as const satisfies readonly MessageKey[];

function dictionaryFor(translate: (key: MessageKey) => string): Record<string, string> {
  return Object.fromEntries(COMPOSER_KEYS.map((key) => [key, translate(key)]));
}
