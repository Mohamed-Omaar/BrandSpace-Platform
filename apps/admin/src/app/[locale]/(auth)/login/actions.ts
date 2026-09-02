'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { PLATFORM_REALM } from '@brandspace/auth';
import { withSpan } from '@brandspace/observability';
import { getPlatformAuth } from '../../../../server/platform-context';

/**
 * Password step. Server action — the credential never reaches client JavaScript,
 * and the resulting session is unusable until MFA is verified.
 */
export async function signInAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  let destination: string;
  try {
    const result = await withSpan(
      'platform.auth.password',
      { 'auth.realm': 'platform', 'auth.step': 'password' },
      async () => getPlatformAuth().authenticateWithPassword({ email, password }),
    );

    const store = await cookies();
    store.set(PLATFORM_REALM.cookieName, result.session.token, {
      httpOnly: true,
      secure: true,
      sameSite: PLATFORM_REALM.sameSite,
      path: '/',
      expires: result.session.expiresAt,
    });
    destination = `/${locale}/mfa`;
  } catch {
    // Deliberately uniform: never reveal whether the account exists.
    destination = `/${locale}/login?error=1`;
  }
  redirect(destination);
}
