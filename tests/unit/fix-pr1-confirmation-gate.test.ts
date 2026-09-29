import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resetRouteRegistry, route } from '../../apps/api/src/route-contract';

/**
 * FIX PR 1 · F4 (D-411) — EVERY `confirmation: 'required'` ROUTE NAMES HOW
 * THE SERVER HOLDS IT.
 *
 * The declaration used to be metadata and nothing more: disconnect and pack
 * checkout declared it and took one request. Registration now refuses a
 * `required` route with no `confirmedBy`, and this suite pins which mechanism
 * each route names — so a new high-impact route cannot declare the policy
 * without choosing one, and a route that names `confirm_field` really parses
 * `confirm: z.literal(true)`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const routesDir = path.join(root, 'apps/api/src/routes');
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');

const MECHANISMS = [
  'confirm_field',
  'single_use_token',
  'proof_of_possession',
  'provider_consent',
  'explicit_decision',
] as const;

/** Every route() call's method, url and contract text, across the route files. */
function declaredRoutes(): { file: string; method: string; url: string; contract: string }[] {
  const found: { file: string; method: string; url: string; contract: string }[] = [];
  for (const name of readdirSync(routesDir).filter((n) => n.endsWith('.ts'))) {
    const text = readFileSync(path.join(routesDir, name), 'utf8');
    const pattern =
      /route\(\s*app,\s*'(GET|POST|PUT|PATCH|DELETE)',\s*'([^']+)',\s*(\{[\s\S]*?\}),/g;
    for (const match of text.matchAll(pattern)) {
      found.push({ file: name, method: match[1]!, url: match[2]!, contract: match[3]! });
    }
  }
  return found;
}

/** The mechanism each confirmed route names — the table the owner reviews. */
const EXPECTED: Readonly<Record<string, (typeof MECHANISMS)[number]>> = {
  'POST /v1/automations/confirm': 'single_use_token',
  'POST /v1/copilot/confirm': 'single_use_token',
  'POST /v1/copilot/undo': 'explicit_decision',
  'POST /v1/account/mfa/enrol': 'explicit_decision',
  'POST /v1/account/mfa/enrol/confirm': 'proof_of_possession',
  'POST /v1/account/mfa/disable': 'proof_of_possession',
  'POST /v1/insights/review': 'explicit_decision',
  'POST /v1/commerce/checkout/subscription': 'provider_consent',
  'POST /v1/commerce/checkout/pack': 'confirm_field',
  'POST /v1/commerce/subscription/downgrade': 'explicit_decision',
  'POST /v1/commerce/subscription/cancel': 'confirm_field',
  'POST /v1/social/connect': 'provider_consent',
  'GET /v1/social/callback/:provider': 'provider_consent',
  'POST /v1/social/connections/select': 'provider_consent',
  'POST /v1/social/connections/:connectionId/disconnect': 'confirm_field',
};

describe('F4 · a confirmation the server does not hold cannot be declared', () => {
  it('registration refuses `confirmation: required` without `confirmedBy`', () => {
    resetRouteRegistry();
    const app = { route: () => undefined } as never;
    expect(() =>
      route(
        app,
        'POST',
        '/v1/test/high-impact',
        { scope: 'workspace', permission: 'workspace.read', confirmation: 'required' },
        async () => undefined,
      ),
    ).toThrow(/does not name how it is enforced/);
    expect(() =>
      route(
        app,
        'POST',
        '/v1/test/high-impact',
        {
          scope: 'workspace',
          permission: 'workspace.read',
          confirmation: 'required',
          confirmedBy: 'confirm_field',
        },
        async () => undefined,
      ),
    ).not.toThrow();
    resetRouteRegistry();
  });

  it('every required route names a known mechanism, and the table is exactly the reviewed one', () => {
    const confirmed = declaredRoutes().filter((r) =>
      r.contract.includes("confirmation: 'required'"),
    );
    const named: Record<string, string> = {};
    for (const r of confirmed) {
      const mechanism = /confirmedBy: '([a-z_]+)'/.exec(r.contract)?.[1];
      expect(mechanism, `${r.method} ${r.url} names no confirmedBy`).toBeTruthy();
      expect(MECHANISMS).toContain(mechanism);
      named[`${r.method} ${r.url}`] = mechanism!;
    }
    expect(named).toEqual(EXPECTED);
  });

  it('a `confirm_field` route really parses confirm: z.literal(true)', () => {
    const commerce = read('apps/api/src/routes/commerce.ts');
    const social = read('apps/api/src/routes/social.ts');
    const block = (text: string, start: string) =>
      text.slice(text.indexOf(start)).split('\n});')[0]!;
    expect(block(commerce, 'const openPackSchema = z.object({')).toContain(
      'confirm: z.literal(true)',
    );
    expect(block(commerce, 'const cancelSchema = z.object({')).toContain(
      'confirm: z.literal(true)',
    );
    expect(social).toContain('const confirmSchema = z.object({ confirm: z.literal(true) });');
    const disconnect = social.slice(
      social.indexOf("'/v1/social/connections/:connectionId/disconnect'"),
    );
    const handler = disconnect.slice(0, disconnect.indexOf('service.disconnect('));
    expect(handler).toContain('confirmSchema.safeParse(req.body ?? {})');
  });

  it('the dashboard sends confirm: true only from its confirming step', () => {
    const integrations = read('apps/dashboard/src/app/[locale]/integrations/actions.ts');
    const action = integrations.slice(
      integrations.indexOf('export async function disconnectAccountAction'),
    );
    const guard = action.indexOf("formData.get('intent') !== 'DISCONNECT'");
    const call = action.indexOf('{ confirm: true }');
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guard);

    const billing = read('apps/dashboard/src/app/[locale]/billing/actions.tsx');
    const button = billing.slice(billing.indexOf('export function BuyPackButton('));
    const buy = button.slice(button.indexOf('const buy = async'), button.indexOf('return ('));
    expect(buy).toContain('confirm: true');
  });
});
