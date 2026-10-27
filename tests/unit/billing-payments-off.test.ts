import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { paymentsEnabled } from '@brandspace/billing';

/**
 * PR F (a), Q6, D-508 — WITH PAYMENTS OFF (THE BETA), PLAN & BILLING NEVER
 * OFFERS "CHANGE PLAN" OR "BUY 500 CREDITS". Asked by the owner before #90's
 * merge: `tests/isolation/pr-f-payments-switch.test.ts` proves the payment
 * ROUTES answer like unknown paths; this pins the PAGE. Both controls sit
 * behind `payments`, which is `commerce.payments.enabled` read through
 * `paymentsSwitchedOn()`, and the beta's commerce document has it false.
 */

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const page = read('apps/dashboard/src/app/[locale]/billing/page.tsx');

describe('Plan & billing with payments off', () => {
  it('the page reads the one switch, commerce.payments.enabled', () => {
    expect(page).toContain('const payments = await paymentsSwitchedOn();');
    expect(read('apps/dashboard/src/server/payments-switch.ts')).toContain(
      'return paymentsEnabled(policy);',
    );
    expect(paymentsEnabled({ payments: { enabled: false } } as never)).toBe(false);
    expect(paymentsEnabled({ payments: undefined } as never)).toBe(false);
    expect(paymentsEnabled({ payments: { enabled: true } } as never)).toBe(true);
  });

  it('"Change plan" (and every plan price and Buy button under it) is drawn only with payments on', () => {
    expect(page).toMatch(
      /\{payments \? \(\s*<details className="bsp-bl-change">\s*<summary[^>]*data-testid="billing-change-plan"/,
    );
    // The plans card, its prices and its Buy buttons live inside that block.
    const gate = page.indexOf('data-testid="billing-change-plan"');
    expect(page.indexOf('data-testid="plans-card"')).toBeGreaterThan(gate);
    expect(page.indexOf('<BuyPlanButton')).toBeGreaterThan(gate);
  });

  it('"Buy 500 credits" (the packs) is drawn only with payments on', () => {
    expect(page).toMatch(
      /\{payments && snapshot\.packs\.length > 0 \? \(\s*<details className="bsp-bl-change">\s*<summary[^>]*data-testid="billing-buy-credits"/,
    );
    expect(page.indexOf('data-testid="packs-card"')).toBeGreaterThan(
      page.indexOf('data-testid="billing-buy-credits"'),
    );
  });

  it('the beta configuration has payments off', () => {
    const commerce = JSON.parse(read('docs/production-config/commerce.json')) as {
      payments?: { enabled?: boolean };
    };
    expect(commerce.payments?.enabled).toBe(false);
  });
});
