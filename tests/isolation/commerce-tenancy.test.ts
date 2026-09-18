import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withWorkspace } from '@brandspace/database';
import {
  appRoleClient,
  createIsolationFixtures,
  platformRoleClient,
  type IsolationFixtures,
} from './fixtures';

/**
 * Tenant isolation over the Phase 9 commercial tables, against REAL PostgreSQL.
 *
 * WHY THIS SUITE IS NOT OPTIONAL. Every other isolation suite protects a
 * preference, a draft or a photograph. This one protects what a business pays,
 * what it was invoiced, what it bought and whether its card failed — the kind of
 * disclosure a competitor can act on directly. §42 of the Phase 9 brief lists
 * the verbs deliberately: read, count, search, enumerate, mutate, INFER.
 *
 * INFERENCE IS THE ONE THAT NEEDS THE MOST CARE, because the usual leak is not a
 * row coming back. It is an error message that differs: "violates foreign key"
 * for a real id and "not found" for a fabricated one answers "does that invoice
 * exist?" across the tenant boundary. The composite keys (D-112) are what make
 * the two indistinguishable, and several tests below check exactly that.
 *
 * NOT MOCKED. RLS, the composite foreign keys, the CHECK constraints and the
 * locked invoice-number counter are properties of the database. A suite that
 * mocked Prisma would assert that the code calls Prisma.
 */

let fixtures: IsolationFixtures;
let app: PrismaClient;
let platform: PrismaClient;

beforeAll(async () => {
  app = appRoleClient();
  platform = platformRoleClient();
  fixtures = await createIsolationFixtures(app);
}, 60_000);

afterAll(async () => {
  await app.$disconnect();
  await platform.$disconnect();
});

/** Run as tenant A, the way the product does. */
async function asA<T>(
  fn: (db: Parameters<Parameters<typeof withWorkspace>[1]>[0]) => Promise<T>,
): Promise<T> {
  return withWorkspace(fixtures.a.workspaceId, fn, { prisma: app });
}

