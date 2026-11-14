'use server';

import { redirect } from 'next/navigation';
import { requireWorkspace, requireWorkspaceAction } from '../../../server/customer-context';
import { setOwnAvatar, setWorkspaceLogo } from '../../../server/pictures';

/**
 * PR D (D-607) — saving and removing a picture. The person and the workspace
 * come from the session; the form supplies only the file. The workspace logo
 * needs `workspace.update`, as the rest of the business settings do. Each
 * change is audited (`user.avatar.*`, `workspace.logo.*`) without the bytes.
 */

const localeOf = (formData: FormData) => (formData.get('locale') === 'ar' ? 'ar' : 'en');
const fileOf = (formData: FormData): File | null => {
  const value = formData.get('picture');
  return value instanceof File && value.size > 0 ? value : null;
};

function back(path: string, outcome: string | null, ok: string): never {
  redirect(`${path}?${outcome ? `error=${outcome}` : `ok=${ok}`}`);
}

export async function saveAvatarAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const { customer, workspace } = await requireWorkspace(locale);
  const file = fileOf(formData);
  const outcome = file
    ? await setOwnAvatar({ userId: customer.userId, workspaceId: workspace.workspaceId, file })
    : 'picture-missing';
  back(`/${locale}/settings/security`, outcome, 'picture-saved');
}

export async function removeAvatarAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const { customer, workspace } = await requireWorkspace(locale);
  const outcome = await setOwnAvatar({
    userId: customer.userId,
    workspaceId: workspace.workspaceId,
    file: null,
  });
  back(`/${locale}/settings/security`, outcome, 'picture-removed');
}

export async function saveWorkspaceLogoAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const { customer, workspace } = await requireWorkspaceAction(locale, 'workspace.update');
  const file = fileOf(formData);
  const outcome = file
    ? await setWorkspaceLogo({
        actorUserId: customer.userId,
        workspaceId: workspace.workspaceId,
        file,
      })
    : 'picture-missing';
  back(`/${locale}/settings`, outcome, 'picture-saved');
}

export async function removeWorkspaceLogoAction(formData: FormData): Promise<void> {
  const locale = localeOf(formData);
  const { customer, workspace } = await requireWorkspaceAction(locale, 'workspace.update');
  const outcome = await setWorkspaceLogo({
    actorUserId: customer.userId,
    workspaceId: workspace.workspaceId,
    file: null,
  });
  back(`/${locale}/settings`, outcome, 'picture-removed');
}
