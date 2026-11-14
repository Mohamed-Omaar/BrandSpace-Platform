import { checksumOf } from './storage';
import type { ReceiveResult, UploadInput } from './ingestion';
import { readWebsite, websiteDocument, type WebReader, type WebsiteReading } from './web-reader';

/**
 * PR C (owner, 2026-11-14) — THE BRAND'S WEBSITE AS ONE BRAND BRAIN SOURCE.
 *
 * The brand's home page and up to five more pages of the same site, read
 * through the one web reader, become ONE plain-text source and are handed to
 * `receive` — exactly the path an uploaded file takes (the media-processing
 * worker, then `brand.extract`), so what the site says waits in Pending for a
 * person to approve. Started from Brand Brain → Sources, or from the
 * Copilot's card once the person presses Read.
 */

/** The brand's website as an https address to read, or null when there is none. */
export function websiteHome(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (value === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    // Read over https only: an http:// address is read as its https:// twin.
    return new URL(withScheme.replace(/^http:\/\//i, 'https://')).toString();
  } catch {
    return null;
  }
}

/** The host to show for a brand's website ("brand.com"), or null. */
export function websiteHostOf(raw: string | null | undefined): string | null {
  const home = websiteHome(raw);
  return home ? new URL(home).hostname : null;
}

export async function readWebsiteIntoSource(input: {
  readonly reader: WebReader;
  readonly home: string;
  readonly workspaceId: string;
  readonly brandId: string;
  readonly actorUserId: string;
  readonly actorBrandScope: readonly string[];
  readonly receive: (upload: UploadInput) => Promise<ReceiveResult>;
}): Promise<{ readonly reading: WebsiteReading; readonly received: ReceiveResult }> {
  const reading = await readWebsite(input.reader, input.home);
  const host = new URL(reading.home).hostname.replace(/^www\./, '');
  const bytes = new TextEncoder().encode(websiteDocument(reading));
  const checksum = await checksumOf(bytes);
  const pages = reading.pages.length;
  const received = await input.receive({
    brandId: input.brandId,
    fileName: `${host} — website (${pages} ${pages === 1 ? 'page' : 'pages'}).txt`,
    mimeType: 'text/plain',
    bytes,
    // The same site, read the same way, is a replay; changed pages are a new source.
    idempotencyKey: `web:${input.workspaceId}:${input.brandId}:${checksum}`,
    actorUserId: input.actorUserId,
    actorBrandScope: input.actorBrandScope,
  });
  return { reading, received };
}
