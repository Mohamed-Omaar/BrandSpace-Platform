import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@brandspace/database';
import { platformRoleClient } from './fixtures';
import { captureConfig, type ActivatedConfig } from './config-activation';
import { CATALOGUE } from '../support/commerce-fixture';

// `server-only` is a build-time marker with no Node implementation.
vi.mock('server-only', () => ({}));

/**
 * PR F (a), Q6 — `commerce.payments.enabled` HIDES EVERY PAYMENT ROUTE, AND
 * TURNING IT ON NEEDS NO RELEASE.
 *
 * Off (the schema default, and the beta's value), every checkout and
 * subscription route of the API answers exactly as a path that does not exist
 * — before a session is read, so it cannot be told apart from "no such thing" —
 * and the dashboard's own payment routes return the same bare 404. On, the
 * same routes are back and answer as before (here: the body validation, which
 * comes first). Both directions are read from the ACTIVE configuration, so the
 * flip is an activation, not a deployment.
 */

const WITHOUT_PAYMENTS = Object.fromEntries(
  Object.entries(CATALOGUE).filter(([key]) => key !== 'payments'),
);

const PAYMENT_ROUTES = [
  ['POST', '/v1/commerce/checkout/subscription'],
  ['POST', '/v1/commerce/checkout/pack'],
  ['GET', '/v1/commerce/checkout/00000000-0000-4000-8000-000000000000'],
  ['GET', '/v1/commerce/subscription'],
  ['POST', '/v1/commerce/subscription/preview'],
  ['POST', '/v1/commerce/subscription/downgrade'],
  ['POST', '/v1/commerce/subscription/downgrade/cancel'],
  ['POST', '/v1/commerce/subscription/cancel'],
  ['POST', '/v1/commerce/subscription/resume'],
  ['GET', '/billing/checkout/sess_fixture'],
  ['POST', '/billing/checkout/sess_fixture/pay'],
  ['POST', '/billing/checkout/sess_fixture/cancel'],
] as const;

let platform: PrismaClient;
let commerce: ActivatedConfig;

type Server = { inject: Function; close(): Promise<unknown>; ready(): Promise<unknown> };

/** A fresh API process: new modules, so no configuration cache carries over. */
async function freshServer(): Promise<Server> {
  vi.resetModules();
  const { buildServer } = await import('../../apps/api/src/server');
  const server = (await buildServer()) as unknown as Server;
  await server.ready();
  return server;
}

async function answer(server: Server, method: string, url: string) {
  const response = await server.inject({
    method,
    url,
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, payload: {} } : {}),
  });
  const body = response.body.replaceAll(url, '<path>');
  return { status: response.statusCode as number, body };
}

beforeAll(async () => {
  platform = platformRoleClient();
  commerce = await captureConfig(platform, 'commerce', { projected: true });
}, 60_000);

afterAll(async () => {
  await commerce?.restore();
  await platform?.$disconnect();
});

describe('PR F (a) · payments off', () => {
  it('every checkout and subscription route answers like an unknown path', async () => {
    await commerce.activate(WITHOUT_PAYMENTS);
    const server = await freshServer();
    try {
      for (const [method, url] of PAYMENT_ROUTES) {
        const unknown = await answer(server, method, '/v1/no-such-route');
        const route = await answer(server, method, url);
        expect(route.status, `${method} ${url}`).toBe(404);
        expect(route.body, `${method} ${url}`).toBe(unknown.body);
      }
    } finally {
      await server.close();
    }
  });

  it("the dashboard's payment routes answer the same bare 404, and onboarding is untouched", async () => {
    await commerce.activate(WITHOUT_PAYMENTS);
    vi.resetModules();
    const { paymentsSwitchedOn } = await import('../../apps/dashboard/src/server/payments-switch');
    const { proxyCommerce } = await import('../../apps/dashboard/src/app/api/commerce/proxy');
    expect(await paymentsSwitchedOn()).toBe(false);
    for (const path of [
      '/v1/commerce/checkout/subscription',
      '/v1/commerce/checkout/pack',
      '/v1/commerce/subscription/cancel',
    ]) {
      const response = await proxyCommerce(new Request('http://dashboard.test/api'), path);
      expect(response.status, path).toBe(404);
      expect(await response.text(), path).toBe('');
    }
  });
});

describe('PR F (a) · payments on', () => {
  it('the same routes are back, with no release', async () => {
    await commerce.activate(CATALOGUE as unknown as Record<string, unknown>);
    const server = await freshServer();
    try {
      // Unsigned, so the route itself refuses (401) — which a path that does
      // not exist could never say.
      const opened = await answer(server, 'POST', '/v1/commerce/checkout/subscription');
      expect(opened.status).not.toBe(404);
      const status = await answer(server, 'GET', '/v1/commerce/subscription');
      expect(status.status).not.toBe(404);
    } finally {
      await server.close();
    }
    vi.resetModules();
    const { paymentsSwitchedOn } = await import('../../apps/dashboard/src/server/payments-switch');
    expect(await paymentsSwitchedOn()).toBe(true);
  });
});
