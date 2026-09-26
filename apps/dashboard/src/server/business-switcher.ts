import 'server-only';
import { cache } from 'react';
import {
  TenantCatalogueSource,
  readPlanCatalogue,
  workspaceAllowance,
  type OwnedWorkspaceFact,
  type PlanDetail,
} from '@brandspace/entitlements';
import { currentEnvironment } from '@brandspace/shared';
import type { PrismaClient } from '@brandspace/database';
import { customerRoleName, translator } from '../i18n/messages';
import { getCustomerAuth, getSessionToken, inWorkspace } from './customer-context';
import { planDisplayName } from './plan-usage';
import { switcherFoot, type SwitcherFoot } from './business-switcher-model';

/**
 * THE RAIL'S BUSINESS SWITCHER (Q1 / Q2, D-326).
 *
 * Every business this person belongs to, as "role · plan", the current one
 * ticked; and, for an owner, the workspace allowance read from the same plans
 * and by the same rule the server enforces when a workspace is created.
 *
 * WHERE EACH FACT IS READ, AND WHY THERE. The list comes from the session's
 * own memberships (`listBusinesses`), so nothing outside this person's
 * memberships is ever visible. A workspace's subscription status is tenant
 * data, so it is read INSIDE that workspace's own context, one workspace at a
 * time, through RLS — never across tenants on a privileged connection. The
 * plan catalogue is the activated projection every tenant reads.
 *
 * Cached per request: the shell renders once per page, and this is the only
 * caller.
 */
export interface BusinessSwitcherModel {
  readonly options: readonly {
    readonly id: string;
    readonly name: string;
    readonly caption: string;
    readonly current: boolean;
  }[];
  /** "Role · Plan" for the business the session is in. */
  readonly currentCaption: string;
  readonly foot: SwitcherFoot;
}

const TERMINAL = new Set(['CANCELLED', 'EXPIRED']);

export const businessSwitcherModel = cache(
  async (locale: string, currentWorkspaceId: string): Promise<BusinessSwitcherModel | null> => {
    const token = (await getSessionToken()) ?? '';
    const businesses = await getCustomerAuth()
      .listBusinesses(token)
      .catch(() => null);
    if (!businesses || businesses.length === 0) return null;

    const t = translator(locale);
    const plans: readonly PlanDetail[] = await inWorkspace(currentWorkspaceId, async ({ db }) =>
      readPlanCatalogue(
        await new TenantCatalogueSource(db as unknown as PrismaClient, currentEnvironment()).load(
          'plans',
        ),
      ),
    ).catch(() => []);

    const subscriptions = new Map<string, string | null>();
    for (const business of businesses) {
      const status = await inWorkspace(business.workspaceId, async ({ db }) => {
        const row = await db.workspaceSubscription.findUnique({
          where: { workspaceId: business.workspaceId },
          select: { status: true },
        });
        return row?.status ?? null;
      }).catch(() => null);
      subscriptions.set(business.workspaceId, status);
    }

    const planCaption = (planKey: string | null, workspaceId: string): string => {
      const status = subscriptions.get(workspaceId) ?? null;
      const effective = status !== null && TERMINAL.has(status) ? null : planKey;
      return planDisplayName(effective, plans, locale) ?? t('ws.noPlan');
    };
    const caption = (business: (typeof businesses)[number]): string =>
      t('ws.rolePlan')
        .replace(
          '{role}',
          customerRoleName(locale === 'ar' ? business.roleNameAr : business.roleNameEn),
        )
        .replace('{plan}', planCaption(business.planKey, business.workspaceId));

    const owned: OwnedWorkspaceFact[] = businesses
      .filter((business) => business.isOwner)
      .map((business) => ({
        workspaceId: business.workspaceId,
        status: business.workspaceStatus,
        deletedAt: null,
        planKey: business.planKey,
        subscriptionStatus: subscriptions.get(business.workspaceId) ?? null,
      }));

    const current = businesses.find((business) => business.workspaceId === currentWorkspaceId);
    return {
      options: businesses
        .filter((business) => business.operable)
        .map((business) => ({
          id: business.workspaceId,
          name: business.workspaceName,
          caption: caption(business),
          current: business.workspaceId === currentWorkspaceId,
        })),
      currentCaption: current ? caption(current) : '',
      foot: switcherFoot(workspaceAllowance(owned, plans)),
    };
  },
);
