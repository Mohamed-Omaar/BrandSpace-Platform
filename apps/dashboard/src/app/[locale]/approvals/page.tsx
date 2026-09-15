import { mayApproveForBrand } from '@brandspace/content';
import { brandScopeFilter } from '@brandspace/shared';
import { inWorkspace, requireWorkspace } from '../../../server/customer-context';
import { inContentStudio } from '../../../server/content-context';
import { statusMessage, translator } from '../../../i18n/messages';
import { CustomerBanner, WorkspaceShell } from '../../../components/workspace-shell';
import { ApprovalsView, type ApprovalRow, type BrandPolicyRow } from './approvals-view';
import { decideApprovalAction, saveApprovalPolicyAction, withdrawApprovalAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * Approvals — Phase 5B-3, docs/PRODUCT.md §5 module 14.
 *
 * WHAT THE READER MAY DO IS RESOLVED HERE AND ENFORCED IN THE SERVICE. Every
 * `mayDecide` on this page is computed from the brand's own policy through the
 * SAME `mayApproveForBrand` the service calls, so the screen and the control
 * cannot disagree — and the screen deciding wrongly would only ever hide a
 * button, never open one.
 *
 * NAMES, NOT IDS. A queue that rendered raw user ids would be unreadable and
 * would also publish the membership table's keys into a browser bundle. The
 * page resolves the display names it needs, for the members of THIS workspace,
 * inside the tenant transaction.
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
  const scope = workspace.brandScope.length > 0 ? workspace.brandScope : brands.map((b) => b.id);

  const { queue, mine, policies, memberNames } = await inContentStudio(
    workspace.workspaceId,
    async ({ approvals, db }) => {
      const service = await approvals();
      const pending = await service.queue({ brandScope: scope });
      /*
       * "What you sent" is every cycle THIS member opened, decided or not — the
       * point of the panel is to follow an answer, and an answer is only visible
       * once the cycle has closed.
       */
      const own = await db.approval.findMany({
        where: {
          workspaceId: workspace.workspaceId,
          requestedByUserId: customer.userId,
          brandId: { in: [...scope] },
        },
        include: { item: { select: { id: true, title: true } } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      const resolvedPolicies: BrandPolicyRow[] = [];
      for (const brand of brands) {
        const policy = await service.policyForBrand(brand.id);
        resolvedPolicies.push({
          brandId: brand.id,
          brandName: brand.name,
          requireApprovalBeforeScheduling: policy.requireApprovalBeforeScheduling,
          allowSelfApproval: policy.allowSelfApproval,
          clientApprovalEnabled: policy.clientApprovalEnabled,
        });
      }

      const userIds = [
        ...new Set([
          ...pending.map((p) => p.requestedByUserId),
          ...own.map((o) => o.requestedByUserId),
        ]),
      ];
      const members = await db.membership.findMany({
        where: { workspaceId: workspace.workspaceId, userId: { in: userIds } },
        select: { userId: true, user: { select: { email: true, name: true } } },
      });
      return {
        queue: pending,
        mine: own,
        policies: resolvedPolicies,
        memberNames: new Map(members.map((m) => [m.userId, m.user.name ?? m.user.email] as const)),
      };
    },
  );

  const policyByBrand = new Map(policies.map((p) => [p.brandId, p] as const));
  const dateFormat = new Intl.DateTimeFormat(locale === 'ar' ? 'ar' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  const nameOf = (userId: string) =>
    userId === customer.userId ? t('activity.you') : (memberNames.get(userId) ?? '—');

  const queueRows: ApprovalRow[] = queue.map((row) => {
    const policy = policyByBrand.get(row.brandId);
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
      mayDecide: mayApprove && !blocked,
      blockedAsSelf: Boolean(blocked),
      mayWithdraw: false,
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
    mayWithdraw: row.status === 'PENDING',
  }));

  const mayReview = policies.some((policy) =>
    mayApproveForBrand({
      roleKey: workspace.roleKey,
      permissionKeys: workspace.permissionKeys,
      policy,
    }),
  );

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
        mayReview={mayReview}
        mayManagePolicy={workspace.permissionKeys.includes('approvals.policy.manage')}
        actions={{
          decide: decideApprovalAction,
          withdraw: withdrawApprovalAction,
          savePolicy: saveApprovalPolicyAction,
        }}
      />
    </WorkspaceShell>
  );
}
