'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ConfigDomain } from '@brandspace/config';
import { AppError, createLogger, internalErrorFields, toPublicErrorCode } from '@brandspace/shared';
import { safeConsoleReturnPath } from '../../../../server/console-mode';
import {
  getConfigService,
  requirePlatformActor,
  serviceActor,
} from '../../../../server/platform-context';
import { loadOpenDrafts } from '../../../../server/simple-config';

const log = createLogger({ context: { component: 'admin.drafts.simple' } });

/**
 * The settings whose unfinished drafts a Simple screen may offer to discard.
 * A closed list: this is not a generic "discard any version" endpoint.
 */
const DISCARDABLE: readonly ConfigDomain[] = [
  'feature-flags',
  'entitlements',
  'ai.capability-routing',
];

/**
 * DISCARD SOMEBODY'S UNFINISHED CHANGE — deliberately, and audited (D-312).
 *
 * A Simple change refuses to run over an open draft of the same setting, and
 * for flags, entitlements and AI routing no screen offered a way to discard
 * one: the owner was told to "finish or discard it in Advanced" where only
 * finishing existed. This is the other half, through the existing
 * `ConfigurationService.discardDraft` — which requires
 * `platform.configuration.manage`, refuses the ACTIVE version, and writes
 * `config.draft.discarded` with the owner's reason. Nothing live changes.
 */
export async function discardOpenDraftsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? '') === 'ar' ? 'ar' : 'en';
  const back = safeConsoleReturnPath(locale, String(formData.get('next') ?? ''));
  const domains = formData
    .getAll('domain')
    .map(String)
    .filter((domain): domain is ConfigDomain =>
      (DISCARDABLE as readonly string[]).includes(domain),
    );
  let destination: string;

  try {
    const actor = await requirePlatformActor('platform.configuration.manage');
    const reason = String(formData.get('reason') ?? '').trim();
    if (domains.length === 0) throw new AppError('VALIDATION_FAILED', 'Nothing to discard.');
    if (reason.length < 8) {
      throw new AppError('VALIDATION_FAILED', 'A reason of at least eight characters is required.');
    }
    if (formData.get('confirm') !== 'yes') {
      throw new AppError('VALIDATION_FAILED', 'Discarding must be confirmed.');
    }
    const drafts = await loadOpenDrafts(actor, domains);
    for (const draft of drafts) {
      await getConfigService().discardDraft(serviceActor(actor), draft.id, reason);
    }
    destination = `${back}?ok=DRAFT_DISCARDED`;
  } catch (error: unknown) {
    const correlationId = randomUUID();
    log.error('discarding an open draft failed', { correlationId, ...internalErrorFields(error) });
    destination = `${back}?error=${toPublicErrorCode(error)}&ref=${correlationId}`;
  }
  revalidatePath(back);
  redirect(destination);
}
