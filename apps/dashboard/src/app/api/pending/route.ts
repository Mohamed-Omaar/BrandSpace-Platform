import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { brandIdQueryFilter, createLogger, internalErrorFields } from '@brandspace/shared';
import {
  holdsPermission,
  inWorkspace,
  resolveApiWorkspace,
} from '../../../server/customer-context';

export const dynamic = 'force-dynamic';

const log = createLogger({ context: { component: 'dashboard.pending' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 50;
const READING_STAGES = ['QUEUED', 'EXTRACTING', 'CHUNKING', 'EXTRACTING_FACTS'] as const;

const idsOf = (value: string | null): string[] =>
  [...new Set((value ?? '').split(',').filter((id) => UUID.test(id)))].slice(0, MAX_IDS);

/**
 * B1 (performance) — IS IT STILL GOING? A small answer for `PendingWatch`,
 * instead of re-rendering a whole page every few seconds to find out.
 *
 * `?assets=<id,…>` — a media file still uploading, processing or waiting for
 * its scan. `?sources=<id,…>` — a Brand Brain source still being read. The
 * answer is `{ pending: { <id>: true | false } }`; an id this member cannot
 * see, or that is gone, answers `false` (done), which is the same as a
 * finished one, so nothing about another workspace or brand is told.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveApiWorkspace();
    if (!session) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    const params = new URL(request.url).searchParams;
    const assets = holdsPermission(session.workspace, 'assets.read')
      ? idsOf(params.get('assets'))
      : [];
    const sources = holdsPermission(session.workspace, 'brand_brain.read')
      ? idsOf(params.get('sources'))
      : [];
    const scope = brandIdQueryFilter({ brandScope: session.workspace.brandScope });
    const pending = await inWorkspace(session.workspace.workspaceId, async ({ db }) => {
      const [assetRows, sourceRows] = await Promise.all([
        assets.length > 0
          ? db.asset.findMany({
              where: {
                id: { in: assets },
                deletedAt: null,
                OR: [{ status: { in: ['UPLOADING', 'PROCESSING'] } }, { scanStatus: 'PENDING' }],
              },
              select: { id: true, brandId: true },
            })
          : [],
        sources.length > 0
          ? db.brandSourceDocument.findMany({
              where: {
                id: { in: sources },
                deletedAt: null,
                ...scope,
                OR: [
                  { status: { in: ['UPLOADED', 'PROCESSING'] } },
                  { ingestionJobs: { some: { stage: { in: [...READING_STAGES] } } } },
                ],
              },
              select: { id: true },
            })
          : [],
      ]);
      const brandScope = session.workspace.brandScope;
      const going = new Set([
        // A workspace-level file (no brand) is everyone's; a brand's, only in scope.
        ...assetRows
          .filter(
            (row) =>
              brandScope.length === 0 || row.brandId === null || brandScope.includes(row.brandId),
          )
          .map((row) => row.id),
        ...sourceRows.map((row) => row.id),
      ]);
      return Object.fromEntries([...assets, ...sources].map((id) => [id, going.has(id)]));
    });
    return NextResponse.json({ pending }, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error: unknown) {
    unstable_rethrow(error);
    log.error('pending status failed', internalErrorFields(error));
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
