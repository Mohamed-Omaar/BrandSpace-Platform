import 'server-only';
import type { AuthenticatedPlatformActor } from '@brandspace/auth';
import { currentEnvironment, getConfigService, serviceActor } from './platform-context';

/**
 * The theme version that was active before the current one, if any — what
 * "Undo" on the Look & feel page rolls back to (LF). Not a server action: it
 * takes an already-resolved actor and is only called by the page and its own
 * actions.
 */
export async function previousThemeVersion(
  actor: AuthenticatedPlatformActor,
): Promise<string | null> {
  const versions = await getConfigService().listVersions(
    serviceActor(actor),
    'theme',
    currentEnvironment(),
  );
  const superseded = versions
    .filter((v) => v.status === 'SUPERSEDED')
    .sort((a, b) => b.versionNumber - a.versionNumber);
  return superseded[0]?.id ?? null;
}
