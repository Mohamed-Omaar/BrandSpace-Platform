import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { CUSTOMER_REALM } from '@brandspace/auth';
import { createLogger, internalErrorFields } from '@brandspace/shared';
import { AvailabilityCache } from './availability-cache';
import { getCustomer } from './customer-context';

const log = createLogger({ context: { component: 'dashboard.ai-availability' } });

/**
 * PR F (b), Q9, D-507 — WHICH AI TASKS CAN RUN FOR THIS SESSION'S WORKSPACE,
 * asked of `GET /v1/ai/availability` (C2: at most once per workspace every
 * 45 s, and never waited on for more than 1.5 s). The dashboard cannot read AI configuration itself (F-07), so
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

/** C2 — how long one workspace's answer is kept, and how long a request may take. */
export const AI_AVAILABILITY_TTL_MS = 45_000;
export const AI_AVAILABILITY_TIMEOUT_MS = 1_500;

type Tasks = Readonly<Record<string, boolean>>;

/**
 * C2 (owner, 2026-11-14) — ONE ANSWER PER WORKSPACE FOR 45 s, ASKED FOR AT
 * MOST 1.5 s. The answer depends only on the workspace (its plan) and the
 * activated AI configuration, never on the person asking, so it is shared
 * by everyone in the workspace; a Control Center activation shows within
 * 45 s. A slow or failing API answers with the last known answer, or with
 * "nothing is available" when there is none — as before, not known is not
 * available.
 */
const byWorkspace = new AvailabilityCache<Tasks>({
  ttlMs: AI_AVAILABILITY_TTL_MS,
  timeoutMs: AI_AVAILABILITY_TIMEOUT_MS,
  fallback: {},
  onFailure: (_key, error) =>
    log.warn('AI availability could not be read in time; the last answer is kept', {
      ...internalErrorFields(error),
    }),
  fetch: async (_workspaceId, signal) => {
    const base = process.env['BRANDSPACE_API_URL'];
    const token = (await cookies()).get(CUSTOMER_REALM.cookieName)?.value;
    if (!base || !token) return {};
    const upstream = await fetch(`${base.replace(/\/$/, '')}/v1/ai/availability`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal,
    });
    if (!upstream.ok) throw new Error(`availability answered ${upstream.status}`);
    const payload = (await upstream.json().catch(() => null)) as { tasks?: unknown } | null;
    const tasks = payload?.tasks;
    if (!tasks || typeof tasks !== 'object') throw new Error('availability answer was malformed');
    return Object.fromEntries(
      Object.entries(tasks as Record<string, unknown>).map(([key, value]) => [key, value === true]),
    );
  },
});

export const aiAvailability = cache(async (): Promise<Tasks> => {
  if (!process.env['BRANDSPACE_API_URL']) return {};
  const customer = await getCustomer().catch(() => null);
  const workspaceId = customer?.activeWorkspaceId;
  if (!workspaceId) return {};
  return byWorkspace.get(workspaceId);
});

/** Whether this task can run now. Read at request time. */
export async function aiAvailableFor(task: AiTask): Promise<boolean> {
  return (await aiAvailability())[task] === true;
}
