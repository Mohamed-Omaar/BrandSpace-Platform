'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWorkspace } from '../../../server/customer-context';
import { callPhase7Api } from '../../../server/analytics-context';

/**
 * Marketing Intelligence actions — Phase 8 (AC-30.1).
 *
 * THE SAME THREE RULES THE STRATEGY ACTIONS FOLLOW, and for the same reasons:
 * every action re-checks its permission independently because a server action
 * is a public endpoint; the generation runs in `apps/api` because it calls the
 * AI Gateway and needs the platform identity F-07 keeps out of this app; and a
 * failure travels as a CODE in the URL, never as a message, so nothing from an
 * error can reach the address bar, the browser history or an access log.
 */

function codeFrom(payload: unknown): string {
  const error = (payload as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === 'string' ? error.code : 'INTERNAL';
}

/**
 * A short, stable digest of the request text.
 *
 * NOT RANDOM: the same question must produce the same key, so a double
 * submission returns the first analysis rather than generating — and charging
 * for — a second.
 */
function hash(value: string): string {
  let out = 0;
  for (let index = 0; index < value.length; index += 1) {
    out = (out * 31 + value.charCodeAt(index)) >>> 0;
  }
  return out.toString(16).padStart(8, '0');
}

/**
 * Ask what this brand said it would do and has not.
 *
 * `strategy.manage` RATHER THAN `strategy.read`, matching the route: this
 * spends AI credits, and reading an analysis somebody else paid for is not the
 * same authority as commissioning one.
 */
export async function analyseContentGapsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, 'strategy.manage');
  const brandId = String(formData.get('brandId') ?? '');
  const objective = String(formData.get('objective') ?? '').slice(0, 400);

  const response = await callPhase7Api('/v1/intelligence/content-gap', {
    brandId,
    objective,
    periodDays: 90,
    idempotencyKey: `gap:${session.workspace.workspaceId}:${brandId}:${hash(objective)}`,
  });

  if (!response.ok) {
    redirect(`/${locale}/intelligence?error=${codeFrom(response.payload)}`);
  }
  revalidatePath(`/${locale}/intelligence`);
  redirect(`/${locale}/intelligence?ok=GAPS_ANALYSED`);
}

/**
 * WHERE A REVIEW RETURNS — a CLOSED SET. Home's "Recommended by BrandSpace"
 * dismisses through this same action (D-277 §7); anything else returns to
 * Intelligence, so a crafted `returnTo` cannot send the browser elsewhere.
 */
function reviewReturn(formData: FormData): '/overview' | '/intelligence' {
  return formData.get('returnTo') === '/overview' ? '/overview' : '/intelligence';
}

export async function reviewIntelligenceAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  await requireWorkspace(locale, 'strategy.manage');
  const insightId = String(formData.get('insightId') ?? '');
  const decision = String(formData.get('decision') ?? 'seen');
  const back = reviewReturn(formData);

  const response = await callPhase7Api('/v1/insights/review', { insightId, decision });
  if (!response.ok) {
    redirect(`/${locale}${back}?error=${codeFrom(response.payload)}`);
  }
  revalidatePath(`/${locale}/intelligence`);
  revalidatePath(`/${locale}/overview`);
  redirect(
    `/${locale}${back}?ok=${decision === 'accept' ? 'INSIGHT_ACCEPTED' : 'INSIGHT_DISMISSED'}`,
  );
}

/**
 * Send what an insight implies back into Brand Brain — the last step of the
 * Phase 8 exit journey (AC-30.4).
 *
 * REQUIRES `brand_brain.review`, not `strategy.manage`: the person asking for
 * the inference to be drawn is the person who will have to judge it. NOTHING IS
 * WRITTEN INTO BRAND BRAIN HERE. Every learning lands as a PENDING candidate in
 * the same review queue a document candidate lands in, carrying its provenance,
 * its evidence, its derived confidence and any conflict with what the brand
 * already says (D-150). The loop closes when a human accepts it there, and not
 * before.
 */
export async function proposeLearningsAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  await requireWorkspace(locale, 'brand_brain.review');
  const insightId = String(formData.get('insightId') ?? '');

  const response = await callPhase7Api('/v1/insights/learnings', { insightId });
  if (!response.ok) {
    redirect(`/${locale}/intelligence?error=${codeFrom(response.payload)}`);
  }
  revalidatePath(`/${locale}/intelligence`);
  redirect(`/${locale}/intelligence?ok=LEARNINGS_PROPOSED`);
}
