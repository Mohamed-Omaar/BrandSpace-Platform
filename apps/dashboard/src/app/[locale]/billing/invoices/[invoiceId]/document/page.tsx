import { notFound } from 'next/navigation';
import { formatMoney, type Money } from '@brandspace/shared';
import type { DocumentLocale, InvoiceDocument } from '@brandspace/billing';
import { requireWorkspace } from '../../../../../../server/customer-context';
import { invoiceDocumentFor } from '../../../../../../server/commerce-context';

export const dynamic = 'force-dynamic';

/**
 * THE INVOICE AS A DOCUMENT — Phase 10 §23.
 *
 * NOT A SCREEN WITH A PRINT BUTTON. This route has no navigation, no shell and
 * no application chrome: it is the document itself, at A4 proportions, with
 * `@page` rules and print colours. What a customer sends their accountant is
 * this page, printed — and because it is the same markup either way, the thing
 * on screen and the thing in the PDF cannot drift apart.
 *
 * THE BROWSER IS THE TYPESETTER, AND THAT IS A DELIBERATE CHOICE (D-216). Every
 * browser ships a licensed Arabic font and a shaping engine; a server-side PDF
 * writer has neither unless somebody buys a font licence and adds a shaping
 * library. So the bilingual, correctly-shaped, RTL-correct document is THIS,
 * today, rather than a promise — and `DeterministicPdfRenderer` covers the
 * Latin path for systems that need bytes rather than a page.
 *
 * EVERY VALUE COMES FROM THE STORED ROW. Amounts at the currency's own scale,
 * descriptions as they were written at issue, parties as they were printed. A
 * price change or a moved office does not rewrite an issued document.
 *
 * AN INVOICE BELONGING TO ANOTHER WORKSPACE IS A 404, shaped exactly like an id
 * that never existed: the lookup is tenant-scoped and RLS refuses it besides.
 */
