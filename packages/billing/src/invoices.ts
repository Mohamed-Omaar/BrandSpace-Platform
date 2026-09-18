/**
 * BrandSpace invoices — our own commercial documents.
 *
 * NOT A MIRROR OF A PROVIDER'S RECORD. The provider moves money; the invoice is
 * the seller's document, numbered in the seller's own series, in the currency
 * the customer agreed to, carrying the seller's tax identity. Changing payment
 * provider must not renumber a single historical invoice, and it cannot, because
 * no part of this file asks a provider what an invoice is.
 *
 * IMMUTABLE ONCE ISSUED (§29). `issue()` is the only transition that allocates a
 * number, and after it there is no path here that edits an amount, a line or a
 * party. A correction is a credit note (`credit-notes.ts`) — a second document,
 * which is how accounting works and how an audit trail stays believable.
 *
 * THE SNAPSHOTS ARE THE POINT. `commercialSnapshot` freezes the plan, the price,
 * the interval and the configuration version; `partiesSnapshot` freezes who sold
 * and who bought, as printed. A customer who moves office, or an owner who
 * raises a price, changes nothing about a document already issued (§25).
 *
 * WHO MAY ISSUE. Numbering runs through `app.allocate_invoice_number()`, which
 * only the platform role may execute. Issuance is a SYSTEM act in response to an
 * authoritative provider event — never something a customer request performs —
 * so `issue()` must be handed a platform-scoped client. A tenant connection is
 * refused by PostgreSQL, not by a check in this file.
 */

import type { Prisma, TenantScopedClient } from '@brandspace/database';
import { writeAuditEvent } from '@brandspace/database';
import { AppError, Money, type Clock, systemClock } from '@brandspace/shared';
import type { CommercePolicy, LocalizedText } from './commerce';
import type { TaxAssessment } from './tax';

export interface InvoiceLineInput {
  readonly kind: 'SUBSCRIPTION' | 'CREDIT_PACK' | 'PRORATION' | 'SEAT' | 'ADDON' | 'DISCOUNT';
  /** BOTH LANGUAGES, written now (§31). A PDF is produced from the row, not
   *  from a catalogue that has since moved on. */
  readonly description: LocalizedText;
  readonly quantity: number;
  readonly unitAmount: Money;
  readonly amount: Money;
  readonly tax: Money;
  readonly metadata?: Record<string, unknown>;
}

export interface DraftInvoiceInput {
  readonly workspaceId: string;
  readonly assessment: TaxAssessment;
  readonly lines: readonly InvoiceLineInput[];
  readonly checkoutSessionId?: string | null;
  readonly periodStart?: Date | null;
  readonly periodEnd?: Date | null;
  readonly commercialSnapshot: Record<string, unknown>;
  readonly providerKey?: string | null;
}

export interface InvoiceView {
  readonly id: string;
  readonly workspaceId: string;
  readonly number: string | null;
  readonly status: 'DRAFT' | 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly total: Money;
  readonly amountPaid: Money;
  readonly credited: Money;
  readonly taxMode: 'NONE' | 'EXCLUSIVE' | 'INCLUSIVE';
  readonly taxRateBasisPoints: number;
  readonly issuedAt: Date | null;
  readonly paidAt: Date | null;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly currency: string;
  readonly currencyScale: number;
}

export interface InvoiceServiceOptions {
  readonly clock?: Clock;
}

export class InvoiceService {
  readonly #clock: Clock;

