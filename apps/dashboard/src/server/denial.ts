import {
  AppError,
  WORKSPACE_PERMISSIONS,
  isAppError,
  isOwnerOnlyPermission,
  toPublicErrorCode,
} from '@brandspace/shared';
import { optionalMessage } from '../i18n/messages';

/**
 * DENIAL MESSAGES (A5, E6) — one place that turns "the role does not hold X"
 * into words.
 *
 * WHAT THIS IS NOT: a second permission check. Whether a member holds a key is
 * decided where it always was — the session's `permissionKeys`, read from the
 * stored role on every request, and the services behind them. This module only
 * explains a refusal that has already happened, or a control the page has
 * already chosen not to offer.
 *
 * Two shapes, because the two surfaces know different things:
 *   - A PAGE knows who is looking and who owns the business, so it says
 *     "Sara doesn't have the “Invite a member” permission … ask Omar".
 *   - An ACTION's refusal travels in the URL, where names must never go, so it
 *     carries only the permission key (`FORBIDDEN:<key>`) and the banner says
 *     "ask the owner".
 */

const WORKSPACE_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  WORKSPACE_PERMISSIONS.map((p) => p.key),
);

/** The refusal an action throws when the session's role lacks `permissionKey`. */
export function permissionDenied(permissionKey: string): AppError {
  return new AppError('FORBIDDEN', 'The role does not grant this permission.', {
    permission: permissionKey,
  });
}

/** The workspace permission a refusal names, or null for any other error. */
export function deniedPermission(error: unknown): string | null {
  if (!isAppError(error) || error.code !== 'FORBIDDEN') return null;
  const permission = error.publicDetails['permission'];
  return typeof permission === 'string' && WORKSPACE_PERMISSION_KEYS.has(permission)
    ? permission
    : null;
}

/**
 * The code an action's failure path puts in the URL. Identical to
 * `toPublicErrorCode` except that a permission refusal keeps the permission's
 * KEY — never text — so `statusMessage` can name it.
 */
export function actionErrorCode(error: unknown): string {
  const permission = deniedPermission(error);
  if (!permission) return toPublicErrorCode(error);
  return `${isOwnerOnlyPermission(permission) ? 'FORBIDDEN_OWNER' : 'FORBIDDEN'}:${permission}`;
}

export interface DenialText {
  readonly title: string;
  readonly body: string;
  readonly ownerOnly: boolean;
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce((text, [k, v]) => text.replace(`{${k}}`, v), template);
}

/**
 * "<Name> doesn't have the “X” permission. Permissions come from the role · ask
 * <owner> to change your role." — or "“X” is owner-only." (E6).
 */
export function denialText(
  locale: string,
  input: { permissionKey: string; memberName: string; ownerName: string },
): DenialText {
  const m = (key: string) => optionalMessage(locale, key) ?? '';
  const permission =
    optionalMessage(locale, `perms.desc.${input.permissionKey}`) ?? m('perms.denied.thisAction');
  const ownerOnly = isOwnerOnlyPermission(input.permissionKey);
  const body = ownerOnly
    ? fill(m('perms.denied.ownerOnly'), { permission })
    : `${fill(m('perms.denied.body'), { name: input.memberName, permission })} ${fill(
        m('perms.denied.hint'),
        { owner: input.ownerName },
      )}`;
  return { title: m('perms.denied.title'), body, ownerOnly };
}
