import { NextResponse } from 'next/server';
import { probeDatabaseReadiness } from '@brandspace/database';
import { getPlatformClient } from '@brandspace/database/platform';
import { createLogger } from '@brandspace/shared';

export const dynamic = 'force-dynamic';

const log = createLogger({ context: { component: 'admin.readiness' } });

/**
 * READINESS FOR RAILWAY'S HEALTHCHECK (docs/RAILWAY-DEPLOYMENT.md §4.4).
 *
 * 200 only when the PLATFORM database identity answers AND it has every migration this
 * build was made with; 503 otherwise. Railway sends traffic to a new
 * deployment only once its healthcheck passes, so while `migration-staging`
 * is still applying this release's migrations the previous deployment keeps
 * serving — and no operator request reaches code that reads a column the
 * database does not have yet. The Control Center reads every tenant table,
 * so it is as exposed to a half-applied release as the customer dashboard.
 *
 * It replaces `/en/login`, which only proved that Next.js could render a page.
 *
 * PUBLIC AND DETAIL-FREE, like the api's `/health/ready`: one word per check.
 * The pending migration names are logged for the operator, never returned.
 * Outside the locale redirect: the middleware passes `/api/*` through.
 */
export async function GET(): Promise<NextResponse> {
  const probe = await probeDatabaseReadiness(getPlatformClient());
  if (probe.schema === 'pending') {
    log.warn('not ready: migrations pending', {
      pending: probe.pending.length,
      next: probe.pending[0],
    });
  }
  return NextResponse.json(
    {
      status: probe.ready ? 'ready' : 'not_ready',
      checks: [
        { name: 'database', state: probe.database },
        {
          name: 'schema',
          state: probe.schema === 'ok' ? 'ok' : probe.schema === 'pending' ? 'down' : 'unknown',
        },
      ],
    },
    { status: probe.ready ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