  constructor(options: InvoiceServiceOptions = {}) {
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Assemble a DRAFT. No number, not a commercial document, discardable.
   *
   * THE LINES ARE CHECKED AGAINST THE TOTAL before anything is written. A
   * document whose lines do not add up to what the customer is charged is worse
   * than no document, and the database's own CHECK would refuse it anyway — this
   * turns that refusal into a readable error at the place that caused it.
   */
  async draft(db: TenantScopedClient, input: DraftInvoiceInput): Promise<InvoiceView> {
    const { assessment } = input;
    if (input.lines.length === 0) {
      throw new AppError('VALIDATION_FAILED', 'An invoice needs at least one line.');
    }

    let lineTotal = Money.zero(assessment.subtotal.currency, assessment.subtotal.scale);
    let lineTax = Money.zero(assessment.tax.currency, assessment.tax.scale);
    for (const line of input.lines) {
      // `plus` refuses a different currency or scale outright, so a line in the
      // wrong denomination cannot be silently summed into the total.
      lineTotal = lineTotal.plus(line.amount);
      lineTax = lineTax.plus(line.tax);
    }
    if (!lineTotal.equals(assessment.subtotal)) {
      throw new AppError('VALIDATION_FAILED', 'The invoice lines do not add up to its subtotal.', {
        lines: lineTotal.toDecimalString(),
        subtotal: assessment.subtotal.toDecimalString(),
      });
    }
    if (!lineTax.equals(assessment.tax)) {
      throw new AppError('VALIDATION_FAILED', 'The line tax does not add up to the invoice tax.');
    }

    const invoice = await db.invoice.create({
      data: {
        workspaceId: input.workspaceId,
        status: 'DRAFT',
        currency: assessment.subtotal.currency,
        currencyScale: assessment.subtotal.scale,
        subtotalMinor: assessment.subtotal.minorUnits,
        discountMinor: 0n,
        taxMinor: assessment.tax.minorUnits,
        totalMinor: assessment.total.minorUnits,
        taxMode: assessment.mode,
        taxRateBasisPoints: assessment.rateBasisPoints,
        taxPolicyKey: assessment.policyKey,
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        commercialSnapshot: input.commercialSnapshot as Prisma.InputJsonValue,
        // Filled at issue, when the seller and buyer identities are frozen.
        partiesSnapshot: {} as Prisma.InputJsonValue,
        providerKey: input.providerKey ?? null,
        checkoutSessionId: input.checkoutSessionId ?? null,
      },
    });

    await db.invoiceLine.createMany({
      data: input.lines.map((line, index) => ({
        workspaceId: input.workspaceId,
        invoiceId: invoice.id,
        kind: line.kind,
        description: line.description as unknown as Prisma.InputJsonValue,
        quantity: line.quantity,
        unitAmountMinor: line.unitAmount.minorUnits,
        amountMinor: line.amount.minorUnits,
        taxAmountMinor: line.tax.minorUnits,
        metadata: (line.metadata ?? null) as Prisma.InputJsonValue,
        sortOrder: index,
      })),
    });

    return toInvoiceView(invoice);
  }

  /**
   * Issue the draft: allocate a number, freeze the parties, make it immutable.
   *
   * THE NUMBER IS ALLOCATED INSIDE THIS TRANSACTION. The allocator takes a row
   * lock on the counter, so two simultaneous issues get two different numbers;
   * and because it is a table rather than a sequence, an issue that rolls back
   * returns its number to the pool and the series stays gapless — which several
   * of the markets this platform sells in expect, and which a PostgreSQL
   * sequence cannot provide (§30).
   *
   * IDEMPOTENT. An invoice that already has a number is returned as it stands.
   * A retried reconciliation must never burn a second number on the same
   * document.
   */
  async issue(
    db: TenantScopedClient,
    input: {
      readonly workspaceId: string;
      readonly invoiceId: string;
      readonly policy: CommercePolicy;
      readonly dueInDays?: number;
    },
  ): Promise<InvoiceView> {
    const invoice = await db.invoice.findFirst({
      where: { workspaceId: input.workspaceId, id: input.invoiceId },
    });
    if (!invoice) throw new AppError('NOT_FOUND', 'Invoice not found.');
    if (invoice.status !== 'DRAFT' || invoice.number !== null) {
      return toInvoiceView(invoice);
    }

    const now = this.#clock.now();
    const identity = input.policy.invoice;
    const number = await allocateInvoiceNumber(
      db,
      identity.numberPrefix,
      now.getUTCFullYear(),
      identity.numberPadding,
    );

    const profile = await db.billingProfile.findFirst({
      where: { workspaceId: input.workspaceId },
    });
    const workspace = await db.workspace.findFirst({
      where: { workspaceId: input.workspaceId },
      select: { name: true, legalName: true, country: true },
    });

    const parties = {
      seller: {
        legalName: identity.legalName,
        address: identity.address,
        taxRegistrationNumber: identity.taxRegistrationNumber,
        footerNote: identity.footerNote,
      },
      buyer: {
        legalName: profile?.legalName ?? workspace?.legalName ?? workspace?.name ?? null,
        billingEmail: profile?.billingEmail ?? null,
        taxId: profile?.taxId ?? null,
        address: profile
          ? {
              line1: profile.addressLine1,
              line2: profile.addressLine2,
              city: profile.city,
              region: profile.region,
              postalCode: profile.postalCode,
              country: profile.country,
            }
          : null,
      },
    };

    const issued = await db.invoice.update({
      where: { id: invoice.id },
      data: {
        number,
        status: 'OPEN',
        issuedAt: now,
        dueAt:
          input.dueInDays && input.dueInDays > 0
            ? new Date(now.getTime() + input.dueInDays * 86_400_000)
            : now,
        partiesSnapshot: parties as unknown as Prisma.InputJsonValue,
      },
    });

    await writeAuditEvent(db, input.workspaceId, {
      action: 'billing.invoice.issued',
      actorType: 'SYSTEM',
      resourceType: 'Invoice',
      resourceId: invoice.id,
      after: { number, totalMinor: issued.totalMinor.toString(), currency: issued.currency },
    });

    return toInvoiceView(issued);
  }

  /**
   * Record that an issued invoice was paid.
   *
   * ONLY FROM AN AUTHORITATIVE EVENT. Nothing on a browser redirect path reaches
   * here (§22), and a conditional UPDATE on `status = 'OPEN'` means a replayed
   * event finds nothing to change rather than paying it twice.
   */
  async markPaid(
    db: TenantScopedClient,
    input: {
      readonly workspaceId: string;
      readonly invoiceId: string;
      readonly providerPaymentId: string | null;
      readonly paidAt: Date;
    },
  ): Promise<boolean> {
    const invoice = await db.invoice.findFirst({
      where: { workspaceId: input.workspaceId, id: input.invoiceId },
      select: { id: true, totalMinor: true, status: true },
    });
    if (!invoice || invoice.status !== 'OPEN') return false;

    const { count } = await db.invoice.updateMany({
      where: { workspaceId: input.workspaceId, id: input.invoiceId, status: 'OPEN' },
      data: {
        status: 'PAID',
        paidAt: input.paidAt,
        amountPaidMinor: invoice.totalMinor,
        providerPaymentId: input.providerPaymentId,
      },
    });
    if (count === 0) return false;

    await writeAuditEvent(db, input.workspaceId, {
      action: 'billing.invoice.paid',
      actorType: 'SYSTEM',
      resourceType: 'Invoice',
      resourceId: input.invoiceId,
    });
    return true;
  }

  /**
   * Void an invoice that was never paid.
   *
   * A PAID INVOICE IS NOT VOIDABLE. Money that moved is corrected by a credit
   * note, which leaves both documents standing — voiding one would erase the
   * record of a payment that really happened.
   */
  async voidInvoice(
    db: TenantScopedClient,
    input: {
      readonly workspaceId: string;
      readonly invoiceId: string;
      readonly reason: string;
      readonly actorUserId?: string | null;
    },
  ): Promise<boolean> {
    const { count } = await db.invoice.updateMany({
      where: {
        workspaceId: input.workspaceId,
        id: input.invoiceId,
        status: { in: ['OPEN', 'UNCOLLECTIBLE'] },
      },
      data: { status: 'VOID', voidedAt: this.#clock.now() },
    });
    if (count === 0) return false;
    await writeAuditEvent(db, input.workspaceId, {
      action: 'billing.invoice.voided',
      actorType: input.actorUserId ? 'PLATFORM_USER' : 'SYSTEM',
      actorId: input.actorUserId ?? undefined,
      resourceType: 'Invoice',
      resourceId: input.invoiceId,
      reason: input.reason,
      severity: 'NOTICE',
    });
    return true;
  }

  async list(
    db: TenantScopedClient,
    workspaceId: string,
    options: { readonly take?: number; readonly cursor?: string } = {},
  ): Promise<readonly InvoiceView[]> {
    const rows = await db.invoice.findMany({
      where: { workspaceId, status: { not: 'DRAFT' } },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(options.take ?? 25, 100),
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
    return rows.map(toInvoiceView);
  }

  async get(
    db: TenantScopedClient,
    workspaceId: string,
    invoiceId: string,
  ): Promise<{ readonly invoice: InvoiceView; readonly lines: readonly RenderedLine[] } | null> {
    const row = await db.invoice.findFirst({ where: { workspaceId, id: invoiceId } });
    if (!row) return null;
    const lines = await db.invoiceLine.findMany({
      where: { workspaceId, invoiceId },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      invoice: toInvoiceView(row),
      lines: lines.map((line) => ({
        id: line.id,
        kind: line.kind as InvoiceLineInput['kind'],
        description: line.description as unknown as LocalizedText,
        quantity: line.quantity,
        unitAmount: Money.ofMinor(row.currency, line.unitAmountMinor, row.currencyScale),
        amount: Money.ofMinor(row.currency, line.amountMinor, row.currencyScale),
        tax: Money.ofMinor(row.currency, line.taxAmountMinor, row.currencyScale),
      })),
    };
  }
}

export interface RenderedLine {
  readonly id: string;
  readonly kind: InvoiceLineInput['kind'];
  readonly description: LocalizedText;
  readonly quantity: number;
  readonly unitAmount: Money;
  readonly amount: Money;
  readonly tax: Money;
}

/**
 * Allocate the next number in the seller's series.
 *
 * REFUSED FOR A TENANT CONNECTION by PostgreSQL itself: only the platform role
 * holds EXECUTE. That is the guarantee — not this comment, and not a check a
 * future caller could forget.
 */
export async function allocateInvoiceNumber(
  db: TenantScopedClient,
  prefix: string,
  year: number,
  padding: number,
): Promise<string> {
  const rows = await db.$queryRaw<Array<{ number: string }>>`
    SELECT app.allocate_invoice_number(${prefix}::text, ${year}::integer, ${padding}::integer) AS number
  `;
  const number = rows[0]?.number;
  if (!number) {
    throw new AppError('INTERNAL', 'The invoice number series returned nothing.');
  }
  return number;
}

interface InvoiceRow {
  id: string;
  workspaceId: string;
  number: string | null;
  status: string;
  currency: string;
  currencyScale: number;
  subtotalMinor: bigint;
  discountMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint;
  amountPaidMinor: bigint;
  creditedMinor: bigint;
  taxMode: string;
  taxRateBasisPoints: number;
  issuedAt: Date | null;
  paidAt: Date | null;
  periodStart: Date | null;
  periodEnd: Date | null;
}

export function toInvoiceView(row: InvoiceRow): InvoiceView {
  const money = (minor: bigint): Money => Money.ofMinor(row.currency, minor, row.currencyScale);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    number: row.number,
    status: row.status as InvoiceView['status'],
    subtotal: money(row.subtotalMinor),
    discount: money(row.discountMinor),
    tax: money(row.taxMinor),
    total: money(row.totalMinor),
    amountPaid: money(row.amountPaidMinor),
    credited: money(row.creditedMinor),
    taxMode: row.taxMode as InvoiceView['taxMode'],
    taxRateBasisPoints: row.taxRateBasisPoints,
    issuedAt: row.issuedAt,
    paidAt: row.paidAt,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    currency: row.currency,
    currencyScale: row.currencyScale,
  };
}
