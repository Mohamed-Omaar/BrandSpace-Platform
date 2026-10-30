import { notFound } from 'next/navigation';
import Link from 'next/link';
import { formatMoneyDisplay, type Money, systemClock } from '@brandspace/shared';
import {
  colorTokens,
  spacingTokens,
  typographyTokens,
  TABLE_CLASS,
  TD_CLASS,
  TH_CLASS,
} from '@brandspace/ui';
import { requireWorkspace } from '../../../../../server/customer-context';
import { paymentsSwitchedOn } from '../../../../../server/payments-switch';
import { commerceSnapshotFor, invoiceDetailFor } from '../../../../../server/commerce-context';
import { brandContextFor } from '../../../../../server/brand-context';
import { translator, type MessageKey } from '../../../../../i18n/messages';
import {
  CustomerCard,
  CustomerEmpty,
  WorkspaceShell,
} from '../../../../../components/workspace-shell';
import { dayLabel } from '../../../../../server/prototype-dates';

export const dynamic = 'force-dynamic';

/**
 * One invoice, exactly as it was issued.
 *
 * RENDERED FROM THE ROW AND ITS SNAPSHOTS, never from the live catalogue. A
 * price change, a moved office or a renamed plan does not alter a document that
 * was already issued — the descriptions were written in BOTH languages at issue
 * time, so this page can produce either without re-deriving anything (§31).
 *
 * THE PDF IS THE BROWSER'S. `print` produces the same bilingual document from
 * the same markup, which is one document rather than two that can disagree.
 *
 * AN INVOICE BELONGING TO ANOTHER WORKSPACE IS A 404, shaped exactly like an id
 * that never existed — the lookup is tenant-scoped and RLS refuses it besides.
 */
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ locale: string; invoiceId: string }>;
}) {
  // PR F (a): with payments off this page does not exist.
  if (!(await paymentsSwitchedOn())) notFound();
  const { locale, invoiceId } = await params;
  const { customer, workspace, messageLocale } = await requireWorkspace(locale, 'billing.read');
  const t = translator(messageLocale);

  const detail = await invoiceDetailFor(workspace.workspaceId, invoiceId);
  const snapshot = await commerceSnapshotFor(workspace.workspaceId);
  const brandContext = await brandContextFor(workspace, '/billing');
  const show = (value: Money): string => formatMoneyDisplay(value, locale);
  // Round 4 (1.8): the prototype's date.
  const day = (value: Date | null): string =>
    value ? dayLabel(value, locale, 'UTC', systemClock.now()) : '—';

  if (!detail) {
    return (
      <WorkspaceShell
        brandContext={brandContext}
        locale={locale}
        heading={t('billing.invoices')}
        workspaceName={workspace.workspaceName}
        roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
        customerName={customer.email}
        permissionKeys={workspace.permissionKeys}
      >
        <CustomerEmpty message={t('billing.invoiceNotFound')} />
      </WorkspaceShell>
    );
  }

  const invoice = detail.invoice;
  const seller = snapshot.policy.invoice;

  return (
    <WorkspaceShell
      brandContext={brandContext}
      locale={locale}
      heading={`${t('billing.invoiceNumber')} ${invoice.number ?? '—'}`}
      workspaceName={workspace.workspaceName}
      roleName={locale === 'ar' ? workspace.roleNameAr : workspace.roleNameEn}
      customerName={customer.email}
      permissionKeys={workspace.permissionKeys}
    >
      <CustomerCard title={t('billing.invoiceSeller')} testId="invoice-parties">
        <dl style={{ margin: 0, display: 'grid', gap: spacingTokens.xs }}>
          <Row
            label={t('billing.invoiceSeller')}
            value={(locale === 'ar' ? seller.legalName?.ar : seller.legalName?.en) ?? '—'}
          />
          <Row label={t('billing.invoiceBuyer')} value={workspace.workspaceName} />
          <Row label={t('billing.invoiceDate')} value={day(invoice.issuedAt)} />
          <Row
            label={t('billing.status')}
            value={t(`billing.invoiceStatus.${invoice.status}` as MessageKey)}
            testId="invoice-status"
          />
        </dl>
      </CustomerCard>

      <CustomerCard title={t('billing.invoiceLines')} testId="invoice-lines">
        <table className={TABLE_CLASS}>
          <thead>
            <tr>
              <th className={TH_CLASS}>{t('billing.invoiceLines')}</th>
              <th className={TH_CLASS}>{t('billing.invoiceQuantity')}</th>
              <th className={TH_CLASS}>{t('billing.invoiceUnit')}</th>
              <th className={TH_CLASS}>{t('billing.invoiceAmount')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((line) => (
              <tr key={line.id} data-testid={`invoice-line-${line.id}`}>
                {/* WRITTEN IN BOTH LANGUAGES AT ISSUE TIME. Neither is derived
                    now from a catalogue that may have moved on. */}
                <td className={TD_CLASS}>
                  {locale === 'ar' ? line.description.ar : line.description.en}
                </td>
                <td className={TD_CLASS}>{line.quantity}</td>
                <td className={TD_CLASS}>{show(line.unitAmount)}</td>
                <td className={TD_CLASS}>{show(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl
          style={{
            margin: 0,
            marginBlockStart: spacingTokens.md,
            display: 'grid',
            gap: spacingTokens.xs,
          }}
        >
          <Row label={t('billing.invoiceSubtotal')} value={show(invoice.subtotal)} />
          <Row
            label={
              invoice.taxRateBasisPoints > 0
                ? `${t('billing.invoiceTax')} (${(invoice.taxRateBasisPoints / 100).toFixed(2)}%)`
                : t('billing.invoiceTax')
            }
            value={show(invoice.tax)}
            testId="invoice-tax"
          />
          <Row
            label={t('billing.invoiceTotal')}
            value={show(invoice.total)}
            testId="invoice-total"
          />
          {invoice.credited.isZero ? null : (
            <Row
              label={t('billing.invoiceCredited')}
              value={show(invoice.credited)}
              testId="invoice-credited"
            />
          )}
        </dl>
        {invoice.taxMode === 'NONE' ? (
          <p style={mutedStyle}>{t('billing.invoiceTaxNone')}</p>
        ) : null}
      </CustomerCard>

      {detail.creditNotes.length > 0 ? (
        <CustomerCard title={t('billing.creditNotes')} testId="invoice-credit-notes">
          <p style={mutedStyle}>{t('billing.creditNoteNotice')}</p>
          <table className={TABLE_CLASS}>
            <thead>
              <tr>
                <th className={TH_CLASS}>{t('billing.invoiceNumber')}</th>
                <th className={TH_CLASS}>{t('billing.invoiceDate')}</th>
                <th className={TH_CLASS}>{t('billing.creditNoteReason')}</th>
                <th className={TH_CLASS}>{t('billing.status')}</th>
                <th className={TH_CLASS}>{t('billing.invoiceTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.creditNotes.map((note) => (
                <tr key={note.id} data-testid={`credit-note-${note.id}`}>
                  <td className={TD_CLASS}>{note.number ?? '—'}</td>
                  <td className={TD_CLASS}>{day(note.issuedAt)}</td>
                  <td className={TD_CLASS}>{note.reason}</td>
                  <td className={TD_CLASS}>
                    {t(`billing.creditNoteStatus.${note.status}` as MessageKey)}
                  </td>
                  <td className={TD_CLASS}>{show(note.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CustomerCard>
      ) : null}

      {/*
        PHASE 10 §23 — THE DOCUMENT, and the two ways to take it away.
        `billing.invoicePrint` had existed as a translation key since Phase 9
        with nothing rendering it: the document existed and there was no way to
        reach it, which is precisely the unreachable-feature case §16 asks for.
      */}
      <CustomerCard title={t('billing.invoiceDocument')} testId="invoice-document-links">
        <p style={mutedStyle}>{t('billing.invoiceDocumentNote')}</p>
        <p style={{ display: 'flex', gap: spacingTokens.md, flexWrap: 'wrap', margin: 0 }}>
          <Link
            href={`/${locale}/billing/invoices/${invoice.id}/document`}
            data-testid="invoice-open-document"
            style={{ ...typographyTokens.bodySm, color: colorTokens.brandPurple }}
          >
            {t('billing.invoicePrint')}
          </Link>
          <a
            href={`/api/billing/invoices/${invoice.id}/pdf?locale=en`}
            data-testid="invoice-download-pdf"
            style={{ ...typographyTokens.bodySm, color: colorTokens.brandPurple }}
          >
            {t('billing.invoicePdf')}
          </a>
        </p>
      </CustomerCard>

      <p>
        <Link
          href={`/${locale}/billing`}
          style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}
        >
          {t('billing.backToBilling')}
        </Link>
      </p>
    </WorkspaceShell>
  );
}

function Row({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: spacingTokens.sm }}>
      <dt style={{ ...typographyTokens.bodySm, color: colorTokens.textSecondary }}>{label}</dt>
      <dd data-testid={testId} style={{ margin: 0, ...typographyTokens.caption, textAlign: 'end' }}>
        {value}
      </dd>
    </div>
  );
}

const mutedStyle = {
  margin: 0,
  ...typographyTokens.caption,
  color: colorTokens.textMuted,
} as const;
