import { contentDispositionHeader } from '@brandspace/storage';

/**
 * PR F (g), Q13 — EVERY UPLOAD IS SERVED AS A DOWNLOAD, NEVER AS A PAGE.
 *
 * The beta runs with file scanning off (the owner's decision), so the two
 * protections that remain must hold for every byte this app serves back: the
 * size and type limits at upload, and this — a customer file is always
 * `attachment`, whatever the grant asked for. Opening its address downloads it;
 * the browser never renders it in the app's origin. An `<img>`, `<video>` or
 * `@font-face` still loads it, because a disposition does not apply to an
 * embedded resource. With `nosniff` and the sandbox CSP each route already
 * sends, nothing served this way can run as a page.
 */
export function servedUploadDisposition(fileName: string): string {
  return contentDispositionHeader('attachment', fileName);
}
