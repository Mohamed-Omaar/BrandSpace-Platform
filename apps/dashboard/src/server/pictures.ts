import 'server-only';
import { cache } from 'react';
import {
  TenantAssetPolicySource,
  avatarObjectKey,
  checkPicture,
  createVirusScanner,
  maxBytesForKind,
  workspaceLogoObjectKey,
  type PictureRefusal,
} from '@brandspace/assets';
import { getPrisma, writeAuditEvent } from '@brandspace/database';
import {
  createLogger,
  currentEnvironment,
  internalErrorFields,
  systemClock,
} from '@brandspace/shared';
import { objectStore } from './assets-context';
import { getCustomer, getCustomerAuth, getSessionToken, inWorkspace } from './customer-context';

const log = createLogger({ context: { component: 'dashboard.pictures' } });

/**
 * PR D (D-609) — PEOPLE'S AVATARS AND THE WORKSPACE'S LOGO.
 *
 * STORED: the bytes in the object store under a key built here from ids
 * (`avatars/<userId>/<uuid>.<ext>`, `workspaces/<id>/logo/<uuid>.<ext>`), the
 * key and its time on the row (`user.avatarKey`, `workspace.logoKey`). A new
 * picture gets a new key, the old object is deleted after the row moved, and
 * the time is the cache-buster in every link.
 *
 * SERVED by two route handlers, never by a public URL:
 *   - `/[locale]/people/[userId]/avatar` — to a signed-in person whose CURRENT
 *     workspace has that person as a member (or to themselves);
 *   - `/[locale]/workspace-logo/[workspaceId]` — to a member of that workspace.
 * Anyone else gets the 404 a missing picture gets. `pictureVersions` answers the
 * same question the avatar route does, so a page never links a picture the
 * route would refuse.
 *
 * CHECKED (`checkPicture`): the asset library's image rules and its scanner.
 */

export type PictureOutcome = PictureRefusal | 'picture-unavailable';

/** The link to a person's avatar, or null for the initials. */
export function avatarHref(locale: string, userId: string, version: Date | null): string | null {
  return version ? `/${locale}/people/${userId}/avatar?v=${version.getTime()}` : null;
}

/** The link to a workspace's logo, or null for the letter. */
export function workspaceLogoHref(
  locale: string,
  workspaceId: string,
  version: Date | null,
): string | null {
  return version ? `/${locale}/workspace-logo/${workspaceId}?v=${version.getTime()}` : null;
}

/**
 * Which of these people have an avatar this workspace's members may see:
 * people with a membership row in it (current or past — an old post still
 * names its author). userId → the avatar's time.
 */
