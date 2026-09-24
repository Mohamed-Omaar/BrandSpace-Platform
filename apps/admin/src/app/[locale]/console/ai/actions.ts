'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { AiRoutingProfile } from '@brandspace/ai-gateway';
import { createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { withSpan } from '@brandspace/observability';
import { requirePlatformActor } from '../../../../server/platform-context';
import { proposeAndActivate, refusalCode } from '../../../../server/simple-config';

const log = createLogger({ context: { component: 'admin.ai.profile' } });

const PROFILES: readonly AiRoutingProfile[] = ['economy', 'balanced', 'premium', 'custom'];

/**
 * Change the active AI profile — the one Simple-mode write that had no action
 * at all (D-312).
 *
 * It is `activeProfile` in `ai.capability-routing`, changed through the
 * existing lifecycle by `proposeAndActivate`: draft, validate, preview,
 * activate. BOTH configuration authorities are required, because this both
 * drafts and activates; `ConfigurationService` re-checks each.
 */
export async function setAiProfileAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? '') === 'ar' ? 'ar' : 'en';
  const raw = String(formData.get('profile') ?? '');
  const profile = PROFILES.find((candidate) => candidate === raw) ?? null;
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    await requirePlatformActor('platform.configuration.activate');
    if (!profile) throw new Error('Unknown profile.');
    await withSpan('admin.ai.profile', { 'ai.profile': profile }, async () =>
      proposeAndActivate<{ activeProfile: AiRoutingProfile }>({
        actor,
        domain: 'ai.capability-routing',
        reason: String(formData.get('reason') ?? ''),
        acknowledged: formData.get('confirm') === 'yes',
        unchanged: (active) => active.activeProfile === profile,
        change: (active) => ({ ...active, activeProfile: profile }),
      }),
    );
    destination = `/${locale}/console/ai?ok=PROFILE_ACTIVATED&profile=${profile}`;
  } catch (error: unknown) {
    const refusal = refusalCode(error);
    if (refusal) {
      destination = `/${locale}/console/ai/profile?error=${refusal}`;
    } else {
      const correlationId = randomUUID();
      log.error('AI profile change failed', { correlationId, ...internalErrorFields(error) });
      destination = `/${locale}/console/ai/profile?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
    }
  }
  revalidatePath(`/${locale}/console/ai`);
  redirect(destination);
}
