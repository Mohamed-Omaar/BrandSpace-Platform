import { formatMoney, type Money } from '@brandspace/shared';
import type { LocalizedText } from './commerce';
import type { InvoiceView, RenderedLine } from './invoices';

/**
 * THE INVOICE AS A DOCUMENT — Phase 10 §23.
 *
 * WHAT THIS FILE IS. The canonical, renderer-independent shape of an issued
 * invoice: the parties as they were printed, the lines as they were described,
 * the amounts at the scale they were stored. Every renderer — the print page,
 * the PDF, the accounting export — reads THIS, so the three cannot disagree
 * about what the customer was charged.
 *
 * IT IS BUILT FROM THE ROW AND ITS SNAPSHOTS, NEVER FROM THE LIVE CATALOGUE.
 * A price change, a moved office or a renamed plan does not alter a document
 * that was already issued. The descriptions were written in BOTH languages at
 * issue time, so either locale renders without re-deriving anything.
 *
 * THE SCALE COMES FROM THE ROW (D-207). `1000` is `10.00` SAR and `1.000` KWD,
 * and three of the seven launch currencies are three-digit — so re-reading the
 * scale from the live catalogue would silently re-denominate an invoice issued
 * last year the moment an owner corrected a typo. `Money` carries the stored
 * scale, and nothing here recomputes it.
 */

export interface DocumentParty {
  readonly legalName: LocalizedText | null;
  readonly addressLines: readonly string[];
  readonly taxId: string | null;
  readonly registrationNumber: string | null;
  readonly countryCode: string | null;
  readonly email: string | null;
}

export interface DocumentLine {
  readonly description: LocalizedText;
  readonly quantity: number;
  readonly unitAmount: Money;
  readonly amount: Money;
  readonly tax: Money;
}

export interface InvoiceDocument {
  readonly invoiceId: string;
  readonly number: string | null;
  readonly status: InvoiceView['status'];
  readonly issuedAt: Date | null;
  readonly dueAt: Date | null;
  readonly paidAt: Date | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;

  readonly seller: DocumentParty;
  readonly buyer: DocumentParty;

  readonly lines: readonly DocumentLine[];
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly amountPaid: Money;
  readonly credited: Money;

  readonly taxMode: InvoiceView['taxMode'];
  readonly taxRateBasisPoints: number;
  /** The market's policy key at issue, so the rule can be explained later. */
  readonly taxPolicyKey: string | null;

  readonly currency: string;
  readonly currencyScale: number;
}

/** The snapshots an issued invoice carries, as this module reads them. */
export interface InvoiceSnapshots {
  readonly parties?: {
    readonly seller?: Partial<DocumentParty> & { legalName?: LocalizedText | null };
    readonly buyer?: Partial<DocumentParty> & { legalName?: LocalizedText | null };
  };
  readonly taxPolicyKey?: string | null;
  readonly dueAt?: string | null;
}

function party(
  raw: InvoiceSnapshots['parties'] extends undefined ? never : unknown,
): DocumentParty {
  const source = (raw ?? {}) as Record<string, unknown>;
  const lines = Array.isArray(source['addressLines'])
    ? (source['addressLines'] as unknown[]).map(String)
    : [];
  return {
    legalName: (source['legalName'] as LocalizedText | null | undefined) ?? null,
    addressLines: lines,
    taxId: typeof source['taxId'] === 'string' ? source['taxId'] : null,
    registrationNumber:
      typeof source['registrationNumber'] === 'string' ? source['registrationNumber'] : null,
    countryCode: typeof source['countryCode'] === 'string' ? source['countryCode'] : null,
    email: typeof source['email'] === 'string' ? source['email'] : null,
  };
}

/**
 * Build the document from what was stored.
 *
 * NOTHING IS RE-DERIVED. Every amount comes from the invoice row at its own
 * scale, every description from the line as it was written, every party from
 * the snapshot taken at issue. The only computed value is `dueAt`, which is
 * read from the snapshot when the row does not carry it.
 */
export function invoiceDocumentFrom(input: {
  readonly invoice: InvoiceView;
  readonly lines: readonly RenderedLine[];
  readonly snapshots: InvoiceSnapshots;
  readonly dueAt?: Date | null;
  readonly taxPolicyKey?: string | null;
}): InvoiceDocument {
  const { invoice, lines, snapshots } = input;
  return {
    invoiceId: invoice.id,
    number: invoice.number,
    status: invoice.status,
    issuedAt: invoice.issuedAt,
    dueAt: input.dueAt ?? (snapshots.dueAt ? new Date(snapshots.dueAt) : null),
    paidAt: invoice.paidAt,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    seller: party(snapshots.parties?.seller),
    buyer: party(snapshots.parties?.buyer),
    lines: lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      amount: line.amount,
      tax: line.tax,
    })),
    subtotal: invoice.subtotal,
    discount: invoice.discount,
    tax: invoice.tax,
    total: invoice.total,
    amountPaid: invoice.amountPaid,
    credited: invoice.credited,
    taxMode: invoice.taxMode,
    taxRateBasisPoints: invoice.taxRateBasisPoints,
    taxPolicyKey: input.taxPolicyKey ?? snapshots.taxPolicyKey ?? null,
    currency: invoice.currency,
    currencyScale: invoice.currencyScale,
  };
}

export type DocumentLocale = 'ar' | 'en';

