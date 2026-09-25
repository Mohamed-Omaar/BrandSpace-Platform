'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { systemClock, creditSpendingPermissions } from '@brandspace/shared';
import { requireWorkspace } from '../../../server/customer-context';
import { callPhase7Api } from '../../../server/analytics-context';

/**
 * "WHY?" — the Analytics screen's explain action (P6-11).
 *
 * `/v1/analytics/explain` has existed since Phase 7 and nothing in the
 * dashboard called it: the screen checked `analytics.explain` only to decide
 * whether to show a list of insights somebody else had produced. So the one
 * question the numbers cannot answer about themselves had no button.
 *
 * THE SAME RULES THE INTELLIGENCE ACTIONS FOLLOW. The permission is re-checked
 * here because a server action is a public endpoint; the generation runs in
 * `apps/api` because it calls the AI Gateway; and a failure travels as a CODE,
 * never as a message.
 *
 * IDEMPOTENT PER BRAND, RANGE AND DAY. The key is deterministic, so a double
 * click — or the same question asked twice today — returns the first
 * explanation rather than generating, and charging for, a second one. A new
 * day is a new question, because a new day is new data.
 *
 * THE ANSWER IS READ WHERE FINDINGS ARE READ. On success the reader lands on
 * the explanation in Marketing Intelligence, with its evidence rows, rather
 * than on a second rendering of it here.
 */
export async function explainPeriodAction(formData: FormData): Promise<void> {
  const locale = String(formData.get('locale') ?? 'en');
  const session = await requireWorkspace(locale, creditSpendingPermissions('analytics.explain'));
  const brandId = String(formData.get('brandId') ?? '');
  const days = Number(formData.get('range') ?? 28);
  const periodDays = [7, 28, 90].includes(days) ? days : 28;
  const compare = String(formData.get('compare') ?? '1') !== '0';
  const today = systemClock.now().toISOString().slice(0, 10);

  const response = await callPhase7Api('/v1/analytics/explain', {
    brandId,
    periodDays,
    compareToPrevious: compare,
    idempotencyKey: `explain:${session.workspace.workspaceId}:${brandId}:${periodDays}:${compare ? 1 : 0}:${today}`,
  });

  const back = `/${locale}/analytics?brand=${encodeURIComponent(brandId)}&range=${periodDays}${
    compare ? '' : '&compare=0'
  }`;
  if (!response.ok) {
    redirect(`${back}&error=${codeFrom(response.payload)}`);
  }
  const payload = response.payload as { insightId?: unknown; insufficientData?: unknown } | null;
  if (payload?.insufficientData === true || typeof payload?.insightId !== 'string') {
    redirect(`${back}&ok=EXPLANATION_INSUFFICIENT`);
  }
  revalidatePath(`/${locale}/analytics`);
  revalidatePath(`/${locale}/intelligence`);
  redirect(
    `/${locale}/intelligence?brand=${encodeURIComponent(brandId)}&insight=${encodeURIComponent(
      String(payload.insightId),
    )}&ok=EXPLANATION_READY`,
  );
}

function codeFrom(payload: unknown): string {
  const error = (payload as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === 'string' ? error.code : 'INTERNAL';
}
