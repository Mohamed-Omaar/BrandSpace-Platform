import type { StorageBreakdownRow } from '@brandspace/entitlements';

/**
 * ROUND 4 (4.7) — THE MEDIA STORAGE CARD'S FOUR CATEGORIES, as the prototype
 * names them: Photos, Videos, AI images and Brand files.
 *
 * READ-ONLY DISPLAY. The bytes are the SAME rows the storage meter sums
 * (`measureStorageBreakdown`, B-1/B-8), only regrouped; the counts are the
 * library's live files and Brand Brain's live documents. Nothing here writes
 * the counter, changes what counts as stored, or touches `BYTES_PER_GB`.
 *
 *   - AI images — a library file the AI made (`source = AI_GENERATED`);
 *   - Photos — any other image; Videos — any other video;
 *   - Brand files — every other library file (documents, fonts, audio) and
 *     the Brand Brain's source documents.
 *
 * An upload still in progress is storage the meter counts but no category
 * owns; it is in the "used" figure and in none of the four.
 */
export type MediaStorageKey = 'photos' | 'videos' | 'ai' | 'brand';

export const MEDIA_STORAGE_ORDER: readonly MediaStorageKey[] = ['photos', 'videos', 'ai', 'brand'];

export interface MediaStorageCategory {
  readonly key: MediaStorageKey;
  readonly bytes: number;
  readonly files: number;
}

export function mediaStorageKeyFor(kind: string | null, source: string | null): MediaStorageKey {
  if (source === 'AI_GENERATED') return 'ai';
  if (kind === 'IMAGE') return 'photos';
  if (kind === 'VIDEO') return 'videos';
  return 'brand';
}

export function mediaStorageCategories(
  rows: readonly StorageBreakdownRow[],
  libraryCounts: readonly {
    readonly kind: string;
    readonly source: string;
    readonly files: number;
  }[],
  brandBrainFiles: number,
): readonly MediaStorageCategory[] {
  const bytes = new Map<MediaStorageKey, bigint>();
  const files = new Map<MediaStorageKey, number>();
  for (const row of rows) {
    if (row.category === 'UPLOADING') continue;
    const key = row.category === 'BRAND_BRAIN' ? 'brand' : mediaStorageKeyFor(row.kind, row.source);
    bytes.set(key, (bytes.get(key) ?? 0n) + row.bytes);
  }
  for (const count of libraryCounts) {
    const key = mediaStorageKeyFor(count.kind, count.source);
    files.set(key, (files.get(key) ?? 0) + count.files);
  }
  files.set('brand', (files.get('brand') ?? 0) + brandBrainFiles);
  return MEDIA_STORAGE_ORDER.map((key) => ({
    key,
    bytes: Number(bytes.get(key) ?? 0n),
    files: files.get(key) ?? 0,
  }));
}
