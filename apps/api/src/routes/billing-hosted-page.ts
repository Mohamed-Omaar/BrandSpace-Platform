import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DEVELOPMENT_PROVIDER_KEY,
  DevelopmentPaymentProvider,
  paidCheckoutEvent,
  signedDelivery,
} from '@brandspace/billing';
import { getPlatformClient } from '@brandspace/database/platform';
import { Money, createLogger, internalErrorFields, systemClock } from '@brandspace/shared';
import { route } from '../route-contract';
import { currentEnvironment } from './phase7-context';
import { providerFor } from './phase9-context';

/**
 * The DEVELOPMENT provider's hosted page — a stand-in for somebody else's site.
 *
 * WHAT IT IS SIMULATING. A real hosted checkout is a page on the PROVIDER's
 * domain: BrandSpace redirects to it, the customer enters an instrument there,
 * and BrandSpace learns the outcome from a signed server-to-server event. This
 * page plays that role so every one of those steps is exercised for real before
 * a vendor is chosen (D-204).
 *
 * IT IS NOT AVAILABLE IN PRODUCTION. Registration is refused when
 * `APP_ENV=production`, so the route does not exist rather than existing and
 * refusing — there is nothing to misconfigure back on.
 *
 * IT COLLECTS NOTHING. There is no card field, because the point of hosted
 * checkout is that no instrument ever reaches BrandSpace. The page shows what is
 * being bought, read from OUR OWN checkout row by id, and offers two buttons:
 * pay, and cancel.
 *
 * AND PRESSING "PAY" DOES NOT MARK ANYTHING PAID. It emits a signed event to the
 * webhook endpoint, exactly as a provider would, and the reconciler decides.
 * The redirect back carries no claim about the outcome (§22).
 */

const log = createLogger({ context: { component: 'api.billing-hosted' } });

const sessionParamSchema = z.object({ providerSessionId: z.string().min(1).max(128) });

export async function registerBillingHostedPageRoutes(app: FastifyInstance): Promise<void> {
  if (currentEnvironment() === 'PRODUCTION') {
    // The route is never registered. A production deployment has no mock
    // checkout page at any URL.
    log.info('development checkout page not registered', { environment: 'PRODUCTION' });
    return;
  }

  /*
   * AN ENCAPSULATED PLUGIN, so the form parser below applies here and nowhere
   * else. The two buttons are ordinary HTML `<form method="post">` submissions —
   * which is deliberate: a provider's page works without JavaScript, and so does
   * this one — and a browser sends those as `application/x-www-form-urlencoded`,
   * which the API otherwise refuses with a 415. The routes read NOTHING from the
   * body; what they act on is the provider session id in the path.
   */
  await app.register(async (scoped: FastifyInstance) => {
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, _body, done) => {
        // Accepted and discarded. Nothing here is read from a browser body.
        done(null, {});
      },
    );

    /** Render what is being bought. The amount comes from our row, never the URL. */
    route(
      scoped,
      'GET',
      '/billing/checkout/:providerSessionId',
      { scope: 'public' },
      async (req, reply) => {
        const params = sessionParamSchema.safeParse(req.params);
        if (!params.success) return reply.code(404).send();
        const session = await loadSession(params.data.providerSessionId);
        if (!session) return reply.code(404).type('text/html').send(notFoundPage());

        const total = Money.ofMinor(session.currency, session.totalMinor, session.currencyScale);
        const tax = Money.ofMinor(session.currency, session.taxMinor, session.currencyScale);
        const subtotal = Money.ofMinor(
          session.currency,
          session.amountMinor,
          session.currencyScale,
        );

        return reply.type('text/html; charset=utf-8').send(
          checkoutPage({
            providerSessionId: params.data.providerSessionId,
            description:
              session.purpose === 'SUBSCRIPTION'
                ? (session.planKey ?? 'Subscription')
                : (session.packKey ?? 'Credit pack'),
            subtotal: subtotal.toDecimalString(),
            tax: tax.toDecimalString(),
            total: total.toDecimalString(),
            currency: total.currency,
            pending: session.status !== 'PENDING',
          }),
        );
      },
    );

    /**
     * "Pay".
     *
     * Emits a SIGNED event to our own webhook endpoint over loopback HTTP —
     * through the same door a real provider uses, verified the same way, with no
     * in-process shortcut. A shortcut here would leave the verification path
     * untested on the one flow that matters most.
     */
    route(
      scoped,
      'POST',
      '/billing/checkout/:providerSessionId/pay',
      { scope: 'public', idempotent: true },
      async (req, reply) => {
        const params = sessionParamSchema.safeParse(req.params);
        if (!params.success) return reply.code(404).send();
        const session = await loadSession(params.data.providerSessionId);
        if (!session) return reply.code(404).send();

        const adapter = providerFor(DEVELOPMENT_PROVIDER_KEY);
        if (!(adapter instanceof DevelopmentPaymentProvider)) {
          return reply.code(404).send();
        }

        const profile = await getPlatformClient().billingProfile.findFirst({
          where: { workspaceId: session.workspaceId },
          select: { providerCustomerId: true },
        });

        const delivery = signedDelivery(
          adapter,
          paidCheckoutEvent({
            eventId: `evt_${randomUUID()}`,
            checkoutSessionId: session.id,
            providerSessionId: params.data.providerSessionId,
            providerCustomerId: profile?.providerCustomerId ?? '',
            amount: Money.ofMinor(session.currency, session.totalMinor, session.currencyScale),
          }),
        );

        const response = await app.inject({
          method: 'POST',
          url: `/v1/billing/webhook/${DEVELOPMENT_PROVIDER_KEY}`,
          headers: delivery.headers,
          payload: delivery.body,
        });

        if (response.statusCode !== 200) {
          log.error('development payment event was refused', { status: response.statusCode });
        }

        // The redirect carries NO claim about the outcome — only WHICH checkout
        // it was. The landing page answers from reconciled state.
        return reply.code(303).header('location', returnTo(session.returnUrl, session.id)).send();
      },
    );

    /** "Cancel". Records the abandonment; nothing else changes. */
    route(
      scoped,
      'POST',
      '/billing/checkout/:providerSessionId/cancel',
      { scope: 'public', idempotent: true },
      async (req, reply) => {
        const params = sessionParamSchema.safeParse(req.params);
        if (!params.success) return reply.code(404).send();
        const session = await loadSession(params.data.providerSessionId);
        if (!session) return reply.code(404).send();
        try {
          await getPlatformClient().checkoutSession.updateMany({
            where: { id: session.id, status: 'PENDING' },
            data: { status: 'CANCELLED', cancelledAt: systemClock.now() },
          });
        } catch (error: unknown) {
          log.error('could not record checkout cancellation', internalErrorFields(error));
        }
        return reply.code(303).header('location', returnTo(session.returnUrl, session.id)).send();
      },
    );
  });
}

