/**
 * PR A2 — "TODAY'S AI LIMIT IS REACHED", NEVER "NOT ENOUGH CREDITS".
 *
 * A workspace's daily or monthly AI budget and its credit wallet are different
 * things, and both refuse with QUOTA_EXCEEDED. Staging showed the cost of
 * confusing them: a wallet holding 460 credits was told there were not enough,
 * because the 100-a-day budget was spent. The gateway now names the budget
 * (`details.reason`) and when it resets (`details.resetsAt`, ISO); this turns
 * that into the customer's sentence, in their language and time zone.
 *
 * Pure, no server import: safe in a client component.
 */

export interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export function aiLimitMessage(
  body: ApiErrorBody | null | undefined,
  t: Readonly<Record<string, string | undefined>>,
  locale: string,
): string | null {
  const details = body?.error?.details ?? {};
  const reason = details['reason'];
  if (reason !== 'AI_DAILY_LIMIT' && reason !== 'AI_MONTHLY_LIMIT') return null;
  const resetsAt = typeof details['resetsAt'] === 'string' ? new Date(details['resetsAt']) : null;
  const when =
    resetsAt && !Number.isNaN(resetsAt.getTime())
      ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en', {
          dateStyle: reason === 'AI_MONTHLY_LIMIT' ? 'medium' : undefined,
          timeStyle: 'short',
        }).format(resetsAt)
      : '';
  const template = t[reason === 'AI_DAILY_LIMIT' ? 'ai.limit.daily' : 'ai.limit.monthly'] ?? '';
  return template.replace('{time}', when);
}
