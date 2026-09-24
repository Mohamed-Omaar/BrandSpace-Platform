import { AppError } from '@brandspace/shared';
import type { ConfigDomain } from '@brandspace/config';
import { currentEnvironment, getConfigService, serviceActor } from './platform-context';

type Actor = Parameters<typeof serviceActor>[0];

/**
 * ONE DELIBERATE CONFIGURATION CHANGE, THROUGH THE EXISTING LIFECYCLE (D-312).
 *
 * The Simple screens that change a whole setting at once — the AI profile, who
 * gets a feature — do it with the SAME four `ConfigurationService` calls the
 * Configuration page makes, in order: create a draft, validate it, preview its
 * impact, activate it. Nothing is skipped and nothing is written around the
 * service, so the change still has an author, a reason, a validation pass, an
 * impact preview, an audit event, a version history and a rollback.
 *
 * WHAT MAKES IT DELIBERATE rather than a decorative switch: the screen shows
 * the plain-language consequence first, and the owner submits a reason and an
 * explicit confirmation; `acknowledged` is passed to `activate` as the
 * high-impact acknowledgement and is never defaulted to true here.
 *
 * TWO REFUSALS, both before anything is written:
 *   - someone else's unfinished draft of the same setting is open. Activating
 *     ours would silently supersede the ground it was drafted on, and folding
 *     ours into theirs would activate edits nobody reviewed here. The owner is
 *     sent to finish or discard it instead (`DRAFT_OPEN`).
 *   - the change is a no-op (`UNCHANGED`), so no empty version is minted.
 *
 * AND ONE CLEAN-UP: a draft that fails validation or activation is discarded,
 * so a refused change never lingers as a pending item for the next person.
 */
export async function proposeAndActivate<T extends Record<string, unknown>>(input: {
  readonly actor: Actor;
  readonly domain: ConfigDomain;
  readonly reason: string;
  readonly acknowledged: boolean;
  /** Build the next document from the ACTIVE one. */
  readonly change: (active: T) => T;
  /** True when the change would leave the active document as it is. */
  readonly unchanged: (active: T) => boolean;
}): Promise<{ readonly versionId: string }> {
  const { actor, domain } = input;
  const config = getConfigService();
  const environment = currentEnvironment();
  const reason = input.reason.trim();
  const service = serviceActor(actor);

  if (reason.length < 8) {
    throw new AppError(
      'VALIDATION_FAILED',
      'A change reason of at least eight characters is required.',
    );
  }
  if (!input.acknowledged) {
    throw new AppError('VALIDATION_FAILED', 'The change must be confirmed before it is activated.');
  }

  const versions = await config.listVersions(service, domain, environment);
  if (versions.some((version) => version.status === 'DRAFT' || version.status === 'VALIDATED')) {
    throw new AppError('CONFLICT', 'DRAFT_OPEN');
  }

  const active = (await config.get(domain, environment)) as unknown as T;
  if (input.unchanged(active)) throw new AppError('CONFLICT', 'UNCHANGED');

  const draft = await config.createDraft(
    service,
    domain,
    environment,
    reason,
    input.change(structuredClone(active)),
  );
  try {
    const report = await config.validateDraft(service, draft.id);
    if (!report.valid) {
      throw new AppError(
        'VALIDATION_FAILED',
        report.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => issue.message)
          .join(' '),
      );
    }
    await config.previewImpact(service, draft.id);
    await config.activate(service, draft.id, { acknowledgeHighImpact: input.acknowledged });
  } catch (error: unknown) {
    await config
      .discardDraft(service, draft.id, 'Refused before activation; discarded by the Simple screen.')
      .catch(() => undefined);
    throw error;
  }
  return { versionId: draft.id };
}

/** The stable code a Simple screen shows for a refusal from the helper above. */
export function refusalCode(error: unknown): string | null {
  if (error instanceof AppError && error.code === 'CONFLICT') {
    if (error.message === 'DRAFT_OPEN' || error.message === 'UNCHANGED') return error.message;
  }
  return null;
}

export interface OpenDraft {
  readonly id: string;
  readonly domain: ConfigDomain;
  readonly versionNumber: number;
  readonly changeReason: string;
  readonly createdAt: Date;
}

/**
 * The unfinished drafts of the given settings — what `proposeAndActivate`
 * would refuse over. A Simple screen shows them BEFORE the owner starts a
 * change, rather than after a refusal.
 */
export async function loadOpenDrafts(
  actor: Actor,
  domains: readonly ConfigDomain[],
): Promise<readonly OpenDraft[]> {
  const config = getConfigService();
  const environment = currentEnvironment();
  const perDomain = await Promise.all(
    domains.map(async (domain) =>
      (await config.listVersions(serviceActor(actor), domain, environment))
        .filter((version) => version.status === 'DRAFT' || version.status === 'VALIDATED')
        .map((version) => ({
          id: version.id,
          domain,
          versionNumber: version.versionNumber,
          changeReason: version.changeReason,
          createdAt: version.createdAt,
        })),
    ),
  );
  return perDomain.flat();
}
