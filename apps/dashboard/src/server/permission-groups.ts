import type { MessageKey } from '../i18n/messages';

/**
 * ROLES & PERMISSIONS AS THE PROTOTYPE GROUPS THEM (review of #68, round 4, 2.1).
 *
 * `prototype-2026-09-27` (`T.groups` in `Main.dc.html`) shows a member's
 * permissions as seven groups of plain-language actions — Content, Brand Brain,
 * Media, Planning, Publishing & accounts, Data & AI, Workspace — keyed by the
 * product's own permission keys. This is that table, read-only: it changes no
 * permission, adds no key and never shows one to a customer (the key is the
 * row's identity in code, the label is what is read).
 *
 * "Invite and remove members" is the prototype's `member.manage`; the product
 * holds it as two keys, granted together, so the row is on when both are.
 *
 * PURE, AND NOT `server-only`: the unit suite imports it.
 */

export type PermissionGroupId =
  'content' | 'brandBrain' | 'media' | 'planning' | 'publishing' | 'data' | 'workspace';

interface Action {
  /** The row's identity, and the message key of its label. */
  readonly id: string;
  /** The product's permission keys the action needs, all of them. */
  readonly keys: readonly string[];
}

export const PERMISSION_GROUPS: readonly {
  readonly id: PermissionGroupId;
  readonly actions: readonly Action[];
}[] = [
  {
    id: 'content',
    actions: [
      { id: 'content.create', keys: ['content.create'] },
      { id: 'content.submit', keys: ['content.submit'] },
      { id: 'content.approve', keys: ['content.approve'] },
      { id: 'content.schedule', keys: ['content.schedule'] },
      { id: 'content.archive', keys: ['content.archive'] },
    ],
  },
  {
    id: 'brandBrain',
    actions: [
      { id: 'brand_brain.edit', keys: ['brand_brain.edit'] },
      { id: 'brand_brain.upload', keys: ['brand_brain.upload'] },
      { id: 'brand_brain.review', keys: ['brand_brain.review'] },
    ],
  },
  {
    id: 'media',
    actions: [
      { id: 'assets.upload', keys: ['assets.upload'] },
      { id: 'assets.archive', keys: ['assets.archive'] },
    ],
  },
  {
    id: 'planning',
    actions: [
      { id: 'campaigns.manage', keys: ['campaigns.manage'] },
      { id: 'templates.manage', keys: ['templates.manage'] },
      { id: 'strategy.manage', keys: ['strategy.manage'] },
      { id: 'automation.manage', keys: ['automation.manage'] },
    ],
  },
  {
    id: 'publishing',
    actions: [
      { id: 'publishing.manage', keys: ['publishing.manage'] },
      { id: 'integrations.manage', keys: ['integrations.manage'] },
    ],
  },
  {
    id: 'data',
    actions: [
      { id: 'analytics.export', keys: ['analytics.export'] },
      { id: 'copilot.use', keys: ['copilot.use'] },
    ],
  },
  {
    id: 'workspace',
    actions: [
      { id: 'member.manage', keys: ['member.invite', 'member.remove'] },
      { id: 'billing.manage', keys: ['billing.manage'] },
    ],
  },
];

/** The prototype's notes (`T.permNotes`), shown on a row the role holds. */
const NOTES = new Set([
  'content.approve',
  'integrations.manage',
  'publishing.manage',
  'copilot.use',
]);
/** Notes the prototype writes in its warning red (`.bsp-pg-note[data-sensitive]`). */
const SENSITIVE = new Set(['integrations.manage', 'publishing.manage']);

export type PermissionState = 'role' | 'ownerOnly' | 'none';

export interface PermissionRow {
  readonly id: string;
  readonly label: MessageKey;
  readonly state: PermissionState;
  readonly note: MessageKey | null;
  readonly sensitive: boolean;
}

export interface PermissionGroupView {
  readonly id: PermissionGroupId;
  readonly title: MessageKey;
  readonly rows: readonly PermissionRow[];
}

/**
 * The groups for one role's permission keys. `ownerOnly` names the keys only
 * the owner may hold (`OWNER_ONLY_PERMISSIONS`); a row needing one reads
 * "Owner only" when the role does not hold it, as the prototype's
 * `billing.manage` does.
 */
export function permissionGroups(
  held: readonly string[],
  ownerOnly: readonly string[],
): readonly PermissionGroupView[] {
  const has = new Set(held);
  return PERMISSION_GROUPS.map((group) => ({
    id: group.id,
    title: `perms.group.${group.id}` as MessageKey,
    rows: group.actions.map((action) => {
      const on = action.keys.every((key) => has.has(key));
      const state: PermissionState = on
        ? 'role'
        : action.keys.some((key) => ownerOnly.includes(key))
          ? 'ownerOnly'
          : 'none';
      return {
        id: action.id,
        label: `perms.action.${action.id}` as MessageKey,
        state,
        note: on && NOTES.has(action.id) ? (`perms.note.${action.id}` as MessageKey) : null,
        sensitive: SENSITIVE.has(action.id),
      };
    }),
  }));
}

/** Every permission key the seven groups name — the rest go under "All permissions". */
export const GROUPED_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  PERMISSION_GROUPS.flatMap((group) => group.actions.flatMap((action) => action.keys)),
);