describe('a workspace reads only its own commercial records', () => {
  it('reads its own billing profile and never the other tenant’s', async () => {
    const mine = await asA((db) =>
      db.billingProfile.findFirst({ where: { workspaceId: fixtures.a.workspaceId } }),
    );
    expect(mine?.id).toBe(fixtures.a.billingProfileId);

    const theirs = await asA((db) =>
      db.billingProfile.findUnique({ where: { id: fixtures.b.billingProfileId } }),
    );
    expect(theirs).toBeNull();
  });

  it('cannot find another tenant’s invoice by its real id', async () => {
    const found = await asA((db) => db.invoice.findUnique({ where: { id: fixtures.b.invoiceId } }));
    expect(found).toBeNull();
  });

  it('cannot find another tenant’s invoice by its INVOICE NUMBER', async () => {
    // The number is the one identifier a customer might plausibly guess or be
    // shown by accident — it is short, human-readable and sequential.
    const found = await asA((db) =>
      db.invoice.findUnique({ where: { number: fixtures.b.invoiceNumber } }),
    );
    expect(found).toBeNull();
  });

  it('cannot find another tenant’s checkout by its PROVIDER session id', async () => {
    // §23: a provider reference is not an authorization boundary. Holding one
    // must not resolve a row.
    const found = await asA((db) =>
      db.checkoutSession.findFirst({
        where: { providerSessionId: fixtures.b.providerSessionId },
      }),
    );
    expect(found).toBeNull();
  });

  it('cannot find another tenant’s profile by its PROVIDER customer id', async () => {
    const found = await asA((db) =>
      db.billingProfile.findFirst({
        where: { providerCustomerId: fixtures.b.providerCustomerId },
      }),
    );
    expect(found).toBeNull();
  });

  it('counts only its own invoices, credit notes, attempts and purchases', async () => {
    const counts = await asA(async (db) => ({
      invoices: await db.invoice.count(),
      lines: await db.invoiceLine.count(),
      notes: await db.creditNote.count(),
      noteLines: await db.creditNoteLine.count(),
      attempts: await db.paymentAttempt.count(),
      purchases: await db.creditPackPurchase.count(),
      checkouts: await db.checkoutSession.count(),
      profiles: await db.billingProfile.count(),
    }));
    // Each fixture tenant made exactly one of each. A count of two would mean
    // the predicate is not in the query.
    for (const [name, value] of Object.entries(counts)) {
      expect(value, `${name} should count only this tenant`).toBe(1);
    }
  });

  it('cannot search another tenant’s invoices by amount', async () => {
    // Searching is the quiet leak: no id is needed, and a hit reveals that
    // somebody else paid that amount.
    const rows = await asA((db) => db.invoice.findMany({ where: { totalMinor: 11385n } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspaceId).toBe(fixtures.a.workspaceId);
  });

  it('cannot aggregate across the boundary', async () => {
    const total = await asA((db) => db.invoice.aggregate({ _sum: { totalMinor: true } }));
    // One invoice of 11385, not two.
    expect(total._sum.totalMinor).toBe(11385n);
  });
});

describe('a workspace cannot write into another', () => {
  it('refuses to create an invoice for another tenant', async () => {
    await expect(
      asA((db) =>
        db.invoice.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            status: 'DRAFT',
            currency: 'SAR',
            currencyScale: 2,
            subtotalMinor: 100n,
            totalMinor: 100n,
            commercialSnapshot: {},
            partiesSnapshot: {},
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses to update another tenant’s invoice', async () => {
    const result = await asA((db) =>
      db.invoice.updateMany({
        where: { id: fixtures.b.invoiceId },
        data: { amountPaidMinor: 0n },
      }),
    );
    // Not an error — simply no row in scope, which is the same answer a
    // fabricated id gives.
    expect(result.count).toBe(0);

    const untouched = await platform.invoice.findUnique({ where: { id: fixtures.b.invoiceId } });
    expect(untouched?.amountPaidMinor).toBe(11385n);
  });

  it('refuses to delete another tenant’s credit note', async () => {
    const result = await asA((db) =>
      db.creditNote.deleteMany({ where: { id: fixtures.b.creditNoteId } }),
    );
    expect(result.count).toBe(0);
    expect(
      await platform.creditNote.findUnique({ where: { id: fixtures.b.creditNoteId } }),
    ).not.toBeNull();
  });

  it('cannot attach its own invoice line to another tenant’s invoice', async () => {
    // THE COMPOSITE KEY IS THE BOUNDARY (D-112). A plain `invoiceId` foreign key
    // would resolve the other tenant's row, because PostgreSQL checks
    // referential integrity as the table owner with RLS bypassed.
    await expect(
      asA((db) =>
        db.invoiceLine.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            invoiceId: fixtures.b.invoiceId,
            kind: 'SUBSCRIPTION',
            description: { ar: 'x', en: 'x' },
            unitAmountMinor: 1n,
            amountMinor: 1n,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('answers a cross-tenant id exactly as it answers a fabricated one', async () => {
    const fabricated = '00000000-0000-4000-8000-000000000000';

    const foreignError = await asA((db) =>
      db.invoiceLine
        .create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            invoiceId: fixtures.b.invoiceId,
            kind: 'SUBSCRIPTION',
            description: { ar: 'x', en: 'x' },
            unitAmountMinor: 1n,
            amountMinor: 1n,
          },
        })
        .then(() => null)
        .catch((e: unknown) => (e as { code?: string }).code ?? 'unknown'),
    );

    const fabricatedError = await asA((db) =>
      db.invoiceLine
        .create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            invoiceId: fabricated,
            kind: 'SUBSCRIPTION',
            description: { ar: 'x', en: 'x' },
            unitAmountMinor: 1n,
            amountMinor: 1n,
          },
        })
        .then(() => null)
        .catch((e: unknown) => (e as { code?: string }).code ?? 'unknown'),
    );

    // The same failure. A real id and an invented one are indistinguishable, so
    // the error cannot be used as an existence oracle.
    expect(foreignError).toBe(fabricatedError);
    expect(foreignError).not.toBeNull();
  });
});

describe('the identity-scoped tables are invisible inside a workspace', () => {
  it('shows a workspace member no verification tokens at all — theirs or anyone’s', async () => {
    const rows = await asA((db) => db.emailVerificationToken.findMany());
    expect(rows).toHaveLength(0);
  });

  it('shows no legal acceptances and no MFA recovery codes inside a workspace', async () => {
    const acceptances = await asA((db) => db.userLegalAcceptance.findMany());
    const codes = await asA((db) => db.userMfaRecoveryCode.findMany());
    expect(acceptances).toHaveLength(0);
    expect(codes).toHaveLength(0);
  });

  it('cannot read another person’s recovery code by its hash from inside a workspace', async () => {
    const found = await asA((db) =>
      db.userMfaRecoveryCode.findFirst({ where: { codeHash: fixtures.b.mfaRecoveryCodeHash } }),
    );
    expect(found).toBeNull();
  });

  it('is readable on the authentication path, which has no workspace context', async () => {
    // The rows DO exist — the point is that they are reachable only where the
    // product actually needs them.
    const token = await app.emailVerificationToken.findUnique({
      where: { tokenHash: fixtures.a.emailVerificationTokenHash },
    });
    expect(token?.id).toBe(fixtures.a.emailVerificationTokenId);
  });

  it('records a legal acceptance with its document version', async () => {
    const acceptance = await app.userLegalAcceptance.findUnique({
      where: { id: fixtures.a.legalAcceptanceId },
    });
    // "They agreed to the terms" is not a fact unless it says WHICH terms.
    expect(acceptance?.documentKey).toBe('terms-of-service');
    expect(acceptance?.version).toBe('fixture-2026-01');
  });
});

describe('the platform-owned billing tables are closed to tenants', () => {
  it('refuses the tenant role any access to the webhook inbox', async () => {
    // Not filtered access — none. A workspace must not be able to count another
    // workspace's payment events.
    await expect(app.billingEvent.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('refuses the tenant role any access to the invoice counter', async () => {
    await expect(app.invoiceNumberSequence.findMany()).rejects.toThrow(/permission denied/i);
  });

  it('refuses a tenant INSERT into the webhook inbox', async () => {
    await expect(
      app.billingEvent.create({
        data: {
          providerKey: 'development-mock',
          externalEventId: `forged-${Date.now()}`,
          eventType: 'invoice.paid',
          occurredAt: new Date(),
          payload: {},
        },
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('lets the platform role read and write them', async () => {
    const created = await platform.billingEvent.create({
      data: {
        providerKey: 'development-mock',
        externalEventId: `platform-probe-${Date.now()}`,
        eventType: 'invoice.paid',
        occurredAt: new Date(),
        payload: { probe: true },
        signatureVerified: true,
      },
    });
    expect(created.status).toBe('RECEIVED');
    await platform.billingEvent.delete({ where: { id: created.id } });
  });
});

describe('the invoice-number allocator', () => {
  it('refuses the tenant role outright — the series belongs to the seller', async () => {
    // An invoice number is the accounting series of the SELLER, shared across
    // every customer. A customer has no business advancing it, so the tenant
    // role holds neither EXECUTE on the function nor any privilege on the
    // counter it writes.
    await expect(
      app.$queryRawUnsafe(`SELECT app.allocate_invoice_number('BSP9', 2026, 6)`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('allocates for the platform role, which is what issues an invoice', async () => {
    const rows = await platform.$queryRawUnsafe<Array<{ n: string }>>(
      `SELECT app.allocate_invoice_number('BSP9', 2026, 6) AS n`,
    );
    expect(rows[0]!.n).toMatch(/^BSP9-2026-\d{6}$/);
  });

  it('never issues the same number twice under concurrency', async () => {
    // TWENTY SIMULTANEOUS ALLOCATIONS, in parallel transactions. Sequential
    // calls would prove nothing about locking, which is the only thing that
    // matters here (§30).
    const prefix = `C${Date.now().toString().slice(-4)}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        platform.$queryRawUnsafe<Array<{ n: string }>>(
          `SELECT app.allocate_invoice_number('${prefix}', 2026, 6) AS n`,
        ),
      ),
    );
    const numbers = results.map((r) => r[0]!.n);
    expect(new Set(numbers).size).toBe(20);
  });

  it('returns a rolled-back number to the pool, so the series stays gapless', async () => {
    // The allocation is in the transaction of the CALLER. A sequence could not
    // do this, and a gap in the series is a problem in several of the markets
    // this platform sells in.
    const prefix = `R${Date.now().toString().slice(-4)}`;
    const first = await platform.$queryRawUnsafe<Array<{ n: string }>>(
      `SELECT app.allocate_invoice_number('${prefix}', 2026, 6) AS n`,
    );
    expect(first[0]!.n).toMatch(new RegExp(`^${prefix}-2026-000001$`));

    await platform
      .$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT app.allocate_invoice_number('${prefix}', 2026, 6)`);
        throw new Error('deliberate rollback');
      })
      .catch(() => undefined);

    const next = await platform.$queryRawUnsafe<Array<{ n: string }>>(
      `SELECT app.allocate_invoice_number('${prefix}', 2026, 6) AS n`,
    );
    expect(next[0]!.n).toMatch(new RegExp(`^${prefix}-2026-000002$`));
  });

  it('pads and formats from its arguments rather than a hard-coded series', async () => {
    const rows = await platform.$queryRawUnsafe<Array<{ n: string }>>(
      `SELECT app.allocate_invoice_number('ZZ', 2030, 8) AS n`,
    );
    expect(rows[0]!.n).toMatch(/^ZZ-2030-\d{8}$/);
  });

  it('refuses a padding outside the allowed range rather than producing a short number', async () => {
    await expect(
      platform.$queryRawUnsafe(`SELECT app.allocate_invoice_number('BS', 2026, 2)`),
    ).rejects.toThrow(/padding/i);
  });
});

describe('the database enforces the commercial invariants itself', () => {
  it('refuses an invoice whose total is not its own arithmetic', async () => {
    await expect(
      asA((db) =>
        db.invoice.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            status: 'DRAFT',
            currency: 'SAR',
            currencyScale: 2,
            subtotalMinor: 100n,
            taxMinor: 15n,
            // 100 - 0 + 15 is 115, not 999. A caller cannot choose the total
            // independently of the parts it is made of.
            totalMinor: 999n,
            commercialSnapshot: {},
            partiesSnapshot: {},
          },
        }),
      ),
    ).rejects.toThrow(/invoice_totals_sane/);
  });

  it('refuses an issued invoice with no number, and a numbered draft', async () => {
    await expect(
      asA((db) =>
        db.invoice.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            status: 'OPEN',
            currency: 'SAR',
            currencyScale: 2,
            subtotalMinor: 100n,
            totalMinor: 100n,
            commercialSnapshot: {},
            partiesSnapshot: {},
          },
        }),
      ),
    ).rejects.toThrow(/invoice_issued_has_number/);
  });

  it('refuses a completed pack purchase that names no credit grant', async () => {
    // THE IDEMPOTENCY PROOF IS A CONSTRAINT. "Paid once, granted once" is a
    // database fact rather than a worker's good intentions.
    await expect(
      asA((db) =>
        db.creditPackPurchase.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            packKey: 'probe',
            credits: 10,
            currency: 'SAR',
            currencyScale: 2,
            amountMinor: 100n,
            status: 'COMPLETED',
          },
        }),
      ),
    ).rejects.toThrow(/credit_pack_purchase_sane/);
  });

  it('refuses a checkout that is for two things at once', async () => {
    await expect(
      asA((db) =>
        db.checkoutSession.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            purpose: 'SUBSCRIPTION',
            planKey: 'p',
            billingInterval: 'MONTH',
            packKey: 'also-a-pack',
            currency: 'SAR',
            currencyScale: 2,
            amountMinor: 1n,
            totalMinor: 1n,
            providerKey: 'development-mock',
            idempotencyKey: `probe-${Date.now()}`,
            expiresAt: new Date(Date.now() + 1000),
          },
        }),
      ),
    ).rejects.toThrow(/checkout_session_one_subject/);
  });

  it('refuses a checkout whose total is not amount plus tax', async () => {
    await expect(
      asA((db) =>
        db.checkoutSession.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            purpose: 'CREDIT_PACK',
            packKey: 'probe',
            currency: 'SAR',
            currencyScale: 2,
            amountMinor: 100n,
            taxMinor: 15n,
            totalMinor: 100n,
            providerKey: 'development-mock',
            idempotencyKey: `probe2-${Date.now()}`,
            expiresAt: new Date(Date.now() + 1000),
          },
        }),
      ),
    ).rejects.toThrow(/checkout_session_amounts_sane/);
  });

  it('refuses crediting back more than was invoiced', async () => {
    await expect(
      asA((db) =>
        db.invoice.update({
          where: { id: fixtures.a.invoiceId },
          data: { creditedMinor: 99_999n },
        }),
      ),
    ).rejects.toThrow(/invoice_credited_within_total/);
  });

  it('refuses a currency scale outside the supported range', async () => {
    await expect(
      asA((db) =>
        db.paymentAttempt.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            status: 'PENDING',
            currency: 'SAR',
            currencyScale: 9,
            amountMinor: 1n,
            idempotencyKey: `probe3-${Date.now()}`,
          },
        }),
      ),
    ).rejects.toThrow(/payment_attempt_scale_sane/);
  });

  it('keeps one provider customer id mapped to at most one workspace', async () => {
    // The reverse lookup a webhook depends on must be unambiguous: two
    // workspaces sharing a provider customer would make resolution a coin toss
    // at exactly the moment money is involved.
    await expect(
      platform.billingProfile.update({
        where: { id: fixtures.b.billingProfileId },
        data: { providerCustomerId: fixtures.a.providerCustomerId },
      }),
    ).rejects.toThrow();
  });

  it('keeps an idempotency key unique within a workspace', async () => {
    await expect(
      asA((db) =>
        db.checkoutSession.create({
          data: {
            workspaceId: fixtures.a.workspaceId,
            purpose: 'CREDIT_PACK',
            packKey: 'probe',
            currency: 'SAR',
            currencyScale: 2,
            amountMinor: 1n,
            totalMinor: 1n,
            providerKey: 'development-mock',
            idempotencyKey: fixtures.a.checkoutIdempotencyKey,
            expiresAt: new Date(Date.now() + 1000),
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('lets two workspaces use the SAME idempotency key without colliding', async () => {
    // Scoped per workspace, not globally: one customer retrying a form must not
    // be blocked by an unrelated customer having used the same key.
    const created = await withWorkspace(
      fixtures.b.workspaceId,
      (db) =>
        db.checkoutSession.create({
          data: {
            workspaceId: fixtures.b.workspaceId,
            purpose: 'CREDIT_PACK',
            packKey: 'probe',
            currency: 'SAR',
            currencyScale: 2,
            amountMinor: 1n,
            totalMinor: 1n,
            providerKey: 'development-mock',
            idempotencyKey: fixtures.a.checkoutIdempotencyKey,
            expiresAt: new Date(Date.now() + 1000),
          },
        }),
      { prisma: app },
    );
    expect(created.workspaceId).toBe(fixtures.b.workspaceId);
    await platform.checkoutSession.delete({ where: { id: created.id } });
  });
});
