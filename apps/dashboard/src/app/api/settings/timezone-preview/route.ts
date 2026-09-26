import { NextResponse } from 'next/server';
import {
  TenantContentPolicySource,
  isKnownTimeZone,
  timezoneChangeEffects,
} from '@brandspace/content';
import { createLogger, internalErrorFields, systemClock } from '@brandspace/shared';
import {
  currentEnvironment,
  inWorkspace,
  resolveApiWorkspace,
} from '../../../../server/customer-context';

export const dynamic = 'force-dynamic';

const log = createLogger({ context: { component: 'dashboard.timezone-preview' } });

/**
 * WHAT CHANGING THE TIME ZONE WOULD DO — before it is saved (G5 / Q22, D-334).
 *
 * Settings → General asks this when the time zone field changes, and lists
 * the posts that could not keep their local time (in the past, or inside the
 * minimum lead time) and would go back to planned. Read-only: nothing moves
 * until the form is saved, and the save recomputes the same answer inside its
 * own transaction rather than trusting this one.
 *
 * `workspace.update` — the same authority the General form needs. A post's
 * title is shown only to somebody who could already open Settings; a zone that
 * is not a zone is refused rather than answered.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveApiWorkspace('workspace.update');
    if (!session) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    const zone = new URL(request.url).searchParams.get('zone') ?? '';
    if (!isKnownTimeZone(zone)) {
      return NextResponse.json({ error: 'VALIDATION_FAILED' }, { status: 422 });
    }
    const workspaceId = session.workspace.workspaceId;
    const effects = await inWorkspace(workspaceId, async ({ db }) => {
      const policy = await new TenantContentPolicySource(db, currentEnvironment()).load();
      return timezoneChangeEffects(db, {
        workspaceId,
        toZone: zone,
        now: systemClock.now(),
        minLeadMinutes: policy.calendar.minLeadMinutes,
      });
    });
    return NextResponse.json(
      {
        kept: effects.filter((effect) => effect.outcome === 'kept').length,
        unplanned: effects
          .filter((effect) => effect.outcome === 'unplanned')
          .map((effect) => ({ title: effect.title, localTime: effect.localTime })),
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (error: unknown) {
    log.warn('timezone preview failed', internalErrorFields(error));
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
