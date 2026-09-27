import { z } from 'zod';

/**
 * CAROUSEL SLIDE HEADLINES — prototype v90 B9 (Phase 2B-2, owner answer D3).
 *
 * A slide is {image, headline}: one short headline per image, no body. The
 * images and their order stay `content_variant.assetIds`, which is what the
 * connectors publish; `content_variant.slides` carries only the words, keyed by
 * the image they belong to, so reordering the images keeps each headline with
 * its picture.
 *
 * NORMALISED ON EVERY WRITE: an entry whose image is no longer on the variant
 * is dropped, the order follows `assetIds`, blank headlines are not stored,
 * and an empty result is stored as NULL — so a post that is not a carousel, or
 * has no headlines, looks exactly like one written before slides existed.
 */
export const SLIDE_HEADLINE_MAX = 120;
export const SLIDES_MAX = 20;

export const slideSchema = z.object({
  assetId: z.string().uuid(),
  headline: z.string().max(SLIDE_HEADLINE_MAX),
});
export const slidesSchema = z.array(slideSchema).max(SLIDES_MAX);

export type Slide = z.infer<typeof slideSchema>;

export function normaliseSlides(
  slides: readonly Slide[],
  assetIds: readonly string[],
): Slide[] | null {
  const byAsset = new Map<string, string>();
  for (const slide of slides) {
    const headline = slide.headline.trim().replace(/\s+/g, ' ');
    if (headline !== '' && !byAsset.has(slide.assetId)) byAsset.set(slide.assetId, headline);
  }
  const ordered = assetIds.flatMap((assetId) => {
    const headline = byAsset.get(assetId);
    return headline === undefined ? [] : [{ assetId, headline }];
  });
  return ordered.length > 0 ? ordered : null;
}

/** A stored value read back; anything malformed reads as no slides. */
export function readSlides(value: unknown): Slide[] {
  const parsed = slidesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
