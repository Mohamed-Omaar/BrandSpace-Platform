/**
 * WHICH DEPLOYMENT IS THIS — Phase 10 §18.
 *
 * ONE ANSWER, IN ONE PLACE. This function existed twelve times across the API,
 * the worker, the dashboard and the admin console, each a private copy of the
 * same four lines. They agreed, but nothing made them agree — and Phase 10's
 * central production rule ("no development adapter may silently become
 * production configuration") is only as strong as the weakest copy of the
 * question it depends on. A rule enforced in twelve places is enforced in the
 * one that was missed.
 *
 * `APP_ENV`, NOT `NODE_ENV`, and that is not a preference (D-97). Every built
 * Next.js app sets `NODE_ENV=production` — including the one the E2E suite
 * serves and the one a developer runs to check a bundle. Keying a production
 * guard on `NODE_ENV` therefore fires in development, which is how the
 * filesystem object store once became unavailable to every built app and broke
 * a screen before it rendered. `APP_ENV` means "which deployment is this", and
 * that is the question every caller here is actually asking.
 */

export const DEPLOYMENT_ENVIRONMENTS = ['DEVELOPMENT', 'STAGING', 'PRODUCTION'] as const;

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

/**
 * The deployment this process is part of.
 *
 * DEFAULTS TO `DEVELOPMENT`, which is the safe direction: an unset variable
 * makes the platform MORE cautious about what it will do, never less. A default
 * of `PRODUCTION` would refuse development doubles on a laptop; a default of
 * development refuses nothing that production would allow.
 */
export function currentEnvironment(
  source: Record<string, string | undefined> = process.env,
): DeploymentEnvironment {
  const appEnv = source['APP_ENV'] ?? 'development';
  if (appEnv === 'production') return 'PRODUCTION';
  if (appEnv === 'staging') return 'STAGING';
  return 'DEVELOPMENT';
}

export function isProduction(source?: Record<string, string | undefined>): boolean {
  return currentEnvironment(source) === 'PRODUCTION';
}

/**
 * A development double was asked to run somewhere it must not.
 *
 * ITS OWN CLASS so the refusal is recognisable at a catch site and in a log,
 * and so a test can assert the KIND of failure rather than matching a sentence.
 */
export class DevelopmentOnlyInProductionError extends Error {
  readonly component: string;

  constructor(component: string, remedy: string) {
    super(`${component} is a development double and must never run in production. ${remedy}`);
    this.name = 'DevelopmentOnlyInProductionError';
    this.component = component;
  }
}

/**
 * Refuse to construct or register a development double in production.
 *
 * THROWS RATHER THAN RETURNING A FLAG, and the throw is the design. A boolean
 * gets ignored by the third caller; an exception at construction means a
 * deployment that reached for a mock fails at start-up, loudly, with the name
 * of the component and what to do instead — rather than coming up healthy and
 * serving invented content, publishing into the void, or reporting mail as sent.
 *
 * @param component what is being refused, named the way an operator would say it
 * @param remedy    what to configure instead — always actionable, never "see docs"
 */
export function assertNotProduction(
  component: string,
  remedy: string,
  source?: Record<string, string | undefined>,
): void {
  if (!isProduction(source)) return;
  throw new DevelopmentOnlyInProductionError(component, remedy);
}