export default async function InvoiceDocumentPage({
  params,
}: {
  params: Promise<{ locale: string; invoiceId: string }>;
}) {
  const { locale, invoiceId } = await params;
  const { workspace } = await requireWorkspace(locale, 'billing.read');
  const document = await invoiceDocumentFor(workspace.workspaceId, invoiceId);
  if (!document) notFound();

  const documentLocale: DocumentLocale = locale === 'ar' ? 'ar' : 'en';
  const ar = documentLocale === 'ar';
  const money = (value: Money): string => formatMoney(value, documentLocale);
  const day = (value: Date | null): string => (value ? value.toISOString().slice(0, 10) : '—');
  return (
    <main
      data-testid="invoice-document"
      dir={ar ? 'rtl' : 'ltr'}
      lang={ar ? 'ar' : 'en'}
      style={{
        // A4 proportions on screen; `@page` takes over when printing.
        maxWidth: '210mm',
        minHeight: '297mm',
        margin: '0 auto',
        padding: '18mm',
        background: '#FFFFFF',
        color: '#111114',
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Tahoma, sans-serif',
        fontSize: '11pt',
        lineHeight: 1.5,
        boxSizing: 'border-box',
      }}
    >
      {/*
        PRINT RULES INLINE, deliberately. This route is one document and carries
        its own presentation; putting them in a shared stylesheet would make a
        change elsewhere able to alter an accounting document.
      */}
      <style>{`
        @page { size: A4; margin: 14mm; }
        @media print {
          html, body { background: #FFFFFF; }
          [data-testid="invoice-document"] { padding: 0; margin: 0; max-width: none; }
          .no-print { display: none !important; }
        }
        .invoice-table { width: 100%; border-collapse: collapse; }
        .invoice-table th, .invoice-table td {
          border-block-end: 1px solid #D8D8DE;
          padding: 6pt 4pt;
          text-align: start;
          vertical-align: top;
        }
        .invoice-table td.amount, .invoice-table th.amount { text-align: end; }
      `}</style>

      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '12mm',
          marginBlockEnd: '10mm',
        }}
      >
        <div>
          <h1 style={{ fontSize: '18pt', margin: 0 }}>
            {ar ? 'فاتورة' : 'Invoice'} {document.number ?? ''}
          </h1>
          <p style={{ margin: '2pt 0 0', color: '#55555F' }} data-testid="invoice-document-status">
            {statusWord(document.status, ar)}
          </p>
        </div>
        <dl
          style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto auto', gap: '2pt 8pt' }}
        >
          <dt style={{ color: '#55555F' }}>{ar ? 'تاريخ الإصدار' : 'Issued'}</dt>
          <dd style={{ margin: 0 }}>{day(document.issuedAt)}</dd>
          <dt style={{ color: '#55555F' }}>{ar ? 'تاريخ الاستحقاق' : 'Due'}</dt>
          <dd style={{ margin: 0 }}>{day(document.dueAt)}</dd>
          {document.periodStart && document.periodEnd ? (
            <>
              <dt style={{ color: '#55555F' }}>{ar ? 'الفترة' : 'Period'}</dt>
              <dd style={{ margin: 0 }}>
                {day(document.periodStart)} — {day(document.periodEnd)}
              </dd>
            </>
          ) : null}
        </dl>
      </header>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '10mm',
          marginBlockEnd: '10mm',
        }}
      >
        <Party
          heading={ar ? 'من' : 'From'}
          party={document.seller}
          ar={ar}
          testId="document-seller"
        />
        <Party heading={ar ? 'إلى' : 'To'} party={document.buyer} ar={ar} testId="document-buyer" />
      </section>

      <table className="invoice-table" data-testid="document-lines">
        <thead>
          <tr>
            <th scope="col">{ar ? 'الوصف' : 'Description'}</th>
            <th scope="col" className="amount">
              {ar ? 'الكمية' : 'Qty'}
            </th>
            <th scope="col" className="amount">
              {ar ? 'سعر الوحدة' : 'Unit'}
            </th>
            <th scope="col" className="amount">
              {ar ? 'المبلغ' : 'Amount'}
            </th>
          </tr>
        </thead>
        <tbody>
          {document.lines.map((line, index) => (
            <tr key={`${line.description.en}-${index}`}>
              <td>{ar ? line.description.ar : line.description.en}</td>
              <td className="amount">{line.quantity}</td>
              <td className="amount">{money(line.unitAmount)}</td>
              <td className="amount">{money(line.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section
        style={{
          marginBlockStart: '8mm',
          marginInlineStart: 'auto',
          width: '70mm',
          display: 'grid',
          gridTemplateColumns: 'auto auto',
          gap: '3pt 8pt',
        }}
        data-testid="document-totals"
      >
        <span style={{ color: '#55555F' }}>{ar ? 'المجموع الفرعي' : 'Subtotal'}</span>
        <span style={{ textAlign: 'end' }}>{money(document.subtotal)}</span>
        {document.discount.isZero ? null : (
          <>
            <span style={{ color: '#55555F' }}>{ar ? 'الخصم' : 'Discount'}</span>
            <span style={{ textAlign: 'end' }}>{money(document.discount)}</span>
          </>
        )}
        <span style={{ color: '#55555F' }}>
          {ar ? 'الضريبة' : 'Tax'}
          {document.taxRateBasisPoints > 0
            ? ` (${(document.taxRateBasisPoints / 100).toFixed(2)}%)`
            : ''}
        </span>
        <span style={{ textAlign: 'end' }}>{money(document.tax)}</span>
        <strong>{ar ? 'الإجمالي' : 'Total'}</strong>
        <strong style={{ textAlign: 'end' }} data-testid="document-total">
          {money(document.total)}
        </strong>
        {document.credited.isZero ? null : (
          <>
            <span style={{ color: '#55555F' }}>{ar ? 'مبالغ دائنة' : 'Credited'}</span>
            <span style={{ textAlign: 'end' }}>{money(document.credited)}</span>
          </>
        )}
      </section>

      {document.taxPolicyKey ? (
        <p style={{ marginBlockStart: '8mm', color: '#55555F', fontSize: '9pt' }}>
          {ar ? 'سياسة الضريبة' : 'Tax policy'}: {document.taxPolicyKey} · {document.taxMode}
        </p>
      ) : null}

      <p
        className="no-print"
        style={{ marginBlockStart: '10mm', color: '#55555F', fontSize: '9pt' }}
      >
        {ar
          ? 'اطبع هذه الصفحة أو احفظها كـ PDF من متصفحك — وهي نفس المستند بالضبط.'
          : 'Print this page or save it as a PDF from your browser — it is the same document either way.'}
      </p>
    </main>
  );
}

function Party({
  heading,
  party,
  ar,
  testId,
}: {
  heading: string;
  party: InvoiceDocument['seller'];
  ar: boolean;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <h2 style={{ fontSize: '10pt', color: '#55555F', margin: '0 0 3pt', fontWeight: 600 }}>
        {heading}
      </h2>
      <p style={{ margin: 0, fontWeight: 600 }}>
        {party.legalName === null ? '—' : ar ? party.legalName.ar : party.legalName.en}
      </p>
      {party.addressLines.map((line) => (
        <p key={line} style={{ margin: 0 }}>
          {line}
        </p>
      ))}
      {party.taxId ? (
        <p style={{ margin: '3pt 0 0', color: '#55555F' }}>
          {ar ? 'الرقم الضريبي' : 'Tax ID'}: {party.taxId}
        </p>
      ) : null}
      {party.registrationNumber ? (
        <p style={{ margin: 0, color: '#55555F' }}>
          {ar ? 'السجل التجاري' : 'Registration'}: {party.registrationNumber}
        </p>
      ) : null}
    </div>
  );
}

function statusWord(status: InvoiceDocument['status'], ar: boolean): string {
  switch (status) {
    case 'PAID':
      return ar ? 'مدفوعة' : 'Paid';
    case 'OPEN':
      return ar ? 'مستحقة' : 'Due';
    case 'VOID':
      return ar ? 'ملغاة' : 'Void';
    case 'UNCOLLECTIBLE':
      return ar ? 'غير قابلة للتحصيل' : 'Uncollectible';
    case 'DRAFT':
      return ar ? 'مسودة' : 'Draft';
  }
}
