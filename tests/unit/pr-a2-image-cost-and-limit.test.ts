import { describe, expect, it } from 'vitest';
import { budgetRefusal, providerCostMicroMinor } from '@brandspace/ai-gateway';
import { aiLimitMessage } from '../../apps/dashboard/src/components/ai-limit';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PR A2 — the recorded image cost follows the quality and size requested
 * (F-115), and a budget refusal is named as a budget, with its reset time,
 * never as "not enough credits".
 */

const basis = {
  modelKey: 'gpt-image-2',
  inputCostPerUnitMicroMinor: 0,
  outputCostPerUnitMicroMinor: 21_100_000,
  costUnit: 'image' as const,
  costCurrency: 'USD',
  // OpenAI gpt-image-2 at 1024×1024: $0.006 / $0.053 / $0.211.
  imageCostByQualityMicroMinor: { low: 600_000, medium: 5_300_000, high: 21_100_000 },
};

describe('F-115 — an image costs what its quality and size cost', () => {
  it('a low 1024×1024 image is recorded at the low price, not the high one', () => {
    expect(
      providerCostMicroMinor({ imageCount: 1 }, basis, { quality: 'low', pixels: 1024 * 1024 }),
    ).toBe(600_000n);
  });

  it('a high 1152×2048 story costs 2.25 high squares', () => {
    expect(
      providerCostMicroMinor({ imageCount: 1 }, basis, { quality: 'high', pixels: 1152 * 2048 }),
    ).toBe(47_475_000n);
  });

  it('a medium 1088×1360 portrait scales by its pixels, rounded up', () => {
    const cost = providerCostMicroMinor({ imageCount: 1 }, basis, {
      quality: 'medium',
      pixels: 1088 * 1360,
    });
    expect(cost).toBe(BigInt(Math.ceil((5_300_000 * 1088 * 1360) / (1024 * 1024))));
  });

  it('without per-quality rates, the single per-unit rate applies as before', () => {
    const { imageCostByQualityMicroMinor: _omit, ...plain } = basis;
    expect(
      providerCostMicroMinor({ imageCount: 1 }, plain, { quality: 'low', pixels: 1024 * 1024 }),
    ).toBe(21_100_000n);
  });
});

describe('a budget refusal is a budget, with its reset time', () => {
  const now = new Date('2026-11-01T18:40:00Z');
  const decision = (breached: 'credits_per_day' | 'credits_per_month') =>
    ({ allowed: false, breached, limit: 100_000, observed: 66_000 }) as never;

  it('the daily budget names itself and resets at the next UTC midnight', () => {
    const error = budgetRefusal(decision('credits_per_day'), now);
    expect(error.publicDetails).toEqual({
      reason: 'AI_DAILY_LIMIT',
      resetsAt: '2026-11-02T00:00:00.000Z',
    });
  });

  it('the monthly budget resets on the first of next month', () => {
    expect(budgetRefusal(decision('credits_per_month'), now).publicDetails).toEqual({
      reason: 'AI_MONTHLY_LIMIT',
      resetsAt: '2026-12-01T00:00:00.000Z',
    });
  });

  it.each(['en', 'ar'] as const)(
    '%s: the screen says the AI limit is reached, never "not enough credits"',
    (locale) => {
      const t = messages[locale] as Record<string, string>;
      const text = aiLimitMessage(
        {
          error: {
            code: 'QUOTA_EXCEEDED',
            details: { reason: 'AI_DAILY_LIMIT', resetsAt: '2026-11-02T00:00:00.000Z' },
          },
        },
        t,
        locale,
      );
      expect(text).toBeTruthy();
      expect(text).not.toContain('{time}');
      expect(text).not.toContain(t['content.error.quota']);
      if (locale === 'en') expect(text).toMatch(/^Today's AI limit is reached\. It resets at /);
    },
  );

  it('a real wallet refusal is left to the credit message', () => {
    expect(
      aiLimitMessage({ error: { code: 'INSUFFICIENT_CREDITS', details: {} } }, {}, 'en'),
    ).toBeNull();
  });
});
