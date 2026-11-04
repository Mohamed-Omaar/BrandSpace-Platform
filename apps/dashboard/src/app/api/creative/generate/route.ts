import type { NextResponse } from 'next/server';
import { proxyToApi } from '../../content/proxy';

export const dynamic = 'force-dynamic';

/**
 * PR 1 (D-597) — ASK FOR ONE IMAGE; THE ANSWER IS A JOB.
 *
 * The API writes the job and answers 202 at once with `{ jobId, job }`; the
 * image is made in the background. The screen follows the job through
 * `/api/creative/jobs/<id>`, which adds the preview token once it has
 * SUCCEEDED. This route used to wait for the image itself, and the wait
 * failed at 90 s on staging. Same body as before, plus an optional
 * `contentVariantId` for an image asked for from a post (the API attaches
 * it there when it is ready).
 */
export async function POST(request: Request): Promise<NextResponse> {
  return proxyToApi(request, '/v1/creative/generate');
}