/**
 * Read the checkout the provider page is displaying.
 *
 * ON THE PLATFORM CLIENT, because this page is standing in for the PROVIDER's
 * own systems and has no tenant context — a customer arriving at a provider's
 * domain carries no BrandSpace session. It reads one row by the provider session
 * id it was given and writes nothing a tenant could not.
 */
async function loadSession(providerSessionId: string) {
  return getPlatformClient().checkoutSession.findFirst({
    where: { providerKey: DEVELOPMENT_PROVIDER_KEY, providerSessionId },
    select: {
      id: true,
      workspaceId: true,
      status: true,
      purpose: true,
      planKey: true,
      packKey: true,
      currency: true,
      currencyScale: true,
      amountMinor: true,
      taxMinor: true,
      totalMinor: true,
      returnUrl: true,
    },
  });
}

/**
 * Where the browser goes back to, carrying WHICH checkout it was.
 *
 * A provider appends its own reference here; ours is our own checkout id, which
 * is not an authorization boundary — the landing page looks it up inside the
 * caller's workspace, so an id from another tenant resolves to nothing.
 */
function returnTo(base: string | null, checkoutSessionId: string): string {
  if (!base) return '/';
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}session=${encodeURIComponent(checkoutSessionId)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function notFoundPage(): string {
  return page('<h1>This payment link is no longer valid.</h1>');
}

function checkoutPage(input: {
  providerSessionId: string;
  description: string;
  subtotal: string;
  tax: string;
  total: string;
  currency: string;
  pending: boolean;
}): string {
  const id = escapeHtml(input.providerSessionId);
  if (input.pending) {
    return page('<h1>This checkout has already been completed or cancelled.</h1>');
  }
  return page(`
    <h1>Development payment provider</h1>
    <p class="note">
      A stand-in for a provider-hosted page. It collects no card details, because
      the point of hosted checkout is that none ever reach BrandSpace.
    </p>
    <dl>
      <dt>Buying</dt><dd>${escapeHtml(input.description)}</dd>
      <dt>Subtotal</dt><dd>${escapeHtml(input.subtotal)} ${escapeHtml(input.currency)}</dd>
      <dt>Tax</dt><dd>${escapeHtml(input.tax)} ${escapeHtml(input.currency)}</dd>
      <dt>Total</dt><dd><strong>${escapeHtml(input.total)} ${escapeHtml(input.currency)}</strong></dd>
    </dl>
    <form method="post" action="/billing/checkout/${id}/pay">
      <button type="submit" data-testid="dev-checkout-pay">Pay ${escapeHtml(input.total)} ${escapeHtml(input.currency)}</button>
    </form>
    <form method="post" action="/billing/checkout/${id}/cancel">
      <button type="submit" class="secondary" data-testid="dev-checkout-cancel">Cancel</button>
    </form>
  `);
}

/**
 * The page shell.
 *
 * DELIBERATELY UNBRANDED. This is somebody else's site in the story it is
 * telling, and dressing it in BrandSpace's design system would teach the team —
 * and any screenshot — that the payment page is ours.
 */
function page(body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Development payment provider</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 34rem; padding: 2rem 1rem; color: #111114; }
      h1 { font-size: 1.25rem; }
      .note { color: #55555f; font-size: 0.875rem; }
      dl { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; margin: 1.5rem 0; }
      dt { color: #55555f; }
      dd { margin: 0; text-align: end; }
      button { width: 100%; padding: 0.75rem 1rem; font-size: 1rem; border-radius: 0.5rem; border: 1px solid #111114; background: #111114; color: #fff; cursor: pointer; }
      button.secondary { background: transparent; color: #111114; margin-top: 0.75rem; }
    </style>
  </head>
  <body>${body}</body>
</html>`;
}
