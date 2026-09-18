import { describe, expect, it } from 'vitest';

import {
  ACCOUNTING_COLUMNS,
  accountingCsv,
  accountingJson,
  DeterministicPdfRenderer,
  documentLines,
  invoiceDocumentFrom,
  invoiceFilename,
  renderRefusal,
  type AccountingRow,
  type InvoiceDocument,
} from '@brandspace/billing';
import { Money } from '@brandspace/shared';

/**
 * The invoice as a document, and the accounting export — Phase 10 §23, §24.
 *
 * WHAT THESE TESTS ARE REALLY DEFENDING is that an accounting document says
 * what was actually charged. The interesting assertions are therefore about
 * SCALE and SIGN: a three-decimal currency rendered at two decimals is a wrong
 * invoice, and a credit note exported as a positive is a period that reconciles
 * to twice what was billed.
 */

const KWD = (minor: bigint): Money => Money.ofMinor('KWD', minor, 3);

function documentFixture(): InvoiceDocument {
  return invoiceDocumentFrom({
    invoice: {
      id: 'inv-1',
      workspaceId: 'ws-1',
      number: 'BSP-2026-000042',
      status: 'PAID',
      subtotal: KWD(10_000n),
      discount: KWD(0n),
      tax: KWD(500n),
      total: KWD(10_500n),
      amountPaid: KWD(10_500n),
      credited: KWD(0n),
      taxMode: 'EXCLUSIVE',
      taxRateBasisPoints: 500,
      issuedAt: new Date('2026-03-01T10:00:00Z'),
      paidAt: new Date('2026-03-02T10:00:00Z'),
      periodStart: new Date('2026-03-01T00:00:00Z'),
      periodEnd: new Date('2026-03-31T23:59:59Z'),
      currency: 'KWD',
      currencyScale: 3,
    },
    lines: [
      {
        id: 'line-1',
        kind: 'SUBSCRIPTION',
        description: { ar: 'اشتراك شهري', en: 'Monthly subscription' },
        quantity: 1,
        unitAmount: KWD(10_000n),
        amount: KWD(10_000n),
        tax: KWD(500n),
      },
    ],
    snapshots: {
      parties: {
        seller: { legalName: { ar: 'براندسبيس', en: 'BrandSpace' }, taxId: 'SELLER-TAX-1' },
        buyer: {
          legalName: { ar: 'عميل', en: 'A Customer' },
          taxId: 'BUYER-TAX-9',
          countryCode: 'KW',
        },
      },
    },
    dueAt: new Date('2026-03-15T00:00:00Z'),
    taxPolicyKey: 'kw-standard',
  });
}

describe('the invoice document', () => {
  it('keeps the currency scale the row was stored at', () => {
    /*
     * D-207. `10500` is `10.500` in KWD and `105.00` in SAR. Re-deriving the
     * scale from the live catalogue would silently re-denominate an invoice
     * issued last year the moment an owner corrected a typo.
     */
    const document = documentFixture();
    expect(document.currencyScale).toBe(3);
    expect(document.total.toDecimalString()).toBe('10.500');
  });

  it('carries the parties as they were printed, not as they are now', () => {
    const document = documentFixture();
    expect(document.seller.taxId).toBe('SELLER-TAX-1');
    expect(document.buyer.countryCode).toBe('KW');
  });

  it('renders the same facts in both languages', () => {
    const en = documentLines(documentFixture(), 'en').join('\n');
    const ar = documentLines(documentFixture(), 'ar').join('\n');
    expect(en).toContain('Monthly subscription');
    expect(ar).toContain('اشتراك شهري');
    // The amount is the same number in both, because it is the same invoice.
    expect(en).toContain('10.500');
    expect(ar).toContain('10.500');
  });

  it('builds an ASCII filename from the invoice number', () => {
    // A `Content-Disposition` carrying raw Arabic needs RFC 5987 encoding that
    // not every download path handles. The document inside is still bilingual.
    expect(invoiceFilename(documentFixture(), 'pdf')).toBe('invoice-BSP-2026-000042.pdf');
  });
});

