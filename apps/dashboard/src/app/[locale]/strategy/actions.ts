'use server';

import { creditSpendingPermissions } from '@brandspace/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWorkspace } from '../../../server/customer-context';
import { callPhase7Api } from '../../../server/analytics-context';

/**
 * Strategy and insight actions.
 *
 * EVERY ACTION RE-CHECKS THE PERMISSION INDEPENDENTLY. The page hides a control a
 * member may not use, and that is tidiness; `requireWorkspace(locale, permission)`
 * here is the control. A server action is a public endpoint — a form post is a
 * form post whatever the screen rendered.
 *
 * THE GENERATION ITSELF RUNS IN `apps/api`, because it calls the AI Gateway and
 * needs the platform identity F-07 keeps out of this app. This forwards the
 * customer's own session and nothing else.
 *
 * FAILURE TRAVELS AS A CODE IN THE URL, never as an exception message: the page
 * chooses the words from a closed set, so nothing from an error can reach the
 * address bar, the browser history or an access log (R-05).
 */

function codeFrom(payload: unknown): string {
  const error = (payload as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === 'string' ? error.code : 'INTERNAL';
}

export async function generateStrategyAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, creditSpendingPermissions('strategy.manage'));
  const brandId = String(formData.get('brandId') ?? '');
  const objective = String(formData.get('objective') ?? '').slice(0, 400);

  const response = await callPhase7Api('/v1/strategy/generate', {
    brandId,
    objective,
    periodDays: 90,
    // ONE KEY PER SUBMISSION, derived from the workspace, the brand and the
    // request text. A retried submission returns the first proposal rather than
    // generating — and paying for — a second.
    idempotencyKey: `strategy:${session.workspace.workspaceId}:${brandId}:${hash(objective)}`,
  });

  if (!response.ok) {
    redirect(`/${locale}/strategy?brand=${brandId}&view=next&error=${codeFrom(response.payload)}`);
  }
  revalidatePath(`/${locale}/strategy`);
  // Gate 2b — back to "Next strategy", where the new draft is.
  redirect(`/${locale}/strategy?brand=${brandId}&view=next&ok=STRATEGY_PROPOSED`);
}

export async function reviewInsightAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  await requireWorkspace(locale, 'strategy.manage');
  const insightId = String(formData.get('insightId') ?? '');
  const decision = String(formData.get('decision') ?? 'seen');

  const response = await callPhase7Api('/v1/insights/review', { insightId, decision });
  if (!response.ok) {
    redirect(`/${locale}/strategy?view=next&error=${codeFrom(response.payload)}`);
  }
  revalidatePath(`/${locale}/strategy`);
  // An accepted draft is this strategy now; a dismissed one leaves the others.
  redirect(
    decision === 'accept'
      ? `/${locale}/strategy?ok=INSIGHT_ACCEPTED`
      : `/${locale}/strategy?view=next&ok=INSIGHT_DISMISSED`,
  );
}

/**
 * Propose learnings from an insight into the Brand Brain review queue.
 *
 * REQUIRES `brand_brain.review`, not `strategy.manage`: the person asking for the
 * inference to be drawn is the person who will have to judge it. Nothing is
 * written into Brand Brain here — everything lands as a PENDING candidate in the
 * same queue a document candidate lands in.
 */
export async function proposeLearningsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  await requireWorkspace(locale, 'brand_brain.review');
  const insightId = String(formData.get('insightId') ?? '');

  const response = await callPhase7Api('/v1/insights/learnings', { insightId });
  if (!response.ok) {
    redirect(`/${locale}/strategy?view=next&error=${codeFrom(response.payload)}`);
  }
  revalidatePath(`/${locale}/strategy`);
  redirect(`/${locale}/strategy?view=next&ok=LEARNINGS_PROPOSED`);
}

/**
 * A short, stable digest of the request text.
 *
 * NOT A RANDOM KEY: the point is that the SAME request produces the SAME key, so
 * a double submission collapses instead of billing twice.
 */
function hash(value: string): string {
  let out = 0;
  for (let index = 0; index < value.length; index += 1) {
    out = (out * 31 + value.charCodeAt(index)) >>> 0;
  }
  return out.toString(16).padStart(8, '0');
}

/**
 * D13 (Phase 2C-4, owner decision Option 1) — "Brand Brain changed", accepted
 * as it stands: the strategy's stored knowledge baseline becomes the current
 * one, through the API's Strategy mutation (`strategy.manage`, re-checked there
 * too). Audited with the previous and the new value; acknowledging what is
 * already current changes nothing. A later change to the usable facts raises
 * the alert again.
 */
export async function acknowledgeKnowledgeChangeAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  await requireWorkspace(locale, 'strategy.manage');
  const insightId = String(formData.get('insightId') ?? '');
  const brandId = String(formData.get('brandId') ?? '');
  const back = `/${locale}/strategy?brand=${encodeURIComponent(brandId)}`;

  const response = await callPhase7Api('/v1/strategy/acknowledge-knowledge', { insightId });
  if (!response.ok) redirect(`${back}&error=${codeFrom(response.payload)}`);
  revalidatePath(`/${locale}/strategy`);
  redirect(`${back}&ok=STRATEGY_KNOWLEDGE_ACKNOWLEDGED`);
}
