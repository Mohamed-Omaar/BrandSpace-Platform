import { NextResponse } from 'next/server';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { uploadAssetAction, uploadAssetFileAction } from '../../../[locale]/assets/actions';
import { readWebsiteAction, uploadSourceAction } from '../../../[locale]/brand-brain/actions';
import { uploadComposerMediaAction } from '../../../[locale]/content/actions';
import { uploadChatImageAction } from '../../../[locale]/copilot/actions';

/**
 * P1 — AN UPLOAD THAT SHOWS ITS PROGRESS. A server action is sent by
 * `fetch`, which reports nothing while a body goes up, so the upload forms
 * send the SAME form to this route with `XMLHttpRequest` instead and draw
 * the bar from its upload events. Nothing about the upload itself changes:
 * each kind is the server action the form always called, with its own
 * session, rules, checks, storage and audit; a redirecting action's
 * destination comes back as `{ location }` for the form to follow, and the
 * one-file-of-several variant's `{ ok, reason }` comes back as it is.
 *
 * Same-origin only, as a server action is: the browser's `Origin` must be
 * this host, and the request must carry `x-bs-upload`, a header another
 * site's form cannot send without asking first. The body limit is the one
 * the server actions have (`next.config` `bodySizeLimit`, 24 MB).
 */
const KINDS = {
  asset: uploadAssetAction,
  'asset-file': uploadAssetFileAction,
  'composer-media': uploadComposerMediaAction,
  'brand-source': uploadSourceAction,
  // PR C — the brand's own website, read into Brand Brain (same path, no file).
  'brand-website': readWebsiteAction,
  // PR A (smart Copilot, D-605) — an image the person sends the Copilot.
  'chat-image': uploadChatImageAction,
} as const satisfies Record<string, (formData: FormData) => Promise<unknown>>;

export type UploadRelayKind = keyof typeof KINDS;

const MAX_BYTES = 24 * 1024 * 1024;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host.split(',')[0]?.trim();
  } catch {
    return false;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const { kind } = await params;
  const action = Object.hasOwn(KINDS, kind) ? KINDS[kind as UploadRelayKind] : null;
  if (!action) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  if (!sameOrigin(request) || request.headers.get('x-bs-upload') !== '1') {
    return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
  }
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BYTES) {
    return NextResponse.json({ error: 'TOO_LARGE' }, { status: 413 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'BAD_REQUEST' }, { status: 400 });
  }
  try {
    const outcome = await action(form);
    return NextResponse.json(outcome ?? {}, { headers: { 'cache-control': 'no-store' } });
  } catch (error: unknown) {
    if (isRedirectError(error)) {
      return NextResponse.json(
        { location: getURLFromRedirectError(error) },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    throw error;
  }
}
