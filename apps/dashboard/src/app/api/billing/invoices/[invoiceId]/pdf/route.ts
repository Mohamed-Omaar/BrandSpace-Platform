import { NextResponse } from 'next/server';
import { DeterministicPdfRenderer, renderRefusal, type DocumentLocale } from '@brandspace/billing';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { resolveApiWorkspace } from '../../../../../../server/customer-context';
import { invoiceDocumentFor } from '../../../../../../server/commerce-context';

export const dynamic = 'force-dynamic';

const log = createLogger({ context: { component: 'dashboard.invoice-pdf' } });

/**
 * The invoice as PDF BYTES — Phase 10 §23.
 *
 * WHO THIS IS FOR. A person wanting a document should open the document page
 * and print it: the browser has a licensed Arabic font and a shaping engine,
 * and produces the correct bilingual result. This route exists for the case a
 * page cannot serve — a system that wants a file, an attachment, an archive.
 *
 * IT REFUSES ARABIC RATHER THAN DRAWING BOXES. The built-in renderer uses
 * Helvetica, one of the fourteen fonts every PDF reader provides, which has no
 * Arabic glyphs at all. A PDF full of empty rectangles looks like a document
 * until somebody opens it, so the refusal is explicit and says where to get the
 * Arabic version. D-216 records what the owner must decide to change this.
 *
 * AN INVOICE FROM ANOTHER WORKSPACE IS A 404, indistinguishable from an id that
 * never existed: the lookup is tenant-scoped and RLS refuses it besides.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ invoiceId: string }> },
): Promise<NextResponse> {
  const { invoiceId } = await context.params;
  const url = new URL(request.url);
  const locale: DocumentLocale = url.searchParams.get('locale') === 'ar' ? 'ar' : 'en';

  try {
    const session = await resolveApiWorkspace('billing.read');
    if (!session) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });
    const document = await invoiceDocumentFor(session.workspace.workspaceId, invoiceId);
    if (!document) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });

    const renderer = new DeterministicPdfRenderer();
    const refusal = renderRefusal(renderer, locale);
    if (refusal) {
      // 409, not 500: nothing failed. The platform is declining to produce a
      // document it cannot set correctly, and the body says what to do instead.
      return NextResponse.json(
        { error: 'RENDERER_CANNOT_SET_LOCALE', detail: refusal },
        { status: 409 },
      );
    }

    const rendered = await renderer.render(document, locale);
    return new NextResponse(Buffer.from(rendered.body), {
      status: 200,
      headers: {
        'content-type': rendered.contentType,
        // ASCII only, so no download path has to negotiate RFC 5987 encoding.
        'content-disposition': `attachment; filename="${rendered.filename}"`,
        // An invoice is a commercial document about one customer.
        'cache-control': 'private, no-store',
      },
    });
  } catch (error: unknown) {
    log.error('invoice pdf failed', internalErrorFields(error));
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}
