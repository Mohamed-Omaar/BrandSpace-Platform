import { NextResponse } from 'next/server';
import { proxyToApi } from '../proxy';
import { submitAiDraftWhenAsked } from '../../../../server/ai-drafts-review';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const response = await proxyToApi(request, '/v1/content/generate');
  if (response.status !== 200) return response;
  /*
   * D-496 (Settings 3) — a fresh AI draft goes to review when its brand asks
   * (`server/ai-drafts-review.ts`). Not on a replay (already handled the first
   * time) and not on the empty "not enough knowledge" draft.
   */
  const payload = (await response.clone().json()) as {
    itemId?: unknown;
    replayed?: unknown;
    insufficientKnowledge?: unknown;
  };
  if (
    typeof payload.itemId !== 'string' ||
    payload.replayed === true ||
    payload.insufficientKnowledge === true
  ) {
    return response;
  }
  const submittedForReview = await submitAiDraftWhenAsked(payload.itemId);
  return NextResponse.json({ ...payload, submittedForReview }, { status: 200 });
}
