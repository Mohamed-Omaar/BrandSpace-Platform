import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { DUPLICATE_OF_EXISTING } from '@brandspace/brand-brain';
import { brandIdQueryFilter, createLogger, internalErrorFields } from '@brandspace/shared';
import { inWorkspace, resolveApiWorkspace } from '../../../../server/customer-context';

export const dynamic = 'force-dynamic';

const log = createLogger({ context: { component: 'dashboard.brand-brain.source-status' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PR B (D-594) — WHERE ONE ADDED FILE IS, for the Copilot's Add card: its
 * stage, then the coverage line ("Read 6 pages, found 18 facts, skipped 3
 * because they are already in Brand Brain") and whether `brand.extract` read
 * it or today's extraction did. `brand_brain.read`, the caller's workspace and
 * BrandScope; anything else is the one 404 shape (CLAUDE.md §2.1). Counts and
 * a stage only — never the file's text, name or facts.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveApiWorkspace('brand_brain.read');
    if (!session) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    const id = new URL(request.url).searchParams.get('id') ?? '';
    if (!UUID.test(id)) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    const status = await inWorkspace(session.workspace.workspaceId, async ({ db }) => {
      const document = await db.brandSourceDocument.findFirst({
        where: {
          id,
          deletedAt: null,
          ...brandIdQueryFilter({ brandScope: session.workspace.brandScope }),
        },
        select: {
          status: true,
          pageCount: true,
          failureMessage: true,
          ingestionJobs: {
            orderBy: { queuedAt: 'desc' },
            take: 1,
            select: { stage: true, aiRequestId: true },
          },
        },
      });
      if (!document) return null;
      const [pending, linked] = await Promise.all([
        db.brandKnowledgeCandidate.count({ where: { sourceDocumentId: id, status: 'PENDING' } }),
        db.brandKnowledgeCandidate.count({
          where: {
            sourceDocumentId: id,
            status: 'SUPERSEDED',
            reviewReason: DUPLICATE_OF_EXISTING,
          },
        }),
      ]);
      const job = document.ingestionJobs[0];
      return {
        status: document.status,
        stage: job?.stage ?? null,
        pages: document.pageCount,
        found: pending,
        skippedDuplicates: linked,
        readBy: job?.aiRequestId ? 'brand.extract' : 'keyword',
        // PR U — the stored reason KEY (never a sentence), so the Copilot's
        // file card can say why in the reader's language.
        failureReason:
          document.status === 'FAILED' || document.status === 'QUARANTINED'
            ? document.failureMessage
            : null,
      };
    });
    if (!status) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json(status, { headers: { 'cache-control': 'private, no-store' } });
  } catch (error: unknown) {
    unstable_rethrow(error);
    log.error('source status failed', internalErrorFields(error));
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
