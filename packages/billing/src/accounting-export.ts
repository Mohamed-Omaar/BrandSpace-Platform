import type { TenantScopedClient } from '@brandspace/database';
import { AppError, Money } from '@brandspace/shared';

/**
 * ACCOUNTING AND TAX EXPORT — Phase 10 §24.
 *
 * WHAT IT PRODUCES. Machine-readable rows built from the canonical billing
 * record — invoices, the credit notes that reduce them, and the payments that
 * settled them — so an accountant, a bookkeeping package or a filing agent can
 * be handed a file rather than a screenshot.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: encode one country's tax law as though it
 * were universal. There is no VAT return in here, no ZATCA envelope, no
 * jurisdiction-specific validation. What an invoice was taxed AT, under WHICH
 * policy, and with which party tax numbers, was recorded when it was issued;
 * this exports those facts. Turning them into a particular government's form is
 * an integration against that government's API, and belongs with that country's
 * decision rather than in the platform's core.
 *
 * THE JURISDICTION FIELDS ARE EXPLICIT COLUMNS, not assumptions. `sellerTaxId`,
 * `buyerTaxId`, `taxPolicyKey` and `taxRatePercent` are exported for every row;
 * a market that does not use one leaves it empty, rather than the exporter
 * pretending every seller has a VAT number.
 *
 * AMOUNTS ARE EXPORTED TWICE, AND THAT IS THE POINT. `totalMinor` is the exact
 * integer the platform stores, and `total` is the same value written at the
 * currency's own scale. A spreadsheet that reads the decimal and a ledger that
 * reads the integer both get the truth, and neither has to guess whether this
 * currency has two decimal places or three (D-207).
 */

export type AccountingRowKind = 'INVOICE' | 'CREDIT_NOTE' | 'PAYMENT';

export interface AccountingRow {
  readonly kind: AccountingRowKind;
  /** The invoice number for an invoice; the invoice it refers to otherwise. */
  readonly documentNumber: string;
  readonly documentId: string;
  readonly invoiceId: string;
  readonly issuedAt: string | null;
  readonly status: string;

  readonly currency: string;
  readonly currencyScale: number;
  /** Exact integer minor units, exactly as stored. */
  readonly subtotalMinor: string;
  readonly discountMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
  /** The same amounts at the currency's own scale, for a human reader. */
  readonly subtotal: string;
  readonly discount: string;
  readonly tax: string;
  readonly total: string;

  readonly taxMode: string;
  readonly taxRatePercent: string;
  readonly taxPolicyKey: string;
  readonly sellerTaxId: string;
  readonly buyerTaxId: string;
  readonly buyerCountry: string;
  readonly buyerName: string;

  /** Present on PAYMENT rows; empty elsewhere. */
  readonly providerKey: string;
  readonly providerReference: string;
}

export const ACCOUNTING_COLUMNS: readonly (keyof AccountingRow)[] = [
  'kind',
  'documentNumber',
  'documentId',
  'invoiceId',
  'issuedAt',
  'status',
  'currency',
  'currencyScale',
  'subtotalMinor',
  'discountMinor',
  'taxMinor',
  'totalMinor',
  'subtotal',
  'discount',
  'tax',
  'total',
  'taxMode',
  'taxRatePercent',
  'taxPolicyKey',
  'sellerTaxId',
  'buyerTaxId',
  'buyerCountry',
  'buyerName',
  'providerKey',
  'providerReference',
];

export interface AccountingExportQuery {
  /** Inclusive, as an ISO date. Both are required: an unbounded export of a
   * commercial record is a report nobody asked for and a query nobody bounded. */
  readonly from: Date;
  readonly to: Date;
  /** Hard ceiling, so one export cannot monopolise the database. */
  readonly limit?: number;
}

const MAX_ROWS = 10_000;

/**
 * Build the rows for one workspace and one period.
 *
 * TENANT-SCOPED THROUGH AND THROUGH. Every query names the workspace and runs
 * on the tenant client, so RLS refuses a row from another workspace even if a
 * predicate were ever dropped. An accounting export is precisely the document a
 * competitor would most like to read.
 */
