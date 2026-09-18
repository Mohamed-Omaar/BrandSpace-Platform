/**
 * Credit notes and refunds — a correction is a SECOND document (§35).
 *
 * WHY AN ISSUED INVOICE IS NEVER EDITED. An invoice is what the customer was
 * charged; a credit note is what was given back. Keeping both means the history
 * answers "what happened" rather than only "what the current state is" — and an
 * accounting series where a document can silently change amount is not evidence
 * of anything.
 *
 * THE MONEY MOVES SEPARATELY FROM THE DOCUMENT. `issue()` creates the credit
 * note; `refund()` asks the provider to move money and records the result. They
 * are separate because a credit note may be issued without a refund (a goodwill
 * credit against a future invoice) and because a refund can fail while the
 * document stands.
 *
 * NEVER MORE THAN WAS INVOICED, and never in another currency. Both are
 * enforced here AND by CHECK constraints on the table, because a refund larger
 * than the charge is the failure mode that costs real money.
 *
 * REFUNDS DO NOT CLAW BACK SPENT CREDITS. Refunding a pack purchase reverses
 * what is LEFT of its grant; credits already consumed bought AI work that really
 * happened. Taking them back would drive a balance negative, which D-196 and the
 * ledger's own CHECK both forbid.
 */

import type { Prisma, TenantScopedClient } from '@brandspace/database';
import { writeAuditEvent } from '@brandspace/database';
import { AppError, Money, type Clock, systemClock } from '@brandspace/shared';
import type { PaymentProviderAdapter } from './adapter';
import type { CommercePolicy, LocalizedText } from './commerce';
import { allocateInvoiceNumber } from './invoices';

export interface CreditNoteLineInput {
  readonly description: LocalizedText;
  readonly quantity: number;
  readonly amount: Money;
  readonly tax: Money;
  readonly invoiceLineId?: string | null;
}

export interface IssueCreditNoteInput {
  readonly workspaceId: string;
  readonly invoiceId: string;
  readonly policy: CommercePolicy;
  readonly reason: string;
  readonly lines: readonly CreditNoteLineInput[];
  /** One credit note per logical request, however many times it is retried. */
  readonly idempotencyKey: string;
  readonly actorUserId?: string | null;
  readonly actorPlatformUserId?: string | null;
}

export interface CreditNoteView {
  readonly id: string;
  readonly workspaceId: string;
  readonly invoiceId: string;
  readonly number: string | null;
  readonly status: 'DRAFT' | 'ISSUED' | 'REFUNDED';
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly reason: string;
  readonly issuedAt: Date | null;
  readonly refundedAt: Date | null;
}

export class CreditNoteService {
  readonly #clock: Clock;

  constructor(options: { readonly clock?: Clock } = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Issue a credit note against an issued invoice.
   *
   * ATOMIC WITH THE INVOICE'S RUNNING TOTAL. `creditedMinor` rises in the same
   * transaction, and `CHECK (creditedMinor <= totalMinor)` refuses the write if
   * two concurrent credits would together exceed the invoice — so the limit
   * holds even when this code's own read was stale.
   */
  async issue(db: TenantScopedClient, input: IssueCreditNoteInput): Promise<CreditNoteView> {
    if (input.reason.trim().length < 4) {
      throw new AppError('VALIDATION_FAILED', 'A credit note requires a written reason.');
    }
    if (input.lines.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'A credit note needs at least one line.');
    }

    const existing = await db.creditNote.findFirst({
      where: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey },
    });
    if (existing) return toCreditNoteView(existing);

    const invoice = await db.invoice.findFirst({
      where: { workspaceId: input.workspaceId, id: input.invoiceId },
    });
    if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found.');
    if (invoice.status === 'DRAFT') {
      throw new AppError('CONFLICT', 'A draft invoice is discarded, not credited.');
    }

    let subtotal = Money.zero(invoice.currency, invoice.currencyScale);
    let tax = Money.zero(invoice.currency, invoice.currencyScale);
    for (const line of input.lines) {
      // Refuses a different currency outright — a credit note in another
      // denomination would be a conversion nobody agreed to (§6).
      subtotal = subtotal.plus(line.amount);
      tax = tax.plus(line.tax);
    }
    const total = subtotal.plus(tax);

    const alreadyCredited = Money.ofMinor(
      invoice.currency,
      invoice.creditedMinor,
      invoice.currencyScale,
    );
    const invoiceTotal = Money.ofMinor(invoice.currency, invoice.totalMinor, invoice.currencyScale);
    if (alreadyCredited.plus(total).compare(invoiceTotal) > 0) {
      throw new AppError('VALIDATION_FAILED', 'A credit note cannot exceed the invoice.', {
        invoiceTotal: invoiceTotal.toDecimalString(),
        alreadyCredited: alreadyCredited.toDecimalString(),
        requested: total.toDecimalString(),
      });
    }

    const now = this.#clock.now();
    const number = await allocateInvoiceNumber(
      db,
      input.policy.invoice.creditNotePrefix,
      now.getUTCFullYear(),
      input.policy.invoice.numberPadding,
    );

