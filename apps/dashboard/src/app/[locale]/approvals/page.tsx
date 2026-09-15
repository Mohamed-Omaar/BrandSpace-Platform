import {
  mayApproveForBrand,
  policyFromSnapshot,
  type ResolvedApprovalPolicy,
} from '@brandspace/content';
import { brandScopeFilter } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { inContentStudio } from '../../../server/content-context';
import { statusMessage, translator } from '../../../i18n/messages';
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
 * WHO MAY OPEN THIS SCREEN, and why it is not one permission.
 *
 * Two different people need it. A member with `content.read` uses it to follow
 * what they sent and — if they also hold review authority — to decide. A
 * **Viewer (read-only)** whose BRAND has switched on D-121's per-brand grant
 * needs it to decide, and holds `workspace.read` and nothing else: gating the
 * route on `content.read` made that grant unreachable, which is the defect
 * finding 2 names. So the page authorizes on MEMBERSHIP, then resolves what
 * this member may actually do, and renders nothing they may not.
 *
 * WHAT A VIEWER SEES: the queue for the brands whose policy admits them, and
 * the review subject for one of those reviews — the title, the captions and the
 * requester's note. Not the content library, not other brands' reviews, not
 * "what you sent" (they cannot send), not the policy editor. Every one of those
 * is withheld by a server-side check, not by leaving a link out.
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
  const { customer, workspace } = await requireWorkspace(locale);

  const ok = typeof query.ok === 'string' ? query.ok : null;
  const error = typeof query.error === 'string' ? query.error : null;
  const reference = typeof query.ref === 'string' ? query.ref : undefined;
  const reviewId = typeof query.review === 'string' ? query.review : null;

  const maySeeContent = workspace.permissionKeys.includes('content.read');
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

  const { policies, reviewableBrandIds, queue, mine, memberNames, review } = await inContentStudio(
    workspace.workspaceId,
    async ({ approvals, db }) => {
      const service = await approvals();

      /*
       * THE BRANDS THIS MEMBER MAY REVIEW, resolved per brand because D-121 is
       * a per-brand grant: a Viewer enabled for Brand A must see Brand A's
       * queue and learn nothing at all about Brand B's.
       */
      const resolved: BrandPolicyRow[] = [];
      const reviewable: string[] = [];
      for (const brand of brands) {
        const policy: ResolvedApprovalPolicy = await service.policyForBrand(brand.id);
        resolved.push({
          brandId: brand.id,
          brandName: brand.name,
          requireApprovalBeforeScheduling: policy.requireApprovalBeforeScheduling,
          allowSelfApproval: policy.allowSelfApproval,
          clientApprovalEnabled: policy.clientApprovalEnabled,
        });
        if (
          mayApproveForBrand({
            roleKey: workspace.roleKey,
            permissionKeys: workspace.permissionKeys,
            policy,
          })
        ) {
          reviewable.push(brand.id);
        }
      }

      /*
       * THE QUEUE'S SCOPE. A member who may read content sees their whole brand
       * scope; a member who may not sees ONLY the brands that admit them as a
       * reviewer — which for a Viewer is the entire extent of their access.
       *
       * `undefined` is the platform's "unrestricted" for a member with no brand
       * restriction, which the service reads the same way `brandScopeFilter()`
       * does everywhere else.
       */
      const queueScope = maySeeContent
        ? workspace.brandScope.length > 0
          ? workspace.brandScope
          : undefined
        : reviewable;
      const pending =
        maySeeContent || reviewable.length > 0
          ? await service.queue({ brandScope: queueScope })
          : [];

      /*
       * "What you sent" is every cycle THIS member opened. A member who cannot
       * submit has never opened one, so the panel is simply not queried for
       * them rather than queried and found empty.
       */
      const own = maySeeContent
        ? await db.approval.findMany({
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
          })
        : [];

      /*
       * THE REVIEW SUBJECT, when one is asked for. Authorized inside the
       * service against that approval's own brand policy, so a Viewer granted
       * Brand A asking for a Brand B review gets the same not-found a
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
        reviewableBrandIds: reviewable,
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
      policy !== undefined &&
      mayApproveForBrand({
        roleKey: workspace.roleKey,
        permissionKeys: workspace.permissionKeys,
        policy,
      });
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
        variants: review.variants.map((v) => ({
          id: v.id,
          platformKey: v.platformKey,
          body: v.body,
          hashtags: [...v.hashtags],
        })),
      }
    : null;

  return (
    <WorkspaceShell
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
        mayReview={reviewableBrandIds.length > 0}
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
