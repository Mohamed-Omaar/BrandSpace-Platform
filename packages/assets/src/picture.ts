import { randomUUID } from 'node:crypto';
import { checkAssetSignature } from './file-safety';
import { maxBytesForKind, type AssetPolicy } from './policy';
import type { VirusScanner } from './scanning';

/**
 * PR D (D-608) — A PERSON'S AVATAR OR A WORKSPACE'S LOGO.
 *
 * THE SAME RULES AS AN IMAGE IN THE ASSET LIBRARY, AND THE SAME SCAN:
 *
 *   - PNG, JPEG or WebP only — never SVG (a picture that can carry script) and
 *     never a type the activated asset policy does not allow;
 *   - the TYPE IS READ FROM THE BYTES (`checkAssetSignature`), not from the
 *     browser's claim or the file name;
 *   - no larger than the policy's image ceiling (`assets.upload.maxFileBytes.image`,
 *     configuration — no number is written down here);
 *   - scanned by the configured malware scanner before it is stored; a file the
 *     scanner calls infected, or could not judge, is refused.
 *
 * The browser crops the picture square before it is sent; the circle is drawn
 * by the stylesheet. Nothing here trusts that the crop happened: a picture that
 * was not cropped is shown cropped (`object-fit: cover`).
 */

export const PICTURE_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
} as const;
export type PictureType = keyof typeof PICTURE_TYPES;

export type PictureRefusal =
  | 'picture-missing'
  | 'picture-type'
  | 'picture-too-large'
  | 'picture-unsafe'
  | 'picture-scan-failed';

export type PictureCheck =
  | { readonly ok: true; readonly contentType: PictureType; readonly extension: string }
  | { readonly ok: false; readonly reason: PictureRefusal };

export async function checkPicture(input: {
  readonly bytes: Uint8Array;
  readonly declaredMimeType: string;
  readonly policy: AssetPolicy;
  readonly scanner: VirusScanner;
}): Promise<PictureCheck> {
  const { bytes, policy } = input;
  if (bytes.byteLength === 0) return { ok: false, reason: 'picture-missing' };
  const declared = input.declaredMimeType.toLowerCase();
  if (
    !(declared in PICTURE_TYPES) ||
    !(policy.upload.allowedMimeTypes.image ?? []).includes(declared)
  ) {
    return { ok: false, reason: 'picture-type' };
  }
  if (bytes.byteLength > maxBytesForKind(policy.upload, 'IMAGE')) {
    return { ok: false, reason: 'picture-too-large' };
  }
  if (!checkAssetSignature(declared, bytes).ok) return { ok: false, reason: 'picture-type' };
  const verdict = await input.scanner
    .scan({ bytes, declaredMimeType: declared, timeoutMs: policy.scanning.timeoutMs })
    .catch(() => ({ verdict: 'failed' as const }));
  if (verdict.verdict === 'infected') return { ok: false, reason: 'picture-unsafe' };
  if (verdict.verdict === 'failed') return { ok: false, reason: 'picture-scan-failed' };
  const contentType = declared as PictureType;
  return { ok: true, contentType, extension: PICTURE_TYPES[contentType] };
}

/** `avatars/<userId>/<uuid>.<ext>` — the shape the database's CHECK allows. */
export function avatarObjectKey(userId: string, extension: string): string {
  return `avatars/${userId}/${randomUUID()}.${extension}`;
}

/** `workspaces/<workspaceId>/logo/<uuid>.<ext>` — the shape the database's CHECK allows. */
export function workspaceLogoObjectKey(workspaceId: string, extension: string): string {
  return `workspaces/${workspaceId}/logo/${randomUUID()}.${extension}`;
}

/** The content type of a stored picture, from its key's extension. */
export function pictureContentType(storageKey: string): PictureType | null {
  const extension = storageKey.split('.').pop();
  const entry = Object.entries(PICTURE_TYPES).find(([, ext]) => ext === extension);
  return entry ? (entry[0] as PictureType) : null;
}