    const note = await db.creditNote.create({
      data: {
        workspaceId: input.workspaceId,
        invoiceId: input.invoiceId,
        number,
        status: 'ISSUED',
        currency: invoice.currency,
        currencyScale: invoice.currencyScale,
        subtotalMinor: subtotal.minorUnits,
        taxMinor: tax.minorUnits,
        totalMinor: total.minorUnits,
        reason: input.reason,
        issuedAt: now,
        idempotencyKey: input.idempotencyKey,
        createdByUserId: input.actorUserId ?? null,
        createdByPlatformUserId: input.actorPlatformUserId ?? null,
      },
    });

    await db.creditNoteLine.createMany({
      data: input.lines.map((line, index) => ({
        workspaceId: input.workspaceId,
        creditNoteId: note.id,
        invoiceLineId: line.invoiceLineId ?? null,
        description: line.description as unknown as Prisma.InputJsonValue,
        quantity: line.quantity,
        amountMinor: line.amount.minorUnits,
        taxAmountMinor: line.tax.minorUnits,
        sortOrder: index,
      })),
    });

    await db.invoice.update({
      where: { id: invoice.id },
      data: { creditedMinor: { increment: total.minorUnits } },
    });

    await writeAuditEvent(db, input.workspaceId, {
      action: 'billing.credit-note.issued',
      actorType: input.actorPlatformUserId
        ? 'PLATFORM_USER'
        : input.actorUserId
          ? 'USER'
          : 'SYSTEM',
      actorId: input.actorPlatformUserId ?? input.actorUserId ?? undefined,
      resourceType: 'CreditNote',
      resourceId: note.id,
      reason: input.reason,
      severity: 'NOTICE',
      after: {
        number,
        invoiceId: invoice.id,
        totalMinor: total.minorUnits.toString(),
        currency: total.currency,
      },
    });

    return toCreditNoteView(note);
  }

  /**
   * Move the money back through the provider.
   *
   * IDEMPOTENT AT THE PROVIDER, not only here: the credit note's own
   * `idempotencyKey` is what is sent, so a retried refund returns the same
   * provider refund rather than paying the customer twice. A provider that
   * cannot refund at all is refused before anything is attempted, because its
   * capabilities say so (§24).
   */
  async refund(
    db: TenantScopedClient,
    provider: PaymentProviderAdapter,
    input: { readonly workspaceId: string; readonly creditNoteId: string },
  ): Promise<CreditNoteView> {
    const note = await db.creditNote.findFirst({
      where: { workspaceId: input.workspaceId, id: input.creditNoteId },
    });
    if (!note) throw new AppError('NOT_FOUND', 'Credit note not found.');
    if (note.status === 'REFUNDED') return toCreditNoteView(note);
    if (note.status !== 'ISSUED') {
      throw new AppError('CONFLICT', 'Only an issued credit note can be refunded.');
    }

    const invoice = await db.invoice.findFirst({
      where: { workspaceId: input.workspaceId, id: note.invoiceId },
      select: { providerPaymentId: true, totalMinor: true },
    });
    if (!invoice?.providerPaymentId) {
      throw new AppError('CONFLICT', 'That invoice has no payment to refund.');
    }

    const capabilities = provider.capabilities();
    if (!capabilities.refunds) {
      throw new AppError('CONFLICT', 'The payment provider for this invoice cannot refund.');
    }
    const partial = note.totalMinor < invoice.totalMinor;
    if (partial && !capabilities.partialRefunds) {
      throw new AppError('CONFLICT', 'The payment provider cannot make a partial refund.');
    }

    const amount = Money.ofMinor(note.currency, note.totalMinor, note.currencyScale);
    const result = await provider.refund({
      providerPaymentId: invoice.providerPaymentId,
      amount,
      reason: note.reason,
      idempotencyKey: note.idempotencyKey,
    });

    const updated = await db.creditNote.update({
      where: { id: note.id },
      data: {
        status: 'REFUNDED',
        refundedAt: this.#clock.now(),
        providerRefundId: result.providerRefundId,
      },
    });

    await writeAuditEvent(db, input.workspaceId, {
      action: 'billing.credit-note.refunded',
      actorType: 'SYSTEM',
      resourceType: 'CreditNote',
      resourceId: note.id,
      severity: 'NOTICE',
      after: {
        providerRefundId: result.providerRefundId,
        totalMinor: note.totalMinor.toString(),
        currency: note.currency,
      },
    });

    return toCreditNoteView(updated);
  }

  async list(
    db: TenantScopedClient,
    workspaceId: string,
    invoiceId?: string,
  ): Promise<readonly CreditNoteView[]> {
    const rows = await db.creditNote.findMany({
      where: { workspaceId, ...(invoiceId ? { invoiceId } : {}) },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    return rows.map(toCreditNoteView);
  }
}

interface CreditNoteRow {
  id: string;
  workspaceId: string;
  invoiceId: string;
  number: string | null;
  status: string;
  currency: string;
  currencyScale: number;
  subtotalMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  reason: string;
  issuedAt: Date | null;
  refundedAt: Date | null;
}

export function toCreditNoteView(row: CreditNoteRow): CreditNoteView {
  const money = (minor: bigint): Money => Money.ofMinor(row.currency, minor, row.currencyScale);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    invoiceId: row.invoiceId,
    number: row.number,
    status: row.status as CreditNoteView['status'],
    subtotal: money(row.subtotalMinor),
    tax: money(row.taxMinor),
    total: money(row.totalMinor),
    reason: row.reason,
    issuedAt: row.issuedAt,
    refundedAt: row.refundedAt,
  };
}
