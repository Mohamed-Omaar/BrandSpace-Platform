'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { buildSecretRef, isSecretCategory } from '@brandspace/secrets';
import { withSpan } from '@brandspace/observability';
import {
  currentEnvironment,
  getSecretService,
  requirePlatformActor,
} from '../../../../server/platform-context';

/**
 * Secret server actions.
 *
 * The plaintext value exists only inside these functions, on its way to
 * `SecretService`. It is never returned, never logged, never put in a span, and
 * never placed in a redirect parameter.
 */

function backTo(locale: string, params: Record<string, string>): string {
  return `/${locale}/console/secrets?${new URLSearchParams(params).toString()}`;
}

/** Never echo the input back: a message could carry the value. */
function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

export async function createSecretAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const name = String(formData.get('name') ?? '');
  const category = String(formData.get('category') ?? '');
  const provider = String(formData.get('provider') ?? '');
  const value = String(formData.get('value') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.read');
    if (!isSecretCategory(category)) throw new Error(`Unknown category: ${category}`);
    const environment = currentEnvironment();
    const ref = buildSecretRef({ category, provider, environment, name });

    await withSpan(
      'secret.create',
      // The ref and category are safe; the value is deliberately absent.
      { 'secret.ref': ref, 'secret.category': category, 'secret.environment': environment },
      async () =>
        getSecretService().createSecret(
          {
            platformUserId: actor.platformUserId,
            roleKey: actor.roleKey,
            mfaVerified: actor.mfaVerified,
          },
          { ref, name, category, environment, value },
        ),
    );
    destination = backTo(locale, { ok: encodeURIComponent(`Secret "${name}" stored`) });
  } catch (error: unknown) {
    destination = backTo(locale, { error: encodeURIComponent(safeMessage(error)) });
  }
  revalidatePath(`/${locale}/console/secrets`);
  redirect(destination);
}

export async function rotateSecretAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const secretId = String(formData.get('secretId') ?? '');
  const value = String(formData.get('value') ?? '');
  const reason = String(formData.get('reason') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.read');
    await withSpan('secret.rotate', { 'secret.id': secretId }, async () =>
      getSecretService().rotateSecret(
        {
          platformUserId: actor.platformUserId,
          roleKey: actor.roleKey,
          mfaVerified: actor.mfaVerified,
        },
        secretId,
        value,
        reason,
      ),
    );
    destination = backTo(locale, { ok: encodeURIComponent('Secret rotated') });
  } catch (error: unknown) {
    destination = backTo(locale, { error: encodeURIComponent(safeMessage(error)) });
  }
  revalidatePath(`/${locale}/console/secrets`);
  redirect(destination);
}

export async function disableSecretAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const secretId = String(formData.get('secretId') ?? '');
  const reason = String(formData.get('reason') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.workspace.read');
    await withSpan('secret.disable', { 'secret.id': secretId }, async () =>
      getSecretService().disableSecret(
        {
          platformUserId: actor.platformUserId,
          roleKey: actor.roleKey,
          mfaVerified: actor.mfaVerified,
        },
        secretId,
        reason,
      ),
    );
    destination = backTo(locale, { ok: encodeURIComponent('Secret disabled') });
  } catch (error: unknown) {
    destination = backTo(locale, { error: encodeURIComponent(safeMessage(error)) });
  }
  revalidatePath(`/${locale}/console/secrets`);
  redirect(destination);
}