export async function accountingRows(
  db: TenantScopedClient,
  workspaceId: string,
  query: AccountingExportQuery,
): Promise<readonly AccountingRow[]> {
  if (query.to.getTime() < query.from.getTime()) {
    throw new AppError('VALIDATION_FAILED', 'The end of the period is before its start.');
  }
  const take = Math.min(query.limit ?? MAX_ROWS, MAX_ROWS);

  const invoices = await db.invoice.findMany({
    where: {
      workspaceId,
      status: { not: 'DRAFT' },
      issuedAt: { gte: query.from, lte: query.to },
    },
    orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
    take,
    include: {
      creditNotes: { orderBy: { createdAt: 'asc' } },
      attempts: { where: { status: 'SUCCEEDED' }, orderBy: { attemptedAt: 'asc' } },
    },
  });

  const rows: AccountingRow[] = [];
  for (const invoice of invoices) {
    const parties = (invoice.partiesSnapshot ?? {}) as {
      seller?: { taxId?: string | null };
      buyer?: { taxId?: string | null; countryCode?: string | null; legalName?: { en?: string } };
    };
    const money = (minor: bigint): Money =>
      Money.ofMinor(invoice.currency, minor, invoice.currencyScale);

    const shared = {
      invoiceId: invoice.id,
      currency: invoice.currency,
      currencyScale: invoice.currencyScale,
      taxMode: invoice.taxMode,
      /*
       * Basis points to a percentage with two decimals — `1500` becomes
       * `15.00`. Not a float: a rate written as `0.15000000000000002` in an
       * accounting export is the kind of thing a filing agent rejects.
       */
      taxRatePercent: `${Math.trunc(invoice.taxRateBasisPoints / 100)}.${String(
        invoice.taxRateBasisPoints % 100,
      ).padStart(2, '0')}`,
      taxPolicyKey: invoice.taxPolicyKey ?? '',
      sellerTaxId: parties.seller?.taxId ?? '',
      buyerTaxId: parties.buyer?.taxId ?? '',
      buyerCountry: parties.buyer?.countryCode ?? '',
      buyerName: parties.buyer?.legalName?.en ?? '',
    };

    rows.push({
      ...shared,
      kind: 'INVOICE',
      documentNumber: invoice.number ?? '',
      documentId: invoice.id,
      issuedAt: invoice.issuedAt ? invoice.issuedAt.toISOString() : null,
      status: invoice.status,
      subtotalMinor: invoice.subtotalMinor.toString(),
      discountMinor: invoice.discountMinor.toString(),
      taxMinor: invoice.taxMinor.toString(),
      totalMinor: invoice.totalMinor.toString(),
      subtotal: money(invoice.subtotalMinor).toDecimalString(),
      discount: money(invoice.discountMinor).toDecimalString(),
      tax: money(invoice.taxMinor).toDecimalString(),
      total: money(invoice.totalMinor).toDecimalString(),
      providerKey: '',
      providerReference: '',
    });

    for (const note of invoice.creditNotes) {
      /*
       * A CREDIT NOTE IS EXPORTED AS A NEGATIVE, because that is what it does
       * to the ledger. Exporting it as a positive and expecting the reader to
       * know the sign from `kind` is how a period reconciles to twice what was
       * actually billed.
       */
      rows.push({
        ...shared,
        kind: 'CREDIT_NOTE',
        documentNumber: note.number ?? '',
        documentId: note.id,
        issuedAt: (note.issuedAt ?? note.createdAt).toISOString(),
        status: note.status,
        subtotalMinor: (-note.subtotalMinor).toString(),
        discountMinor: '0',
        taxMinor: (-note.taxMinor).toString(),
        totalMinor: (-note.totalMinor).toString(),
        subtotal: money(-note.subtotalMinor).toDecimalString(),
        discount: money(0n).toDecimalString(),
        tax: money(-note.taxMinor).toDecimalString(),
        total: money(-note.totalMinor).toDecimalString(),
        providerKey: '',
        providerReference: '',
      });
    }

    for (const attempt of invoice.attempts) {
      rows.push({
        ...shared,
        kind: 'PAYMENT',
        documentNumber: invoice.number ?? '',
        documentId: attempt.id,
        issuedAt: (attempt.settledAt ?? attempt.attemptedAt).toISOString(),
        status: attempt.status,
        subtotalMinor: '0',
        discountMinor: '0',
        taxMinor: '0',
        totalMinor: attempt.amountMinor.toString(),
        subtotal: money(0n).toDecimalString(),
        discount: money(0n).toDecimalString(),
        tax: money(0n).toDecimalString(),
        total: money(attempt.amountMinor).toDecimalString(),
        providerKey: invoice.providerKey ?? '',
        providerReference: attempt.providerPaymentId ?? '',
      });
    }
  }

  return rows;
}

/**
 * The rows as CSV.
 *
 * RFC 4180 QUOTING ON EVERY FIELD, not only the ones that look dangerous. A
 * legal name containing a comma is ordinary, and a conditional quoting rule is
 * one missed case away from an export that silently shifts every column right.
 */
export function accountingCsv(rows: readonly AccountingRow[]): string {
  const quote = (value: string | number | null): string =>
    `"${String(value ?? '').replace(/"/g, '""')}"`;
  const header = ACCOUNTING_COLUMNS.map((column) => quote(column)).join(',');
  const body = rows.map((row) =>
    ACCOUNTING_COLUMNS.map((column) => quote(row[column] as string)).join(','),
  );
  /*
   * CRLF, which is what RFC 4180 specifies and what several accounting
   * packages require. A file that opens in a spreadsheet is not the same as a
   * file the import tool accepts.
   */
  return [header, ...body].join('\r\n') + '\r\n';
}

/** The same rows as JSON, for anything that would rather parse than split. */
export function accountingJson(rows: readonly AccountingRow[]): string {
  return JSON.stringify({ rows, columns: ACCOUNTING_COLUMNS }, null, 2);
}
