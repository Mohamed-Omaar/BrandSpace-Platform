import { describe, expect, it } from 'vitest';
import { estimatePromptTokens, reservationOverrun } from '@brandspace/ai-gateway';
import { CONFIG_DOMAINS } from '@brandspace/config';
import { EMAIL_TEMPLATE_KEYS, renderEmail } from '@brandspace/auth';

/**
 * PR A2 (item 12, F-107) — the reservation estimate no longer under-reserves
 * Arabic, and the owner can be told when usage still outruns a reservation by
 * more than a margin they set.
 */
describe('PR A2 (item 12) — the prompt estimate counts by script', () => {
  it('English stays at four characters a token', () => {
    expect(estimatePromptTokens(['a'.repeat(400)])).toBe(100);
  });

  it('Arabic counts two characters a token, twice the old estimate', () => {
    const arabic = 'م'.repeat(400);
    expect(estimatePromptTokens([arabic])).toBe(200);
    expect(estimatePromptTokens([arabic])).toBeGreaterThan(Math.ceil(arabic.length / 4));
  });

  it('a mixed prompt and its context are counted together, each character by its script', () => {
    expect(estimatePromptTokens(['a'.repeat(40), 'مرحبا'.repeat(8), '你好'.repeat(5)])).toBe(
      10 + 20 + 10,
    );
  });
});

describe('PR A2 (item 12) — when an overrun is reported', () => {
  const base = { requestId: 'r', taskKey: 't', modelKey: 'm', reservedMilli: 2000n };

  it('off when no margin is set', () => {
    expect(reservationOverrun(null, { ...base, meteredMilli: 9000n })).toBeNull();
    expect(reservationOverrun(undefined, { ...base, meteredMilli: 9000n })).toBeNull();
  });

  it('only above reservation + margin', () => {
    expect(reservationOverrun(25, { ...base, meteredMilli: 2500n })).toBeNull(); // exactly 25%
    expect(reservationOverrun(25, { ...base, meteredMilli: 2600n })).toEqual({
      ...base,
      meteredMilli: 2600n,
      overrunPercent: 30,
      thresholdPercent: 25,
    });
    expect(reservationOverrun(0, { ...base, meteredMilli: 2000n })).toBeNull();
  });

  it('the margin is configuration (ai.budgets), off by default', () => {
    const schema = CONFIG_DOMAINS['ai.budgets'].schema;
    expect(
      (schema.parse({}) as { reservationOverrunAlertPercent: unknown })
        .reservationOverrunAlertPercent,
    ).toBeNull();
    expect(schema.safeParse({ reservationOverrunAlertPercent: 25 }).success).toBe(true);
    expect(schema.safeParse({ reservationOverrunAlertPercent: -1 }).success).toBe(false);
  });

  it('the owner email exists in English and Arabic, with no figure', () => {
    expect(EMAIL_TEMPLATE_KEYS).toContain('platform.ai_reservation_overrun');
    for (const locale of ['EN', 'AR'] as const) {
      const rendered = renderEmail({
        to: 'owner@example.test',
        templateKey: 'platform.ai_reservation_overrun',
        locale,
      });
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.text).not.toMatch(/\d|https?:\/\//);
    }
  });
});
