import {
  mayApproveForBrand,
  policyFromSnapshot,
  type ResolvedApprovalPolicy,
} from '@brandspace/content';
import { brandScopeFilter } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { brandContextFor } from '../../../server/brand-context';
import { inContentStudio } from '../../../server/content-context';
import { mediaForVariants } from '../../../server/media-picker';
import { messages, statusMessage, translator } from '../../../i18n/messages';
import { NOTE_PERMISSION } from '@brandspace/collaboration';
import { NotesPanel } from '../../../components/notes-panel';
import { previewFormatFor } from '../../../server/composer-editor';
import { DictionaryVariantPreview } from '../content/compose/variant-preview';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import {
  ApprovalsView,
  type ApprovalRow,
  type BrandPolicyRow,
  type ReviewSubjectView,
} from './approvals-view';
import { decideApprovalAction, saveApprovalPolicyAction, withdrawApprovalAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Approvals — Phase 5B-3, docs/PRODUCT.md §5 module 14.
 *
 * WHO MAY OPEN THIS SCREEN: a member holding `content.read`, and nobody else.
 *
 * This briefly authorized on MEMBERSHIP instead, so that D-121's per-brand
 * grant could admit a Viewer (read-only) holding `workspace.read` and nothing
 * else. **D-62 supersedes D-121**: for the MVP the Viewer is strictly
 * read-only and has no approval surface at all — no queue, no review subject,
 * no verdict, and no route. The product has no Client Portal, client hand-off
 * or external reviewer surface for such a grant to belong to, and the idea is
 * deferred to a future External Review / Guest Approval capability with its
 * own narrow actor rather than a repurposed customer role.
 *
 * So the gate is back to `content.read`, and a Viewer reaching `/approvals`
 * gets the same NOT_FOUND any member without the permission gets. The
 * navigation does not offer the item to them either, but the REFUSAL IS THE
 * CONTROL — the hidden link is only tidiness.
 *
 * WHAT THE READER MAY DO IS RESOLVED HERE AND ENFORCED IN THE SERVICE. Every
 * `mayDecide` is computed through the SAME `mayApproveForBrand` the service
 * calls, so the screen and the control cannot disagree — and the screen
 * deciding wrongly would only ever hide a button, never open one.
 */
export default async function ApprovalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const query = await searchParams;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'content.read');

  const ok = typeof query.ok === 'string' ? query.ok : null;
  const error = typeof query.error === 'string' ? query.error : null;
  const reference = typeof query.ref === 'string' ? query.ref : undefined;
  const reviewId = typeof query.review === 'string' ? query.review : null;

  // Implied by the route gate above; kept as a named constant because the view
  // props read better for it, and because the gate is the thing that may change.
  const maySeeContent = true;
  const mayManagePolicy = workspace.permissionKeys.includes('approvals.policy.manage');

  const brands = await inWorkspace(workspace.workspaceId, async ({ db }) =>
    db.brand.findMany({
      where: {
        workspaceId: workspace.workspaceId,
        deletedAt: null,
        ...brandScopeFilter(workspace.brandScope),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true },
    }),
  );
  const brandNames = new Map(brands.map((b) => [b.id, b.name]));

  const actor = {
    userId: customer.userId,
    roleKey: workspace.roleKey,
    permissionKeys: workspace.permissionKeys,
    brandScope: workspace.brandScope,
  };

  const { policies, queue, mine, memberNames, review } = await inContentStudio(
    workspace.workspaceId,
    async ({ approvals, db }) => {
      const service = await approvals();

      /*
       * The brands in this member's scope, and their rules. There is no longer
       * a per-brand question of WHO may review: `content.approve` answers it
       * for the whole workspace, so a brand contributes its policy and nothing
       * else.
       */
      const resolved: BrandPolicyRow[] = [];
      for (const brand of brands) {
        const policy: ResolvedApprovalPolicy = await service.policyForBrand(brand.id);
        resolved.push({
          brandId: brand.id,
          brandName: brand.name,
          requireApprovalBeforeScheduling: policy.requireApprovalBeforeScheduling,
          allowSelfApproval: policy.allowSelfApproval,
        });
      }

      /*
       * THE QUEUE'S SCOPE is simply the member's brand scope, where `undefined`
       * is the platform's "unrestricted" — the same reading `brandScopeFilter()`
       * has everywhere else, and NOT an expansion into every brand id, which is
       * what made an unrestricted member's queue depend on a list the page had
       * to build first.
       */
      const queueScope = workspace.brandScope.length > 0 ? workspace.brandScope : undefined;
      const pending = await service.queue({ brandScope: queueScope });

      /* "What you sent" is every cycle THIS member opened. */
      const own = await db.approval.findMany({
        where: {
          workspaceId: workspace.workspaceId,
          requestedByUserId: customer.userId,
          ...(workspace.brandScope.length > 0
            ? { brandId: { in: [...workspace.brandScope] } }
            : {}),
        },
        include: { item: { select: { id: true, title: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      /*
       * THE REVIEW SUBJECT, when one is asked for. Authorized inside the
       * service, which requires `content.read` and the brand scope, so a
       * request for another brand's review gets the same not-found a
       * non-existent id would give.
       */
      const subject = reviewId
        ? await service.reviewSubject({ approvalId: reviewId, actor }).catch(() => null)
        : null;

      const userIds = [
        ...new Set([
          ...pending.map((p) => p.requestedByUserId),
          ...own.map((o) => o.requestedByUserId),
        ]),
      ];
      const members =
        userIds.length > 0
          ? await db.membership.findMany({
              where: { workspaceId: workspace.workspaceId, userId: { in: userIds } },
              select: { userId: true, user: { select: { email: true, name: true } } },
            })
          : [];

      return {
        policies: resolved,
        queue: pending,
        mine: own,
        review: subject,
        memberNames: new Map(members.map((m) => [m.userId, m.user.name ?? m.user.email] as const)),
      };
    },
  );

  /*
   * A member who can neither read content nor review any brand is shown the
   * screen's honest refusal rather than a 404: the route exists, the product
   * has it, and `mayReview: false` means every panel below is withheld and
   * every query above returned nothing for them. A 404 on a nav item the shell
   * shows to every member would be a dead link, which §20 forbids.
   */
  const policyByBrand = new Map(policies.map((p) => [p.brandId, p] as const));
  const dateFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const nameOf = (userId: string) =>
    userId === customer.userId ? t('activity.you') : (memberNames.get(userId) ?? '—');

  const queueRows: ApprovalRow[] = queue.map((row) => {
    /*
     * D-126: JUDGE THE ROW BY THE POLICY ITS CYCLE WAS OPENED UNDER, which is
     * what `decide()` will judge it by. Reading the brand's live policy here
     * made the screen disagree with the server the moment a policy changed
     * while a review was open: flipping `allowSelfApproval` on rendered an
     * Approve button for a cycle snapshotted under the stricter rule, and
     * pressing it earned a refusal. The screen resolves the same effective
     * policy the verdict will, so what it offers is what the server honours.
     */
    const current = policyByBrand.get(row.brandId);
    const policy =
      current === undefined ? undefined : policyFromSnapshot(row.policySnapshot, current);
    const mayApprove =
      policy !== undefined && mayApproveForBrand({ permissionKeys: workspace.permissionKeys });
    // D-122, mirrored from the service: the requester AND the author are barred.
    const isSelf =
      row.requestedByUserId === customer.userId || row.item?.createdByUserId === customer.userId;
    const blocked = mayApprove && isSelf && policy?.allowSelfApproval === false;
    /*
     * An ASSIGNED review is that person's to decide, and the service enforces
     * it. The screen reflects it so a reviewer is not offered a button that
     * will refuse them.
     */
    const assignedElsewhere =
      row.assignedToUserId !== null && row.assignedToUserId !== customer.userId;
    return {
      id: row.id,
      itemId: row.contentItemId ?? '',
      itemTitle: row.item?.title ?? '—',
      brandName: brandNames.get(row.brandId) ?? '—',
      status: row.status,
      requestedByLabel: nameOf(row.requestedByUserId),
      requestedAtLabel: dateFormat.format(row.createdAt),
      cycle: row.cycle,
      requestNote: row.requestNote,
      mayDecide: mayApprove && !blocked && !assignedElsewhere,
      blockedAsSelf: Boolean(blocked),
      assignedElsewhere,
      mayWithdraw: false,
      mayOpenInStudio: maySeeContent,
    };
  });

  const mineRows: ApprovalRow[] = mine.map((row) => ({
    id: row.id,
    itemId: row.contentItemId ?? '',
    itemTitle: row.item?.title ?? '—',
    brandName: brandNames.get(row.brandId) ?? '—',
    status: row.status,
    requestedByLabel: nameOf(row.requestedByUserId),
    requestedAtLabel: dateFormat.format(row.createdAt),
    cycle: row.cycle,
    requestNote: row.requestNote,
    mayDecide: false,
    blockedAsSelf: false,
    assignedElsewhere: false,
    mayWithdraw: row.status === 'PENDING',
    mayOpenInStudio: maySeeContent,
  }));

  /*
   * PHASE 8 — THE MEDIA THE REVIEWER IS APPROVING (AC-29.1).
   *
   * Loaded only for the item actually being reviewed, not for the whole queue:
   * a queue is a list of decisions to make and a review is the decision, and
   * minting a preview grant per row would issue capabilities nobody asked for.
   */
  const reviewMedia = review
    ? await mediaForVariants({
        workspaceId: workspace.workspaceId,
        userId: customer.userId,
        permissionKeys: workspace.permissionKeys,
        brandScope: workspace.brandScope,
        assetIds: review.variants.flatMap((variant) => [...variant.assetIds]),
      })
    : new Map<string, { id: string; name: string; kind: string; previewToken: string | null }>();

  // Only the preview's own keys cross to the client, not the whole dictionary.
  const dictionary = previewDictionary(locale);
  const reviewView: ReviewSubjectView | null = review
    ? {
        approvalId: review.approvalId,
        itemId: review.itemId,
        itemTitle: review.itemTitle,
        brandName: review.brandName,
        cycle: review.cycle,
        requestNote: review.requestNote,
        requestedByLabel: nameOf(review.requestedByUserId),
        mayDecide: review.mayDecide,
        previews: review.variants.map((v) => (
          <DictionaryVariantPreview
            key={v.id}
            locale={locale}
            platformKey={v.platformKey}
            format={previewFormatFor(review.contentType)}
            body={v.body}
            hashtags={[...v.hashtags]}
            media={[...v.assetIds]
              .map((id) => reviewMedia.get(id))
              .filter((item): item is NonNullable<typeof item> => item !== undefined)}
            accountName={review.brandName}
            accountHandle={`@${review.brandName.replace(/\s+/g, '').toLowerCase()}`}
            status="DRAFT"
            approval="NEEDS_APPROVAL"
            dictionary={dictionary}
            testId={`review-preview-${v.platformKey}`}
          />
        )),
        conversation: workspace.permissionKeys.includes(NOTE_PERMISSION) ? (
          <NotesPanel
            locale={locale}
            subject={{
              type: 'CONTENT_ITEM',
              contentItemId: review.itemId,
            }}
            returnPath={`/${locale}/approvals?review=${review.approvalId}`}
            highlightThreadId={null}
          />
        ) : null,
        variants: review.variants.map((v) => ({
          id: v.id,
          platformKey: v.platformKey,
          body: v.body,
          hashtags: [...v.hashtags],
          /*
           * IN THE AUTHOR'S ORDER, and only what could be resolved: an asset
           * that has since been deleted or quarantined simply does not appear,
           * which is the honest rendering — the publish pipeline would refuse
           * it too, and showing a broken tile would suggest otherwise.
           */
          media: [...v.assetIds]
            .map((id) => reviewMedia.get(id))
            .filter((item): item is NonNullable<typeof item> => item !== undefined),
        })),
      }
    : null;

  const brandContext = await brandContextFor(workspace, '/approvals');

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      activePath="/approvals"
      heading={t('approvals.title')}
      description={t('approvals.subtitle')}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      {ok ? <CustomerBanner tone="success">{statusMessage(ok, locale)}</CustomerBanner> : null}
      {error ? (
        <CustomerBanner tone="error">{statusMessage(error, locale, reference)}</CustomerBanner>
      ) : null}
      <ApprovalsView
        locale={locale}
        t={t}
        queue={queueRows}
        mine={mineRows}
        policies={policies}
        review={reviewView}
        mayReview={mayApproveForBrand({ permissionKeys: workspace.permissionKeys })}
        mayReadContent={maySeeContent}
        mayManagePolicy={mayManagePolicy}
        actions={{
          decide: decideApprovalAction,
          withdraw: withdrawApprovalAction,
          savePolicy: saveApprovalPolicyAction,
        }}
      />
    </WorkspaceShell>
  );
}

/** The keys `previewLabels` reads, in this locale — and nothing else. */
function previewDictionary(locale: string): Record<string, string> {
  const all = messages[locale === 'ar' ? 'ar' : 'en'] as Record<string, string>;
  return Object.fromEntries(
    Object.entries(all).filter(
      ([key]) =>
        key.startsWith('content.status.') ||
        key.startsWith('content.platform.') ||
        key.startsWith('content.format.') ||
        key.startsWith('content.preview.') ||
        key.startsWith('editor.preview.') ||
        key === 'content.media.video',
    ),
  );
}