export async function pictureVersions(
  workspaceId: string,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> {
  const ids = [...new Set(userIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return new Map();
  const members = await inWorkspace(workspaceId, ({ db }) =>
    db.membership.findMany({
      where: { workspaceId, userId: { in: ids } },
      select: { userId: true },
    }),
  );
  const visible = members.map((m) => m.userId);
  if (visible.length === 0) return new Map();
  const rows = await getPrisma().user.findMany({
    where: { id: { in: visible }, avatarUpdatedAt: { not: null } },
    select: { id: true, avatarUpdatedAt: true },
  });
  return new Map(rows.map((r) => [r.id, r.avatarUpdatedAt!] as const));
}

/**
 * The avatar times of people the CALLER already knows are members of the
 * viewer's workspace (a list read through RLS, e.g. the mention candidates).
 */
export async function memberAvatarVersions(
  userIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> {
  const ids = [...new Set(userIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (ids.length === 0) return new Map();
  const rows = await getPrisma().user.findMany({
    where: { id: { in: ids }, avatarUpdatedAt: { not: null } },
    select: { id: true, avatarUpdatedAt: true },
  });
  return new Map(rows.map((r) => [r.id, r.avatarUpdatedAt!] as const));
}

/** The signed-in person's own avatar time (the account card), or null. */
export const ownAvatarVersion = cache(async (): Promise<Date | null> => {
  const customer = await getCustomer().catch(() => null);
  if (!customer) return null;
  const row = await getPrisma()
    .user.findUnique({ where: { id: customer.userId }, select: { avatarUpdatedAt: true } })
    .catch(() => null);
  return row?.avatarUpdatedAt ?? null;
});

/** Each of these workspaces' logo time, read in that workspace's own context. */
export async function logoVersions(
  workspaceIds: readonly string[],
): Promise<ReadonlyMap<string, Date>> {
  const entries = await Promise.all(
    [...new Set(workspaceIds)].map(async (workspaceId) => {
      const row = await inWorkspace(workspaceId, ({ db }) =>
        db.workspace.findUnique({ where: { id: workspaceId }, select: { logoUpdatedAt: true } }),
      ).catch(() => null);
      return [workspaceId, row?.logoUpdatedAt ?? null] as const;
    }),
  );
  return new Map(entries.filter((e): e is readonly [string, Date] => e[1] !== null));
}

/** Is this person allowed to see `userId`'s avatar from `workspaceId`? */
export async function mayViewAvatar(
  viewerUserId: string,
  workspaceId: string | null,
  userId: string,
): Promise<boolean> {
  if (viewerUserId === userId) return true;
  if (!workspaceId) return false;
  // The viewer's own membership is the session's; the subject's is checked here.
  return (await pictureVersions(workspaceId, [userId])).has(userId);
}

/** Is the signed-in person a member of `workspaceId`? From the session's own memberships. */
export async function isMemberOf(workspaceId: string): Promise<boolean> {
  const token = (await getSessionToken()) ?? '';
  const businesses = await getCustomerAuth()
    .listBusinesses(token)
    .catch(() => []);
  return businesses.some((business) => business.workspaceId === workspaceId);
}

/**
 * Check a picture against the workspace's activated asset rules and scanner.
 * The scanner is built the way the worker builds it; when the configured one
 * cannot be built here (Scanii without its key on this service), uploads are
 * refused — never stored unscanned.
 */
async function checked(
  workspaceId: string,
  file: File,
): Promise<
  | { ok: true; bytes: Uint8Array; extension: string; contentType: string }
  | {
      ok: false;
      reason: PictureOutcome;
    }
> {
  if (!(file instanceof File) || file.size === 0) return { ok: false, reason: 'picture-missing' };
  const policy = await inWorkspace(workspaceId, ({ db }) =>
    new TenantAssetPolicySource(db, currentEnvironment()).load(),
  );
  // Refuse a file past the ceiling before reading it.
  if (file.size > maxBytesForKind(policy.upload, 'IMAGE')) {
    return { ok: false, reason: 'picture-too-large' };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let scanner;
  try {
    scanner = createVirusScanner({
      appEnv: process.env['APP_ENV'] ?? 'development',
      policy: policy.scanning,
      scaniiCredentials: {
        apiKey: process.env['SCANII_API_KEY'] ?? '',
        apiSecret: process.env['SCANII_API_SECRET'] ?? '',
      },
    });
  } catch (error: unknown) {
    log.warn('The malware scanner is not available to picture uploads', internalErrorFields(error));
    return { ok: false, reason: 'picture-unavailable' };
  }
  const result = await checkPicture({ bytes, declaredMimeType: file.type, policy, scanner });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, bytes, extension: result.extension, contentType: result.contentType };
}

/** The signed-in person's new avatar (or none). Audited in their current workspace. */
export async function setOwnAvatar(input: {
  readonly userId: string;
  readonly workspaceId: string;
  readonly file: File | null;
}): Promise<PictureOutcome | null> {
  const before = await getPrisma().user.findUniqueOrThrow({
    where: { id: input.userId },
    select: { avatarKey: true },
  });
  let key: string | null = null;
  if (input.file) {
    const result = await checked(input.workspaceId, input.file);
    if (!result.ok) return result.reason;
    key = avatarObjectKey(input.userId, result.extension);
    await objectStore().put(key, result.bytes, result.contentType);
  }
  await getPrisma().user.update({
    where: { id: input.userId },
    data: { avatarKey: key, avatarUpdatedAt: key ? systemClock.now() : null },
  });
  await inWorkspace(input.workspaceId, ({ db }) =>
    writeAuditEvent(db, input.workspaceId, {
      actorType: 'USER',
      actorId: input.userId,
      action: key ? 'user.avatar.updated' : 'user.avatar.removed',
      resourceType: 'User',
      resourceId: input.userId,
    }),
  );
  if (before.avatarKey)
    await objectStore()
      .delete(before.avatarKey)
      .catch(() => undefined);
  return null;
}

/** The workspace's new logo (or none). The caller checked `workspace.manage`. */
export async function setWorkspaceLogo(input: {
  readonly actorUserId: string;
  readonly workspaceId: string;
  readonly file: File | null;
}): Promise<PictureOutcome | null> {
  let key: string | null = null;
  let bytes: { bytes: Uint8Array; contentType: string } | null = null;
  if (input.file) {
    const result = await checked(input.workspaceId, input.file);
    if (!result.ok) return result.reason;
    key = workspaceLogoObjectKey(input.workspaceId, result.extension);
    bytes = { bytes: result.bytes, contentType: result.contentType };
  }
  if (key && bytes) await objectStore().put(key, bytes.bytes, bytes.contentType);
  const previous = await inWorkspace(input.workspaceId, async ({ db }) => {
    const row = await db.workspace.findUniqueOrThrow({
      where: { id: input.workspaceId },
      select: { logoKey: true },
    });
    await db.workspace.update({
      where: { id: input.workspaceId },
      data: { logoKey: key, logoUpdatedAt: key ? systemClock.now() : null },
    });
    await writeAuditEvent(db, input.workspaceId, {
      actorType: 'USER',
      actorId: input.actorUserId,
      action: key ? 'workspace.logo.updated' : 'workspace.logo.removed',
      resourceType: 'Workspace',
      resourceId: input.workspaceId,
    });
    return row.logoKey;
  });
  if (previous)
    await objectStore()
      .delete(previous)
      .catch(() => undefined);
  return null;
}
