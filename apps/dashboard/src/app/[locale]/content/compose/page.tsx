import type React from 'react';
import { notFound } from 'next/navigation';
import { CONTENT_TOOLS, READ_ONLY_CONTENT_STATUSES } from '@brandspace/content';
import { CREATIVE_FORMATS } from '@brandspace/creative';
import { brandIdQueryFilter, brandScopeFilter, systemClock } from '@brandspace/shared';
import '@brandspace/ui/content-studio.css';
import { inWorkspace, requireWorkspace } from '../../../../server/customer-context';
import { decidePreferenceAction } from '../../overview/actions';
import { brandContextFor, defaultBrandFor } from '../../../../server/brand-context';
import { inContentStudio } from '../../../../server/content-context';
import { listMediaOptions, mediaForVariants } from '../../../../server/media-picker';
import {
  optionalMessage,
  statusMessage,
  translator,
  type MessageKey,
} from '../../../../i18n/messages';
import {
  CustomerBanner,
  CustomerCard,
  WorkspaceShell,
} from '../../../../components/workspace-shell';
import { ActivityTimeline } from '../../../../components/activity-timeline';
import { activityTimeline } from '../../../../server/activity-timeline';
import { NotesPanel } from '../../../../components/notes-panel';
import { inSocial } from '../../../../server/social-context';
import { relativeTime } from '../../../../server/home';
import {
  POST_GOALS,
  createModeFrom,
  goalForObjective,
  platformsByFormat,
  repurposeBrief,
} from '../../../../server/create-post';
import { GOAL_ITEM_KEY, goalFromTitle, goalLabels } from '../../../../server/setup-wizard-state';
import { CreateEntry, IdeaPicker, RepurposePicker, type IdeaOption } from './create-entry';
import { CONTENT_TYPES } from '../content-types';
import {
  cancelReviewAction,
  createManualDraftAction,
  duplicateContentAction,
  listCampaignOptionsAction,
  setContentCampaignAction,
  uploadComposerMediaAction,
  saveVariantAction,
  submitForReviewAction,
  resubmitAfterChangesAction,
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
  /*
   * HOW THE PERSON IS STARTING (D-277 §17, D-283). Without a draft and without
   * a mode the page asks first; `?mode=` makes the choice an address. What the
   * reader arrived with — a campaign — travels with every choice.
   */
  const mode = itemId ? null : createModeFrom(single('mode'));
  const tk = (key: string): string => optionalMessage(locale, key) ?? key;
  const carry: Record<string, string> = Object.fromEntries(
    Object.entries({ campaign: single('campaign') }).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );

  const brands = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: {
        deletedAt: null,
        status: { in: ['ACTIVE', 'DRAFT'] },
        ...brandScopeFilter(workspace.brandScope),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, defaultLocale: true },
    }),
  );

  const brandContext = await brandContextFor(workspace, '/content');
  /*
   * THE BRAND A NEW POST WOULD BE WRITTEN FOR, when there is exactly one
   * answer (PHASE 2 correction). Null means the rail is on "All brands" with
   * several to choose from, and the composer shows its own brand select in
   * that case — so there is no single brand to read a campaign list for, and
   * the pre-draft campaign control is correctly not offered.
   */
  const composingBrandId = defaultBrandFor(brandContext);

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
        /*
         * A POST CAN BE FILED UNDER A CAMPAIGN WHEN IT IS WRITTEN, not only
         * afterwards (PHASE 2 correction).
         *
         * This branch returned an empty list, so the composer had no campaign
         * options before a draft existed and the manual create — which accepts
         * a `campaignId` and validates it against the brand — was never given
         * one. Filing happened on the second screen at the earliest.
         *
         * Narrowed to the brand being composed for and to the member's
         * BrandScope by the service, exactly as the existing-draft branch
         * below: another brand's campaign is never sent to the page at all.
         * With no single brand resolved there is nothing to narrow to, and the
         * list stays empty.
         */
        const options =
          composingBrandId === null || !workspace.permissionKeys.includes('campaigns.manage')
            ? []
            : await services.campaigns().list({
                brandId: composingBrandId,
                brandScope: workspace.brandScope,
                take: 100,
              });
        return {
          policy: resolved,
          draft: null,
          openApprovalId: null as string | null,
          campaigns: options.map((campaign) => ({ id: campaign.id, name: campaign.name })),
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
      const campaignService = services.campaigns();
      const live = await campaignService.list({
        brandId: item.brandId,
        brandScope: workspace.brandScope,
        take: 100,
      });
      /*
       * THE DRAFT'S OWN CAMPAIGN IS ALWAYS AN OPTION, even once it is archived
       * (PHASE 2).
       *
       * `list` excludes archived campaigns, which is right for CHOOSING one.
       * But the control is rendered as `defaultValue={draft.campaignId}` over
       * these options, so a draft whose campaign had since been archived had no
       * matching option — the browser fell back to the first, the screen said
       * "No campaign", and that was false. Worse, saving the form then posted
       * an empty value and DETACHED the draft from a campaign nobody had asked
       * to leave, destroying a relationship silently.
       *
       * Adding the current one back makes the screen tell the truth. It is not
       * a way to file new work into an archived campaign: `setContentCampaign`
       * still refuses any id that is not live, and re-sending the unchanged one
       * is a no-op there.
       */
      const archivedCurrent =
        item.campaignId && !live.some((campaign) => campaign.id === item.campaignId)
          ? (
              await campaignService.list({
                brandId: item.brandId,
                brandScope: workspace.brandScope,
                includeArchived: true,
                take: 200,
              })
            ).find((campaign) => campaign.id === item.campaignId)
          : undefined;
      const campaigns = archivedCurrent ? [...live, archivedCurrent] : live;
      return {
        policy: resolved,
        draft: item,
        openApprovalId: open?.id ?? null,
        campaigns: campaigns.map((campaign) => ({ id: campaign.id, name: campaign.name })),
      };
    },
  );

  if (itemId !== undefined && draft === null) notFound();

  /*
   * PHASE 6 FINAL (D-277 §29, D-288) — THE REVIEW FACTS THE EDITOR NEEDS.
   *
   * Whether this brand's policy requires approval before scheduling (which
   * decides the primary next step), and — when the post came back with
   * changes requested — the reviewer's reason and the thread the decision
   * opened, derived from the approval record and the note it wrote (the
   * reviewer's own words, on this post, after the decision). Nothing stored.
   */
  const reviewFacts = draft
    ? await inContentStudio(workspace.workspaceId, async (services) => {
        const approvals = await services.approvals();
        const brandPolicy = await approvals.policyForBrand(draft.brandId);
        if (draft.status !== 'CHANGES_REQUESTED') {
          return { requiresApproval: brandPolicy.requireApprovalBeforeScheduling, changes: null };
        }
        const last = await services.db.approval.findFirst({
          where: { contentItemId: draft.id, status: 'CHANGES_REQUESTED' },
          orderBy: { decidedAt: 'desc' },
          select: { decisionNote: true, decidedByUserId: true, decidedAt: true },
        });
        if (!last) {
          return { requiresApproval: brandPolicy.requireApprovalBeforeScheduling, changes: null };
        }
        const [reviewer, threads] = await Promise.all([
          last.decidedByUserId
            ? services.db.membership.findFirst({
                where: { userId: last.decidedByUserId },
                select: { user: { select: { name: true, email: true } } },
              })
            : Promise.resolve(null),
          last.decidedByUserId && last.decisionNote
            ? services.db.noteThread.findMany({
                where: {
                  contentItemId: draft.id,
                  status: 'OPEN',
                  ...(last.decidedAt ? { createdAt: { gte: last.decidedAt } } : {}),
                  notes: {
                    some: { authorUserId: last.decidedByUserId, body: last.decisionNote },
                  },
                },
                select: { id: true },
                take: 5,
              })
            : Promise.resolve([] as { id: string }[]),
        ]);
        return {
          requiresApproval: brandPolicy.requireApprovalBeforeScheduling,
          changes: {
            note: last.decisionNote,
            reviewer: reviewer ? (reviewer.user.name ?? reviewer.user.email) : null,
            threadIds: threads.map((thread) => thread.id),
          },
        };
      })
    : null;

  const shell = (children: React.ReactNode) => (
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
      {children}
    </WorkspaceShell>
  );

  /* ------------------------------------------------ §17 — the entry */
  if (!itemId && mode === null) {
    return shell(<CreateEntry locale={locale} t={tk} carry={carry} />);
  }

  const scope = brandIdQueryFilter({
    brandId: composingBrandId ?? undefined,
    brandScope: workspace.brandScope,
  });
  const now = systemClock.now();

  /* ---------------------------------------- §17 — start from an idea */
  if (mode === 'idea') {
    const aiHref = (params: Record<string, string>) =>
      `/${locale}/content/compose?${new URLSearchParams({ ...carry, mode: 'ai', ...params }).toString()}`;
    const found = await inWorkspace(workspace.workspaceId, async ({ db }) => {
      const [goal, pillars, empty, gaps] = await Promise.all([
        composingBrandId
          ? db.brandKnowledgeItem.findFirst({
              where: {
                brandId: composingBrandId,
                area: 'STRATEGY',
                itemKey: GOAL_ITEM_KEY,
                status: { in: ['ACTIVE', 'STALE'] },
              },
              select: { title: true },
            })
          : Promise.resolve(null),
        db.brandKnowledgeItem.findMany({
          where: {
            area: 'STRATEGY',
            status: 'ACTIVE',
            NOT: { itemKey: { startsWith: 'goal.' } },
            ...scope,
          },
          select: { id: true, title: true },
          take: 3,
        }),
        workspace.permissionKeys.includes('campaigns.read')
          ? db.campaign.findMany({
              where: {
                deletedAt: null,
                status: { in: ['DRAFT', 'PLANNED', 'ACTIVE'] },
                contentItems: { none: { deletedAt: null } },
                ...scope,
              },
              select: { id: true, name: true },
              orderBy: { updatedAt: 'desc' },
              take: 3,
            })
          : Promise.resolve([] as { id: string; name: string }[]),
        workspace.permissionKeys.includes('strategy.read')
          ? db.insight.findMany({
              where: {
                type: 'CONTENT_GAP',
                status: { in: ['NEW', 'SEEN'] },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                ...scope,
              },
              select: { id: true, title: true },
              take: 2,
            })
          : Promise.resolve([] as { id: string; title: unknown }[]),
      ]);
      return { goal, pillars, empty, gaps };
    });
    const pick = (value: unknown) => {
      const text = value as { en?: string; ar?: string } | null;
      return (locale === 'ar' ? (text?.ar ?? text?.en) : (text?.en ?? text?.ar)) ?? '';
    };
    const ideas: IdeaOption[] = [];
    // The stored title is the objective's ENGLISH label (D-278), whatever the
    // reader's interface language.
    const goal = goalForObjective(
      goalFromTitle((found.goal?.title as { en?: string } | null)?.en, goalLabels('en')),
    );
    if (found.goal) {
      const label = pick(found.goal.title);
      ideas.push({
        key: 'goal',
        title: translate('create.idea.goalTitle').replace('{goal}', label),
        reason: translate('create.idea.goalReason'),
        href: aiHref({
          brief: translate('create.idea.goalBrief').replace('{goal}', label),
          ...(goal ? { goal } : {}),
        }),
      });
    }
    for (const pillar of found.pillars) {
      const label = pick(pillar.title);
      ideas.push({
        key: `pillar-${pillar.id}`,
        title: translate('create.idea.pillarTitle').replace('{pillar}', label),
        reason: translate('create.idea.pillarReason'),
        href: aiHref({ brief: translate('create.idea.pillarBrief').replace('{pillar}', label) }),
      });
    }
    for (const row of found.empty) {
      ideas.push({
        key: `campaign-${row.id}`,
        title: translate('create.idea.campaignTitle').replace('{campaign}', row.name),
        reason: translate('create.idea.campaignReason'),
        href: aiHref({
          campaign: row.id,
          brief: translate('create.idea.campaignBrief').replace('{campaign}', row.name),
        }),
      });
    }
    for (const row of found.gaps) {
      const label = pick(row.title);
      if (!label) continue;
      ideas.push({
        key: `gap-${row.id}`,
        title: label,
        reason: translate('create.idea.gapReason'),
        href: aiHref({ brief: label }),
      });
    }
    return shell(<IdeaPicker locale={locale} t={tk} ideas={ideas} />);
  }

  /* -------------------------------------------------- §17 — repurpose */
  if (mode === 'repurpose') {
    const search = single('q') ?? '';
    const options = await inContentStudio(workspace.workspaceId, async (services) =>
      (await services.library()).listItems({
        ...(composingBrandId ? { brandId: composingBrandId } : {}),
        brandScope: workspace.brandScope,
        ...(search ? { search } : {}),
        limit: 30,
      }),
    );
    return shell(
      <RepurposePicker
        locale={locale}
        t={tk}
        search={search}
        carry={carry}
        options={options
          .filter((item) => item.status !== 'ARCHIVED')
          .map((item) => ({
            id: item.id,
            title: item.title,
            status: item.status,
            contentType: item.contentType,
            updatedLabel: relativeTime(item.updatedAt, now, locale),
          }))}
      />,
    );
  }

  /*
   * §17 — REPURPOSE, CONTINUED: the chosen post's own words become explicit,
   * bounded source material in the brief. Read under the member's BrandScope;
   * a post they cannot open is simply not a source.
   */
  const sourceId = !itemId ? single('source') : undefined;
  const source = sourceId
    ? await inContentStudio(workspace.workspaceId, async (services) =>
        (await services.library()).getItem(sourceId, workspace.brandScope).catch(() => null),
      )
    : null;
  const sourceBody = source
    ? ((
        source.variants.find((variant) => variant.locale === source.primaryLocale) ??
        source.variants[0]
      )?.body ?? '')
    : '';
  const initialBrief = source
    ? repurposeBrief(
        translate('create.repurpose.brief'),
        { title: source.title, body: sourceBody },
        policy.generation.maxBriefChars,
      )
    : (single('brief') ?? '').slice(0, policy.generation.maxBriefChars);

  /* §19 — the campaign the reader came from, if it is one they may file under. */
  const requestedCampaign = single('campaign');
  const initialCampaignId =
    requestedCampaign && campaigns.some((campaign) => campaign.id === requestedCampaign)
      ? requestedCampaign
      : '';

  /* §19 — the recommended goal, from the brand's own first goal (D-278). */
  const recommendedGoal = composingBrandId
    ? await inWorkspace(workspace.workspaceId, async ({ db }) => {
        const row = await db.brandKnowledgeItem.findFirst({
          where: {
            brandId: composingBrandId,
            area: 'STRATEGY',
            itemKey: GOAL_ITEM_KEY,
            status: { in: ['ACTIVE', 'STALE'] },
          },
          select: { title: true },
        });
        const title = (row?.title as { en?: string } | null)?.en;
        return goalForObjective(goalFromTitle(title, goalLabels('en')));
      })
    : null;
  /*
   * D-295 — this member's ACCEPTED defaults for the brand, shown where they
   * take effect, each with "Stop using". They reach the generator from the
   * service itself (closed-key instructions); this is only the telling.
   */
  const authorDefaults = composingBrandId
    ? (
        await inContentStudio(workspace.workspaceId, async ({ suggestions }) =>
          (await suggestions()).acceptedPreferences({
            userId: customer.userId,
            brandId: composingBrandId,
          }),
        )
      ).flatMap((key) => {
        const shorter = /^shorter:([a-z0-9_-]+)$/.exec(key);
        const tone = /^tone:(friendly|professional):([a-z0-9_-]+)$/.exec(key);
        const platform = (value: string) =>
          optionalMessage(locale, `content.platform.${value}`) ?? value;
        if (shorter) {
          return [
            {
              key,
              label: translate('create.defaults.shorter').replace(
                '{platform}',
                platform(shorter[1]!),
              ),
            },
          ];
        }
        if (tone) {
          return [
            {
              key,
              label: translate('create.defaults.tone')
                .replace('{platform}', platform(tone[2]!))
                .replace('{tone}', translate(`home.preference.tone.${tone[1]}` as MessageKey)),
            },
          ];
        }
        return [];
      })
    : [];
  const requestedGoal = single('goal');
  const initialGoal = POST_GOALS.includes(requestedGoal as never) ? (requestedGoal as string) : '';

  /* §18 — which formats each platform can carry, from the capability registry. */
  const formatPlatforms = await inSocial(workspace.workspaceId, async (services) => {
    const publishing = await services.policy();
    return platformsByFormat(
      CONTENT_TYPES,
      policy.platforms.map((platform) => platform.key),
      publishing.providers as unknown as Record<
        string,
        { enabled: boolean; postKinds: readonly string[] }
      >,
    );
  }).catch(() => ({ POST: policy.platforms.map((platform) => platform.key) }));

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
    allowsFirstComment: platform.allowsFirstComment,
  }));

  const composerDraft: ComposerDraft | null = draft
    ? {
        id: draft.id,
        title: draft.title,
        status: draft.status as ComposerDraft['status'],
        readOnly: READ_ONLY_CONTENT_STATUSES.includes(draft.status),
        openApprovalId,
        brandId: draft.brandId,
        contentType: draft.contentType,
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
          firstComment: variant.firstComment,
          coverAssetId: variant.coverAssetId,
          updatedAt: variant.updatedAt.toISOString(),
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
  const offered = composerDraft
    ? await listMediaOptions({
        workspaceId: workspace.workspaceId,
        brandId: composerDraft.brandId,
        userId: customer.userId,
        permissionKeys: workspace.permissionKeys,
        brandScope: workspace.brandScope,
      })
    : [];
  /*
   * PHASE 6 FINAL — WHAT IS ALREADY ATTACHED IS ALWAYS DRAWABLE. The offer is
   * the most recent library page; a slide or cover older than that page must
   * still preview, so the attached ids are resolved on their own (same
   * library, same grant, same READY/CLEAN rule) and joined in.
   */
  const attachedIds = composerDraft
    ? composerDraft.variants.flatMap((variant) => [
        ...variant.assetIds,
        ...(variant.coverAssetId ? [variant.coverAssetId] : []),
      ])
    : [];
  const attached = await mediaForVariants({
    workspaceId: workspace.workspaceId,
    userId: customer.userId,
    permissionKeys: workspace.permissionKeys,
    brandScope: workspace.brandScope,
    assetIds: attachedIds.filter((id) => !offered.some((option) => option.id === id)),
  });
  const mediaOptions = [...offered, ...attached.values()];

  /*
   * PHASE 6 FINAL (D-285) — AN IMAGE CARRIED FROM THE CREATIVE STUDIO.
   *
   * `?asset=` before a draft exists, `?attach=` once it does. Offered only when
   * it is READY, CLEAN, not deleted and this brand's own or shared — checked
   * here under RLS and the member's BrandScope — and even then only put on the
   * slides UNSAVED: the ordinary save re-resolves it like any other media.
   */
  const carriedId = itemId ? single('attach') : single('asset');
  const carriedBrand = composerDraft?.brandId ?? composingBrandId;
  const carried =
    carriedId && carriedBrand && /^[0-9a-f-]{36}$/i.test(carriedId)
      ? await (async () => {
          const admissible = await inWorkspace(workspace.workspaceId, async ({ db }) =>
            db.asset.findFirst({
              where: {
                id: carriedId,
                deletedAt: null,
                status: 'READY',
                scanStatus: 'CLEAN',
                OR: [{ brandId: null }, { brandId: carriedBrand }],
              },
              select: { id: true },
            }),
          );
          if (!admissible) return null;
          const found = await mediaForVariants({
            workspaceId: workspace.workspaceId,
            userId: customer.userId,
            permissionKeys: workspace.permissionKeys,
            brandScope: workspace.brandScope,
            assetIds: [carriedId],
          });
          return found.get(carriedId) ?? null;
        })()
      : null;
  const allMedia =
    carried && !mediaOptions.some((option) => option.id === carried.id)
      ? [...mediaOptions, carried]
      : mediaOptions;

  const ok = single('ok') ?? null;
  const error = single('error') ?? null;
  const reference = single('ref');
  const successText = ok ? statusMessage(ok, locale) : null;
  const errorText = error ? statusMessage(error, locale, reference) : null;

  /*
   * D-298 (§47) — THIS POST'S HISTORY, from the audit trail: the post, its
   * variants, its review cycles, its calendar slots and its publish jobs. The
   * ids are read under RLS; the events through the Activity service's own
   * viewer grading.
   */
  const history = draft
    ? await activityTimeline({
        locale,
        workspace,
        userId: customer.userId,
        resourceIds: await inWorkspace(workspace.workspaceId, async ({ db }) => {
          const where = { workspaceId: workspace.workspaceId, contentItemId: draft.id };
          const [approvals, slots, jobs] = await Promise.all([
            db.approval.findMany({ where, select: { id: true } }),
            db.calendarSlot.findMany({ where, select: { id: true } }),
            db.publishJob.findMany({ where, select: { id: true } }),
          ]);
          return [
            draft.id,
            ...draft.variants.map((variant) => variant.id),
            ...[...approvals, ...slots, ...jobs].map((row) => row.id),
          ];
        }),
        take: 8,
      })
    : [];

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={translate(draft ? 'content.composer.editTitle' : 'content.composer.title')}
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
        defaultBrandId={composingBrandId}
        platforms={platforms}
        contentTypes={CONTENT_TYPES}
        maxBriefChars={policy.generation.maxBriefChars}
        maxVariants={policy.generation.maxVariantsPerRequest}
        draft={composerDraft}
        campaigns={campaigns}
        mediaOptions={allMedia}
        carriedMedia={carried}
        tools={CONTENT_TOOLS}
        now={now.getTime()}
        review={reviewFacts}
        mode={mode === 'write' ? 'write' : 'ai'}
        initialBrief={initialBrief}
        initialCampaignId={initialCampaignId}
        sourceTitle={source?.title ?? null}
        goals={POST_GOALS.map((key) => ({
          key,
          label: translate(`create.goal.${key}` as MessageKey),
        }))}
        recommendedGoal={recommendedGoal}
        initialGoal={initialGoal}
        authorDefaults={authorDefaults}
        defaultsBrandId={composingBrandId ?? ''}
        forgetDefault={decidePreferenceAction}
        formatPlatforms={formatPlatforms}
        can={{
          create: workspace.permissionKeys.includes('content.create'),
          // B-2 — a published post is read-only whatever the member may do.
          edit: workspace.permissionKeys.includes('content.edit') && !composerDraft?.readOnly,
          submit: workspace.permissionKeys.includes('content.submit'),
          archive: workspace.permissionKeys.includes('content.archive'),
          manageCampaigns: workspace.permissionKeys.includes('campaigns.manage'),
          uploadMedia:
            workspace.permissionKeys.includes('assets.upload') && !composerDraft?.readOnly,
          schedule: workspace.permissionKeys.includes('content.schedule'),
          // The Creative route's own gate (`assets.upload`), and generation
          // needs content editing here because it changes this post.
          generateMedia:
            workspace.permissionKeys.includes('assets.upload') &&
            workspace.permissionKeys.includes('content.edit') &&
            !composerDraft?.readOnly,
        }}
        creativeFormats={CREATIVE_FORMATS.map((format) => ({
          key: format.key,
          label: translate(format.labelKey as MessageKey),
        }))}
        actions={{
          save: saveVariantAction,
          transition: transitionItemAction,
          submitForReview: submitForReviewAction,
          resubmit: resubmitAfterChangesAction,
          duplicate: duplicateContentAction,
          cancelReview: cancelReviewAction,
          setCampaign: setContentCampaignAction,
          uploadMedia: uploadComposerMediaAction,
          createManualDraft: createManualDraftAction,
          listCampaignOptions: listCampaignOptionsAction,
        }}
      />

      {/*
        THE CONVERSATION ABOUT THIS DRAFT (P6-09).
      
        Rendered only once a draft EXISTS — there is nothing to have a
        conversation about before the item has an id, and a panel offering to
        discuss a thing that has not been created yet is a control that cannot
        work.
      
        THIS IS WHERE A "NEEDS WORK" VERDICT LANDS. P6-06 puts the reviewer's
        note on the content item; this is the screen the author opens next, so
        the request and the work are finally on the same page and the author can
        answer it rather than re-reading a closed approval cycle.
      */}
      {draft ? (
        <NotesPanel
          locale={locale}
          subject={{ type: 'CONTENT_ITEM', contentItemId: draft.id }}
          returnPath={`/${locale}/content/compose?item=${draft.id}`}
          highlightThreadId={typeof query['thread'] === 'string' ? query['thread'] : null}
        />
      ) : null}
      {history.length > 0 ? (
        <CustomerCard title={translate('content.history.title')} testId="post-history">
          <ActivityTimeline entries={history} testId="post-history-list" />
        </CustomerCard>
      ) : null}
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

/** The draft editor's own vocabulary (D-284). */
const EDITOR_KEYS = [
  'editor.next.schedule',
  'editor.next.needsApproval',
  'editor.changes.title',
  'editor.changes.by',
  'editor.changes.reply',
  'editor.changes.resubmit',
  'editor.issue.rightsExpired',
  'editor.media.rightsExpired',
  'editor.media.carried',
  'editor.media.carriedBody',
  'editor.media.attached',
  'editor.media.slide',
  'editor.media.none',
  'editor.media.unavailable',
  'editor.media.isCover',
  'editor.media.moveEarlier',
  'editor.media.moveLater',
  'editor.media.replace',
  'editor.media.useAsCover',
  'editor.media.remove',
  'editor.media.add',
  'editor.media.drawerTitle',
  'editor.media.replaceTitle',
  'editor.media.drawerBody',
  'editor.media.close',
  'editor.media.tab.library',
  'editor.media.tab.upload',
  'editor.media.tab.generate',
  'editor.media.added',
  'editor.media.use',
  'editor.media.addThis',
  'editor.media.prompt',
  'editor.media.format',
  'editor.media.estimate',
  'editor.media.generate',
  'editor.media.generateHint',
  'editor.media.generateFailed',
  'editor.media.generating',
  'editor.media.generateSlow',
  'editor.preview.slide',
  'editor.preview.previousSlide',
  'editor.preview.nextSlide',
  'editor.context.title',
  'editor.lifecycle.label',
  'editor.lifecycle.changesRequested',
  'editor.brain.using',
  'editor.brain.basedOn',
  'editor.brain.noSources',
  'editor.brain.open',
  'editor.insufficientBody',
  'editor.insufficient.add',
  'editor.approvedWarning',
  'editor.inReviewWarning',
  'editor.published.readOnly',
  'content.action.duplicate',
  'editor.variants.label',
  'editor.caption',
  'editor.unsaved',
  'editor.saved',
  'editor.firstComment',
  'editor.ai.label',
  'editor.ai.shorten',
  'editor.ai.rewrite',
  'editor.ai.friendlier',
  'editor.ai.professional',
  'editor.ai.expand',
  'editor.ai.hashtags',
  'editor.ai.translate',
  'editor.ai.hint',
  'editor.ai.estimate',
  'editor.ai.saveFirst',
  'editor.saveBeforeReview',
  'editor.preview.title',
  'editor.preview.compare',
  'editor.preview.single',
  'editor.fix.shorten',
  'editor.fix.media',
  'editor.when.now',
  'editor.when.minutes',
  'editor.when.hours',
  'editor.when.days',
  'editor.issue.empty',
  'editor.issue.tooLong',
  'editor.issue.tooManyHashtags',
  'editor.issue.tooMuchMedia',
  'editor.issue.reelNeedsVideo',
  'editor.issue.videoNeedsVideo',
  'editor.issue.carouselNeedsSlides',
  'editor.issue.storyNeedsMedia',
  'content.tool.hashtags',
] as const satisfies readonly MessageKey[];

const COMPOSER_KEYS = [
  'create.carousel.outlineHint',
  // Phase 6 final — the draft editor (D-284).
  ...EDITOR_KEYS,
  // Phase 6 final — how the post was started, its goal and its format (D-283).
  'create.format.unsupported',
  'create.goal.label',
  'create.goal.none',
  'create.goal.recommended',
  'create.defaults.title',
  'create.defaults.forget',
  'create.goal.instruction',
  'create.write.label',
  'create.write.placeholder',
  'create.repurpose.from',
  'create.repurpose.fromBody',
  // Phase 8 — the campaign control on an existing draft (AC-26.3).
  'campaigns.composerLabel',
  'campaigns.composerNone',
  /*
   * Phase 8 — THE MEDIA PICKER'S OWN VOCABULARY (AC-27.1, AC-27.2).
   *
   * Missing from this list when the picker shipped, so every label it asked the
   * dictionary for came back undefined and fell through to `''`: a fieldset
   * with a nameless legend, a count that said nothing, and an empty state with
   * no sentence in it. The component was right and the list was short — which
   * is precisely why the list exists rather than the component reaching for the
   * translator itself.
   */
  'content.media.legend',
  'content.media.none',
  'content.media.empty',
  'content.media.video',
  'content.media.atLimit',
  'content.media.selected',
  'content.media.uploadHint',
  'content.media.uploadLabel',
  'content.media.uploadSubmit',
  'content.media.uploadNotice',
  'assets.filter.shared',
  /*
   * Phase 8 — THE LIVE SOCIAL PREVIEW'S VOCABULARY (AC-27.4).
   *
   * Twenty-six keys, every one of them missing when the preview shipped, so
   * the component that shows an author what their post will look like rendered
   * with every status, platform, format and control label blank. Same class of
   * defect as the picker's above, and the same fix: the key list is the
   * contract, so the contract has to name them.
   */
  'content.status.DRAFT',
  'content.status.IN_REVIEW',
  'content.status.CHANGES_REQUESTED',
  'content.status.APPROVED',
  'content.status.SCHEDULED',
  'content.status.PUBLISHING',
  'content.status.PUBLISHED',
  'content.status.PARTIALLY_PUBLISHED',
  'content.status.FAILED',
  'content.platform.instagram',
  'content.platform.facebook',
  'content.platform.linkedin',
  'content.platform.x',
  'content.platform.tiktok',
  'content.format.feed',
  'content.format.story',
  'content.format.reel',
  'content.format.video',
  'content.preview.showMore',
  'content.preview.showLess',
  'content.preview.missingMedia',
  'content.preview.loadingMedia',
  'content.preview.carousel',
  'content.preview.notice',
  'content.preview.aspect',
  'content.preview.actions',
  // And the composer's own withdraw control, blank for the same reason.
  'content.composer.withdraw',
  'content.composer.eyebrow',
  'content.composer.title',
  'content.composer.back',
  'content.composer.brand',
  'content.composer.brandPlaceholder',
  'content.composer.channels',
  'content.composer.channelsHint',
  'content.composer.brief',
  'content.composer.briefPlaceholder',
  'content.composer.language',
  'content.composer.contentType',
  'content.composer.estimate',
  'content.composer.generate',
  'content.composer.write',
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
