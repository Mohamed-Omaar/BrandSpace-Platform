import { NextResponse } from 'next/server';
import { accountingCsv, accountingJson } from '@brandspace/billing';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { resolveApiWorkspace } from '../../../../server/customer-context';
import { accountingExportFor } from '../../../../server/commerce-context';

export const dynamic = 'force-dynamic';

const log = createLogger({ context: { component: 'dashboard.accounting-export' } });

/** A year is the longest period an accountant asks for in one file. */
const MAX_PERIOD_DAYS = 400;

/**
 * THE ACCOUNTING EXPORT — Phase 10 §24.
 *
 * WHAT IT HANDS OVER. Invoices, the credit notes that reduce them and the
 * payments that settled them, as CSV or JSON, built from the canonical billing
 * record. That is what a bookkeeper, an accounting package or a filing agent
 * needs, and what a customer currently has to screenshot.
 *
 * IT ENCODES NO JURISDICTION'S TAX LAW. There is no VAT return in here and no
 * government envelope. What an invoice was taxed at, under which policy, and
 * with which party tax numbers was recorded when it was issued; this exports
 * those facts as explicit columns that a market which does not use them simply
 * leaves empty. Turning them into a particular government's form is an
 * integration against that government, and belongs with that decision.
 *
 * THE PERIOD IS REQUIRED AND BOUNDED. An unbounded export of a commercial
 * record is a query nobody bounded and a report nobody asked for.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';

  try {
    /*
     * `billing.read` — the same authority the Billing screen needs. An export
     * is the same data in a different shape, so it must not be reachable by
     * anybody who cannot already see it on screen.
     */
    const session = await resolveApiWorkspace('billing.read');
    if (!session) return NextResponse.json({ error: 'UNAUTHENTICATED' }, { status: 401 });

    const from = parseDay(url.searchParams.get('from'));
    const to = parseDay(url.searchParams.get('to'), true);
    if (!from || !to) {
      return NextResponse.json(
        { error: 'VALIDATION_FAILED', detail: 'from and to are required, as YYYY-MM-DD.' },
        { status: 422 },
      );
    }
    if (to.getTime() < from.getTime()) {
      return NextResponse.json(
        { error: 'VALIDATION_FAILED', detail: 'The end of the period is before its start.' },
        { status: 422 },
      );
    }
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    if (days > MAX_PERIOD_DAYS) {
      return NextResponse.json(
        { error: 'VALIDATION_FAILED', detail: `Export at most ${MAX_PERIOD_DAYS} days at a time.` },
        { status: 422 },
      );
    }

    const rows = await accountingExportFor(session.workspace.workspaceId, { from, to });
    const stem = `accounting-${from.toISOString().slice(0, 10)}-to-${to.toISOString().slice(0, 10)}`;

    if (format === 'json') {
      return new NextResponse(accountingJson(rows), {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="${stem}.json"`,
          'cache-control': 'private, no-store',
        },
      });
    }

    return new NextResponse(
      /*
       * A UTF-8 BOM. Several spreadsheet applications open a CSV without one in
       * the system's legacy encoding, which turns every Arabic legal name into
       * mojibake — on a file whose whole purpose is to be opened in one of them.
       */
      '﻿' + accountingCsv(rows),
      {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${stem}.csv"`,
          'cache-control': 'private, no-store',
        },
      },
    );
  } catch (error: unknown) {
    log.error('accounting export failed', internalErrorFields(error));
    return NextResponse.json({ error: 'INTERNAL' }, { status: 500 });
  }
}

/**
 * Parse a `YYYY-MM-DD` day into an instant.
 *
 * `endOfDay` matters: an export "to 2026-03-31" that stopped at midnight would
 * silently drop every invoice issued on the last day of the quarter.
 */
function parseDay(value: string | null, endOfDay = false): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
