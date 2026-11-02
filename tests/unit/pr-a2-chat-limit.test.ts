import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aiLimitMessage } from '../../apps/dashboard/src/components/ai-limit';
import { messages } from '../../apps/dashboard/src/i18n/messages';

/**
 * PR A2 — Copilot and Brand Brain chat say "Today's AI limit is reached. It
 * resets at …" for a daily or monthly AI budget, as the Studio does, instead
 * of the generic failure or the credit message.
 */
const body = {
  error: {
    code: 'QUOTA_EXCEEDED',
    details: { reason: 'AI_DAILY_LIMIT', resetsAt: '2026-11-03T00:00:00.000Z' },
  },
};

describe('PR A2 — the AI budget message in Copilot and Brand Brain chat', () => {
  it('reads in both languages with the reset time', () => {
    for (const locale of ['en', 'ar'] as const) {
      const dictionary = messages[locale] as Record<string, string>;
      const text = aiLimitMessage(
        body,
        {
          'ai.limit.daily': dictionary['ai.limit.daily'] ?? '',
          'ai.limit.monthly': dictionary['ai.limit.monthly'] ?? '',
        },
        locale,
      );
      expect(text).not.toBeNull();
      expect(text).not.toContain('{time}');
    }
  });

  it('both chat screens read the budget refusal before the generic failure', () => {
    const copilot = readFileSync(
      'apps/dashboard/src/app/[locale]/copilot/copilot-view.tsx',
      'utf8',
    );
    expect(copilot).toMatch(/aiLimitMessage\([\s\S]*statusMessage\(errorCode, locale\)/);
    expect(copilot).toContain('setErrorDetails(result.error.details ?? null)');
    const chat = readFileSync('apps/dashboard/src/app/[locale]/brand-brain/brand-chat.tsx', 'utf8');
    expect(chat).toMatch(/limit \?\? \(code === 'AI_PAUSED'/);
    const view = readFileSync(
      'apps/dashboard/src/app/[locale]/brand-brain/brand-brain-view.tsx',
      'utf8',
    );
    expect(view).toContain("limitDaily: t('ai.limit.daily')");
  });
});
