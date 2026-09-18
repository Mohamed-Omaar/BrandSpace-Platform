import Link from 'next/link';
import { formatMoney, type Money } from '@brandspace/shared';
import { colorTokens, spacingTokens, typographyTokens } from '@brandspace/ui';
import { requireWorkspace } from '../../../../../server/customer-context';
import { commerceSnapshotFor, invoiceDetailFor } from '../../../../../server/commerce-context';
import { brandContextFor } from '../../../../../server/brand-context';
import { translator, type MessageKey } from '../../../../../i18n/messages';
import {
  CustomerCard,
  CustomerEmpty,
  WorkspaceShell,
  customerTableStyle,
  customerTdStyle,
  customerThStyle,
} from '../../../../../components/workspace-shell';

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
  const { locale, invoiceId } = await params;
  const t = translator(locale);
  const { customer, workspace } = await requireWorkspace(locale, 'billing.read');

  const detail = await invoiceDetailFor(workspace.workspaceId, invoiceId);
  const snapshot = await commerceSnapshotFor(workspace.workspaceId);
  const brandContext = await brandContextFor(workspace, '/billing');
  const show = (value: Money): string => formatMoney(value, locale === 'ar' ? 'ar' : 'en');
  const day = (value: Date | null): string => (value ? value.toISOString().slice(0, 10) : '—');

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
        <table style={customerTableStyle()}>
          <thead>
            <tr>
              <th style={customerThStyle()}>{t('billing.invoiceLines')}</th>
              <th style={customerThStyle()}>{t('billing.invoiceQuantity')}</th>
              <th style={customerThStyle()}>{t('billing.invoiceUnit')}</th>
              <th style={customerThStyle()}>{t('billing.invoiceAmount')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((line) => (
              <tr key={line.id} data-testid={`invoice-line-${line.id}`}>
                {/* WRITTEN IN BOTH LANGUAGES AT ISSUE TIME. Neither is derived
                    now from a catalogue that may have moved on. */}
                <td style={customerTdStyle()}>
                  {locale === 'ar' ? line.description.ar : line.description.en}
                </td>
                <td style={customerTdStyle()}>{line.quantity}</td>
                <td style={customerTdStyle()}>{show(line.unitAmount)}</td>
                <td style={customerTdStyle()}>{show(line.amount)}</td>
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
          <table style={customerTableStyle()}>
            <thead>
              <tr>
                <th style={customerThStyle()}>{t('billing.invoiceNumber')}</th>
                <th style={customerThStyle()}>{t('billing.invoiceDate')}</th>
                <th style={customerThStyle()}>{t('billing.creditNoteReason')}</th>
                <th style={customerThStyle()}>{t('billing.status')}</th>
                <th style={customerThStyle()}>{t('billing.invoiceTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.creditNotes.map((note) => (
                <tr key={note.id} data-testid={`credit-note-${note.id}`}>
                  <td style={customerTdStyle()}>{note.number ?? '—'}</td>
                  <td style={customerTdStyle()}>{day(note.issuedAt)}</td>
                  <td style={customerTdStyle()}>{note.reason}</td>
                  <td style={customerTdStyle()}>
                    {t(`billing.creditNoteStatus.${note.status}` as MessageKey)}
                  </td>
                  <td style={customerTdStyle()}>{show(note.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CustomerCard>
      ) : null}

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
