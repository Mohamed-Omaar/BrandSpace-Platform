import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { CUSTOMER_REALM } from '@brandspace/auth';
import { createLogger, internalErrorFields } from '@brandspace/shared';

const log = createLogger({ context: { component: 'dashboard.ai-availability' } });

/**
 * PR F (b), Q9, D-507 — WHICH AI TASKS CAN RUN FOR THIS SESSION'S WORKSPACE,
 * asked of `GET /v1/ai/availability` once per request (deduplicated within
 * one render). The dashboard cannot read AI configuration itself (F-07), so
 * the API answers: per task, true or false, and nothing else.
 *
 * NOT KNOWN IS NOT AVAILABLE. No session, no API, a refusal or a malformed
 * answer all read as "no task is available", so a control that could not
 * work is hidden rather than shown and failing after the press.
 */
export type AiTask =
  | 'caption.generate'
  | 'ideas.generate'
  | 'plan.monthly'
  | 'strategy.generate'
  | 'analytics.explain'
  | 'copilot.chat'
  | 'content.translate'
  | 'image.generate';

export const aiAvailability = cache(async (): Promise<Readonly<Record<string, boolean>>> => {
  const base = process.env['BRANDSPACE_API_URL'];
  if (!base) return {};
  const token = (await cookies()).get(CUSTOMER_REALM.cookieName)?.value;
  if (!token) return {};
  try {
    const upstream = await fetch(`${base.replace(/\/$/, '')}/v1/ai/availability`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!upstream.ok) return {};
    const payload = (await upstream.json().catch(() => null)) as { tasks?: unknown } | null;
    const tasks = payload?.tasks;
    if (!tasks || typeof tasks !== 'object') return {};
    return Object.fromEntries(
      Object.entries(tasks as Record<string, unknown>).map(([key, value]) => [key, value === true]),
    );
  } catch (error: unknown) {
    log.warn(
      'AI availability could not be read; AI controls are hidden',
      internalErrorFields(error),
    );
    return {};
  }
});

/** Whether this task can run now. Read at request time. */
export async function aiAvailableFor(task: AiTask): Promise<boolean> {
  return (await aiAvailability())[task] === true;
}
