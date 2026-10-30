import type { FastifyInstance } from 'fastify';
import { ConfigurationService } from '@brandspace/config';
import { getPlatformClient } from '@brandspace/database/platform';
import { route } from '../route-contract';
import { currentEnvironment } from './phase7-context';

/**
 * THE ACTIVE LOOK & FEEL THEME (LF), for the customer application's
 * stylesheet route.
 *
 * Public on purpose: the theme is the look every visitor's page already
 * draws — colours, a radius, a font — so this says nothing a page's own CSS
 * does not. It returns the active LOOK only: never the owner's saved presets,
 * never a draft. The configuration service caches it for 30 s, so an
 * activation in the Control Center is on every page within a minute. Reading
 * it here is what keeps the theme out of the customer database role's reach
 * without a schema change (`configuration_version` stays platform-only).
 */
let configuration: ConfigurationService | null = null;

export function registerThemeRoutes(app: FastifyInstance): void {
  route(app, 'GET', '/v1/theme', { scope: 'public' }, async (_req, reply) => {
    configuration ??= new ConfigurationService({ prisma: getPlatformClient() });
    const theme = await configuration.get('theme', currentEnvironment());
    return reply
      .header('cache-control', 'public, max-age=30')
      .send({ look: theme.look, controlCenterOriginal: theme.controlCenterOriginal });
  });
}
