'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { randomUUID } from 'node:crypto';
import { buildSecretRef, isSecretCategory } from '@brandspace/secrets';
import { AppError, createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { withSpan } from '@brandspace/observability';
import {
  currentEnvironment,
  getSecretService,
  requirePlatformActor,
  serviceActor,
} from '../../../../server/platform-context';

const log = createLogger({ context: { component: 'admin.secrets' } });

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

/**
 * Turn any failure into a redirect that carries a CODE, never a message.
 *
 * The previous `safeMessage()` returned `error.message` verbatim. On this page
 * of all pages that is unacceptable: the errors here come from the vault, the
 * encryption layer and provider adapters, and their messages carry secret refs,
 * connection strings and constraint names. The detail is logged once, redacted,
 * against a correlation id.
 */
function failure(locale: string, error: unknown): string {
  const correlationId = randomUUID();
  log.error('secret action failed', { correlationId, ...internalErrorFields(error) });
  return backTo(locale, { error: toPublicErrorCode(error), ref: correlationId });
}

export async function createSecretAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'ar');
  const name = String(formData.get('name') ?? '');
  const category = String(formData.get('category') ?? '');
  const provider = String(formData.get('provider') ?? '');
  const value = String(formData.get('value') ?? '');
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.secret.manage');
    if (!isSecretCategory(category)) {
      // Attacker-controllable input never travels back in a URL.
      throw new AppError('VALIDATION_FAILED', 'Unknown secret category.');
    }
    const environment = currentEnvironment();
    const ref = buildSecretRef({ category, provider, environment, name });

    await withSpan(
      'secret.create',
      // The ref and category are safe; the value is deliberately absent.
      { 'secret.ref': ref, 'secret.category': category, 'secret.environment': environment },
      async () =>
        getSecretService().createSecret(serviceActor(actor), {
          ref,
          name,
          category,
          environment,
          value,
        }),
    );
    // A code, not the submitted name: nothing user-supplied is reflected back.
    destination = backTo(locale, { ok: 'SECRET_STORED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
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
    const actor = await requirePlatformActor('platform.secret.manage');
    await withSpan('secret.rotate', { 'secret.id': secretId }, async () =>
      getSecretService().rotateSecret(serviceActor(actor), secretId, value, reason),
    );
    destination = backTo(locale, { ok: 'SECRET_ROTATED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
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
    const actor = await requirePlatformActor('platform.secret.manage');
    await withSpan('secret.disable', { 'secret.id': secretId }, async () =>
      getSecretService().disableSecret(serviceActor(actor), secretId, reason),
    );
    destination = backTo(locale, { ok: 'SECRET_DISABLED' });
  } catch (error: unknown) {
    destination = failure(locale, error);
  }
  revalidatePath(`/${locale}/console/secrets`);
  redirect(destination);
}