export interface RenderedDocument {
  /** The bytes. */
  readonly body: Uint8Array;
  /** What they are, for `Content-Type`. */
  readonly contentType: string;
  /** A safe filename, already free of anything a header cannot carry. */
  readonly filename: string;
}

/**
 * THE RENDERER BOUNDARY — Phase 10 §23.
 *
 * WHY IT IS A PORT AND NOT A FUNCTION. Producing a PDF that sets Arabic
 * correctly needs two things this repository cannot decide on its own:
 *
 *   1. A LICENSED ARABIC-CAPABLE FONT to embed. Every PDF that contains Arabic
 *      text carries a subset of a font, and which font a company may embed in a
 *      document it sends to customers is a licensing decision with a cost. It
 *      is the owner's, not this code's.
 *
 *   2. A SHAPING ENGINE. Arabic is cursive and contextual — a letter takes a
 *      different glyph depending on its neighbours, and bidirectional text has
 *      to be reordered before it is drawn. Hand-rolling that is how invoices
 *      end up with disconnected letters in the wrong order, and neither is
 *      something to write from scratch for an accounting document.
 *
 * So Phase 10 ships the COMPLETE boundary, a deterministic implementation that
 * proves the whole data path, and an honest refusal where a font is genuinely
 * required — rather than inventing a vendor or shipping Arabic that looks
 * wrong. `docs/DECISIONS.md` D-216 states exactly what the owner has to decide.
 */
export interface InvoiceDocumentRenderer {
  readonly key: string;
  /** Which locales this renderer can set correctly. Declared, not assumed. */
  readonly supportedLocales: readonly DocumentLocale[];
  render(document: InvoiceDocument, locale: DocumentLocale): Promise<RenderedDocument>;
}

/** Why a renderer cannot produce this document, or null when it can. */
export function renderRefusal(
  renderer: InvoiceDocumentRenderer,
  locale: DocumentLocale,
): string | null {
  if (renderer.supportedLocales.includes(locale)) return null;
  return (
    `The ${renderer.key} renderer cannot set ${locale === 'ar' ? 'Arabic' : 'English'} text. ` +
    'Print the invoice page from the browser, which sets both correctly, or configure a ' +
    'renderer with an embedded font for this script.'
  );
}

/**
 * A safe filename for an invoice, in either locale.
 *
 * ASCII ONLY, and deliberately. A `Content-Disposition` header carrying raw
 * Arabic needs RFC 5987 encoding that not every download path handles, and a
 * filename is not the document — the document inside is bilingual. The invoice
 * NUMBER is the identity a customer and an accountant both search by.
 */
export function invoiceFilename(document: InvoiceDocument, extension: string): string {
  const stem = (document.number ?? document.invoiceId).replace(/[^A-Za-z0-9._-]/g, '-');
  return `invoice-${stem}.${extension}`;
}

/**
 * The document as plain text lines, in one locale.
 *
 * SHARED BY EVERY RENDERER, so the print page, the PDF and a plain-text
 * fallback say the same words in the same order. A renderer decides how to draw
 * these; it never decides what they are.
 */
export function documentLines(
  document: InvoiceDocument,
  locale: DocumentLocale,
): readonly string[] {
  const ar = locale === 'ar';
  const money = (value: Money): string => formatMoney(value, locale);
  const day = (value: Date | null): string => (value ? value.toISOString().slice(0, 10) : '—');
  const name = (text: LocalizedText | null): string =>
    text === null ? '—' : ar ? text.ar : text.en;

  const lines: string[] = [
    ar ? `فاتورة ${document.number ?? ''}`.trim() : `Invoice ${document.number ?? ''}`.trim(),
    '',
    `${ar ? 'البائع' : 'Seller'}: ${name(document.seller.legalName)}`,
    ...document.seller.addressLines,
    ...(document.seller.taxId
      ? [`${ar ? 'الرقم الضريبي' : 'Tax ID'}: ${document.seller.taxId}`]
      : []),
    '',
    `${ar ? 'المشتري' : 'Buyer'}: ${name(document.buyer.legalName)}`,
    ...document.buyer.addressLines,
    ...(document.buyer.taxId
      ? [`${ar ? 'الرقم الضريبي' : 'Tax ID'}: ${document.buyer.taxId}`]
      : []),
    '',
    `${ar ? 'تاريخ الإصدار' : 'Issued'}: ${day(document.issuedAt)}`,
    `${ar ? 'تاريخ الاستحقاق' : 'Due'}: ${day(document.dueAt)}`,
    '',
  ];

  for (const line of document.lines) {
    lines.push(
      `${ar ? line.description.ar : line.description.en} × ${line.quantity} — ${money(line.amount)}`,
    );
  }

  lines.push(
    '',
    `${ar ? 'المجموع الفرعي' : 'Subtotal'}: ${money(document.subtotal)}`,
    ...(document.discount.isZero
      ? []
      : [`${ar ? 'الخصم' : 'Discount'}: ${money(document.discount)}`]),
    `${ar ? 'الضريبة' : 'Tax'}: ${money(document.tax)}`,
    `${ar ? 'الإجمالي' : 'Total'}: ${money(document.total)}`,
    ...(document.credited.isZero
      ? []
      : [`${ar ? 'مبالغ مُقيّدة دائنًا' : 'Credited'}: ${money(document.credited)}`]),
  );

  return lines;
}
