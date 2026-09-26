import { copilotHref, copilotSurfaceForPath } from './copilot-surface';
import type { MessageKey } from '../i18n/messages';

/**
 * THE CUSTOMER TOP BAR, AS DATA (P6-16).
 *
 * Review · Notes · Notifications · Copilot · Create. Every action leads to the
 * screen that already owns the capability — there is no second approvals
 * system, no second notes store and no search that searches nothing — and each
 * is offered on EXACTLY the permission its destination demands, so the top bar
 * never shows a link that answers 404.
 *
 * THE HIDDEN LINK IS TIDINESS, NOT SECURITY. Every destination and every action
 * behind it authorizes independently; nothing here is load-bearing, which is the
 * same rule the sidebar's `NAV` table follows.
 *
 * PURE, AND NOT `server-only`, so the unit suite pins the rule directly. The
 * counts arrive already resolved (`topbar-counts.ts`); this only decides what
 * to show and where it goes.
 */

/** What each destination route requires — the same key its `requireWorkspace` asks. */
export const TOPBAR_PERMISSIONS = {
  /** `/approvals` — `requireWorkspace(locale, 'content.read')`. */
  review: 'content.read',
  /** `/notes` — `NOTE_PERMISSION` in `@brandspace/collaboration`. */
  notes: 'content.read',
  /** `/copilot` — `requireWorkspace(locale, 'copilot.use')`. */
  copilot: 'copilot.use',
} as const;

/**
 * The creation flows the top bar can start.
 *
 * `requires` is EVERY key the flow needs: the destination page's own gate AND
 * the permission that lets a member complete the creation there. Both, rather
 * than trusting that one implies the other — a custom role could hold
 * `assets.upload` without `assets.read`, and the flow would then open a 404.
 */
export const TOPBAR_CREATE_FLOWS: readonly {
  readonly key: 'content' | 'campaign' | 'creative' | 'asset';
  readonly path: string;
  readonly requires: readonly string[];
  readonly labelKey: MessageKey;
}[] = [
  // `/content/compose` opens for `content.read`; writing a draft needs `content.create`.
  {
    key: 'content',
    path: '/content/compose',
    requires: ['content.read', 'content.create'],
    labelKey: 'topbar.createContent',
  },
  {
    key: 'campaign',
    path: '/campaigns/new',
    requires: ['campaigns.manage'],
    labelKey: 'topbar.createCampaign',
  },
  {
    key: 'creative',
    path: '/creative',
    // Q18 — the Studio spends credits, so it also needs `copilot.use`.
    requires: ['assets.upload', 'copilot.use'],
    labelKey: 'topbar.createCreative',
  },
  // `?upload=1` opens the Asset Library's own upload dialog.
  {
    key: 'asset',
    path: '/assets?upload=1',
    requires: ['assets.read', 'assets.upload'],
    labelKey: 'topbar.createAsset',
  },
];

export interface TopbarCounts {
  /** Approvals waiting on a decision this member may make; null when unknown. */
  readonly review: number | null;
  /** Unread mentions of this member, in brands they can see. */
  readonly notes: number | null;
  /** Unread in-app notifications for this member. */
  readonly notifications: number | null;
}

export interface TopbarLinkModel {
  readonly key: 'review' | 'notes' | 'notifications' | 'copilot';
  readonly href: string;
  readonly labelKey: MessageKey;
  /** The count behind the dot, and the words it is announced with. */
  readonly count: number | null;
  readonly countKey: MessageKey | null;
  readonly current: boolean;
}

export interface TopbarModel {
  readonly links: readonly TopbarLinkModel[];
  readonly create: readonly { key: string; href: string; labelKey: MessageKey }[];
}

/** The route without its locale or query: `/en/approvals?x=1` → `/approvals`. */
export function routeOf(requestPath: string | null | undefined): string {
  if (!requestPath) return '/';
  const [pathname = ''] = requestPath.split('?', 1);
  return `/${pathname.split('/').filter(Boolean).slice(1).join('/')}`;
}

function onRoute(route: string, destination: string): boolean {
  return route === destination || route.startsWith(`${destination}/`);
}

export function topbarModel(input: {
  readonly locale: string;
  readonly permissionKeys: readonly string[];
  /** `x-brandspace-path`: the real route and query the reader is on. */
  readonly requestPath: string | null | undefined;
  readonly counts: TopbarCounts;
}): TopbarModel {
  const { locale, permissionKeys, counts } = input;
  const may = (key: string) => permissionKeys.includes(key);
  const route = routeOf(input.requestPath);

  const links: TopbarLinkModel[] = [];
  if (may(TOPBAR_PERMISSIONS.review)) {
    links.push({
      key: 'review',
      href: `/${locale}/approvals`,
      labelKey: 'topbar.review',
      count: counts.review,
      countKey: 'topbar.reviewCount',
      current: onRoute(route, '/approvals'),
    });
  }
  if (may(TOPBAR_PERMISSIONS.notes)) {
    links.push({
      key: 'notes',
      href: `/${locale}/notes`,
      labelKey: 'topbar.notes',
      count: counts.notes,
      countKey: 'topbar.notesCount',
      current: onRoute(route, '/notes'),
    });
  }
  // `/notifications` asks no permission: every member has their own inbox.
  links.push({
    key: 'notifications',
    href: `/${locale}/notifications`,
    labelKey: 'topbar.notifications',
    count: counts.notifications,
    countKey: 'topbar.notificationsCount',
    current: onRoute(route, '/notifications'),
  });
  if (may(TOPBAR_PERMISSIONS.copilot)) {
    links.push({
      key: 'copilot',
      // The screen the reader is on travels with them (P6-12's `?from=`).
      href: copilotHref(locale, copilotSurfaceForPath(input.requestPath)),
      labelKey: 'topbar.copilot',
      count: null,
      countKey: null,
      current: onRoute(route, '/copilot'),
    });
  }

  const create = TOPBAR_CREATE_FLOWS.filter((flow) => flow.requires.every(may)).map((flow) => ({
    key: flow.key,
    href: `/${locale}${flow.path}`,
    labelKey: flow.labelKey,
  }));

  return { links, create };
}