describe('the deterministic PDF renderer', () => {
  it('produces a real PDF', async () => {
    const rendered = await new DeterministicPdfRenderer().render(documentFixture(), 'en');
    const text = Buffer.from(rendered.body).toString('latin1');
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(rendered.contentType).toBe('application/pdf');
  });

  it('writes a cross-reference offset that actually points at an object', () => {
    /*
     * A PDF IS ITS CROSS-REFERENCE TABLE. An offset that is wrong by one byte
     * produces a file that opens as a blank page in some readers and not at
     * all in others — the class of bug a "did it produce bytes" test misses
     * completely.
     */
    return new DeterministicPdfRenderer().render(documentFixture(), 'en').then((rendered) => {
      const text = Buffer.from(rendered.body).toString('latin1');
      const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
      expect(Number.isFinite(startxref)).toBe(true);
      expect(text.slice(startxref, startxref + 4)).toBe('xref');
      const firstOffset = Number(/xref\n0 \d+\n0{10} 65535 f \n(\d{10})/.exec(text)?.[1]);
      expect(text.slice(firstOffset, firstOffset + 7)).toBe('1 0 obj');
    });
  });

  it('refuses Arabic rather than drawing empty boxes', async () => {
    /*
     * Helvetica is one of the fourteen fonts every reader provides and contains
     * no Arabic glyphs at all. A PDF full of blank rectangles looks like a
     * document until somebody opens it, which is worse than an honest refusal.
     */
    const renderer = new DeterministicPdfRenderer();
    expect(renderer.supportedLocales).toEqual(['en']);
    expect(renderRefusal(renderer, 'ar')).toContain('cannot set Arabic');
    expect(renderRefusal(renderer, 'en')).toBeNull();
    await expect(renderer.render(documentFixture(), 'ar')).rejects.toThrow(/Arabic font/);
  });

  it('escapes a parenthesis in a legal name', () => {
    /*
     * An unescaped `)` ends a PDF string literal early and corrupts every byte
     * offset after it. "Acme (Holdings) Ltd" is an ordinary company name.
     */
    const base = documentFixture();
    const awkward: InvoiceDocument = {
      ...base,
      seller: { ...base.seller, legalName: { ar: 'شركة', en: 'Acme (Holdings) Ltd' } },
    };
    return new DeterministicPdfRenderer().render(awkward, 'en').then((rendered) => {
      const text = Buffer.from(rendered.body).toString('latin1');
      expect(text).toContain('Acme \\(Holdings\\) Ltd');
    });
  });
});

describe('the accounting export', () => {
  const rows: AccountingRow[] = [
    {
      kind: 'INVOICE',
      documentNumber: 'BSP-2026-000042',
      documentId: 'inv-1',
      invoiceId: 'inv-1',
      issuedAt: '2026-03-01T10:00:00.000Z',
      status: 'PAID',
      currency: 'KWD',
      currencyScale: 3,
      subtotalMinor: '10000',
      discountMinor: '0',
      taxMinor: '500',
      totalMinor: '10500',
      subtotal: '10.000',
      discount: '0.000',
      tax: '0.500',
      total: '10.500',
      taxMode: 'EXCLUSIVE',
      taxRatePercent: '5.00',
      taxPolicyKey: 'kw-standard',
      sellerTaxId: 'SELLER-TAX-1',
      buyerTaxId: 'BUYER-TAX-9',
      buyerCountry: 'KW',
      buyerName: 'Acme, Holdings "Ltd"',
      providerKey: '',
      providerReference: '',
    },
  ];

  it('exports both the exact integer and the scaled decimal', () => {
    // A spreadsheet reads the decimal, a ledger reads the integer, and neither
    // has to guess whether this currency has two decimal places or three.
    const csv = accountingCsv(rows);
    expect(csv).toContain('"10500"');
    expect(csv).toContain('"10.500"');
  });

  it('quotes every field, so a comma in a legal name cannot shift a column', () => {
    const csv = accountingCsv(rows);
    const [, body] = csv.split('\r\n');
    expect(body).toContain('"Acme, Holdings ""Ltd"""');
    // Header and one row, then the trailing CRLF.
    expect(csv.split('\r\n').filter((line) => line.length > 0)).toHaveLength(2);
  });

  it('uses CRLF, which is what RFC 4180 and several import tools require', () => {
    expect(accountingCsv(rows).endsWith('\r\n')).toBe(true);
  });

  it('writes the tax rate as a decimal string rather than a float', () => {
    // `0.15000000000000002` in an accounting export is the kind of thing a
    // filing agent rejects.
    expect(rows[0]!.taxRatePercent).toBe('5.00');
    expect(accountingCsv(rows)).toContain('"5.00"');
  });

  it('exports the same columns in JSON', () => {
    const parsed = JSON.parse(accountingJson(rows)) as {
      rows: AccountingRow[];
      columns: string[];
    };
    expect(parsed.columns).toEqual(ACCOUNTING_COLUMNS);
    expect(parsed.rows[0]?.totalMinor).toBe('10500');
  });

  it('names a jurisdiction column for every row rather than assuming one', () => {
    /*
     * §24: do not encode one country's tax law as universal. The columns exist
     * for every row; a market that does not use tax numbers leaves them empty
     * rather than the exporter pretending every seller has a VAT number.
     */
    for (const column of ['sellerTaxId', 'buyerTaxId', 'taxPolicyKey', 'taxRatePercent']) {
      expect(ACCOUNTING_COLUMNS).toContain(column);
    }
  });
});
