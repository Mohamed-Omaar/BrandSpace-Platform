'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { PLATFORM_REALM } from '@brandspace/auth';
import { withSpan } from '@brandspace/observability';
import { getPlatformAuth } from '../../../../server/platform-context';

/**
 * MFA step. Only this makes a platform session usable — D-27.
 */
export async function verifyMfaAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const code = String(formData.get('code') ?? '');

  const store = await cookies();
  const token = store.get(PLATFORM_REALM.cookieName)?.value;
  if (!token) redirect(`/${locale}/login`);

  let destination: string;
  try {
    await withSpan(
      'platform.auth.mfa',
      { 'auth.realm': 'platform', 'auth.step': 'mfa' },
      async () => getPlatformAuth().verifyMfa({ token, code }),
    );
    destination = `/${locale}/console`;
  } catch {
    destination = `/${locale}/mfa?error=1`;
  }
  redirect(destination);
}
