'use server';

import { redirect } from 'next/navigation';
import { requireWorkspace } from '../../../server/customer-context';
import { setOwnAvatar } from '../../../server/pictures';

/**
 * PR D (D-609) — saving and removing a person's own photo. The person and the
 * workspace come from the session; the form supplies only the file. Audited
 * (`user.avatar.*`) without the bytes. The business logo is a field of the
 * General settings form (`saveSettingsAction`).
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
