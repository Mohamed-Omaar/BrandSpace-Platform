import { NextResponse } from 'next/server';
import { isAppError, systemClock } from '@brandspace/shared';
import { requireWorkspace } from '../../../../server/customer-context';
import { inAnalytics } from '../../../../server/analytics-context';

/**
 * TENANT-SAFE ANALYTICS EXPORT.
 *
 * A ROUTE HANDLER RATHER THAN A SERVER ACTION, because the answer is a FILE: a
 * server action returns a React result, and streaming a download through one
 * means base64 in a payload the browser then has to reassemble.
 *
 * FOUR THINGS IT DOES BEFORE A BYTE IS WRITTEN:
 *
 *  1. `requireWorkspace(locale, 'analytics.export')` — the permission is checked
 *     by the same helper every other page uses, and a member without it gets the
 *     404 a missing route gives. `analytics.export` is separate from
 *     `analytics.read` on purpose: a file leaves the product, is forwarded, and
 *     outlives every permission change afterwards.
 *  2. THE WORKSPACE COMES FROM THE SESSION. There is no query parameter that
 *     could name one.
 *  3. BRANDSCOPE IS A QUERY PREDICATE inside the export service, so a
 *     brand-restricted member's file contains only their own brands' rows — and
 *     the rows are never fetched, rather than fetched and dropped.
 *  4. THE WINDOW AND THE ROW COUNT ARE BOUNDED by the activated policy, and a
 *     request past either is refused with the ceiling rather than silently
 *     truncated into a file that looks complete.
 *
 * `Content-Disposition: attachment` WITH A SERVER-BUILT FILENAME. Nothing from
 * the query string reaches it: a filename assembled from customer input is a
 * header-injection and a path-traversal in one.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ locale: string }> },
): Promise<Response> {
  const { locale } = await params;
  const session = await requireWorkspace(locale, 'analytics.export');

  const url = new URL(request.url);
  const brandId = url.searchParams.get('brand');
  const days = Number(url.searchParams.get('range') ?? '28');
  const range = [7, 28, 90].includes(days) ? days : 28;

  const now = systemClock.now();
  const period = { start: new Date(now.getTime() - range * 86_400_000), end: now };

  try {
    const result = await inAnalytics(session.workspace.workspaceId, async (services) => {
      const exporter = await services.exports();
      return {
        file: await exporter.toCsv({
          scope: brandId ? { brandId } : {},
          period,
          brandScope: session.workspace.brandScope,
          actorUserId: session.customer.userId,
        }),
        filename: exporter.filenameFor(period),
      };
    });

    return new NextResponse(result.file.csv, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${result.filename}"`,
        // A download is per-customer and per-moment. Caching it anywhere is a
        // copy of one workspace's performance data in a shared store.
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (error: unknown) {
    /*
     * A STABLE CODE, NEVER A MESSAGE. The two refusals a customer can actually
     * cause — too wide a window, too many rows — carry their ceiling in the
     * body so the screen can say what the limit is.
     */
    if (isAppError(error)) {
      return NextResponse.json(
        { error: { code: error.code, details: error.publicDetails } },
        { status: error.httpStatus },
      );
    }
    return NextResponse.json({ error: { code: 'INTERNAL' } }, { status: 500 });
  }
}
