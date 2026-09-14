import type { AssetDerivativeKind, AssetKind } from '@brandspace/database';
import type { DerivativePolicy } from './policy';

/**
 * Derivatives — the bounded, approved transformations of an asset's bytes.
 *
 * WHAT IS AND IS NOT BUILT HERE, STATED PLAINLY RATHER THAN IMPLIED.
 *
 * The RECORD, the BOUNDS, the LIFECYCLE and the DELETION of a derivative are
 * real: a row per derivative, a configured ceiling, generation on the queue,
 * and removal with the asset. What is NOT built is a raster image processor.
 * Re-encoding a PNG to 320px needs a decoder, and every candidate — sharp,
 * jimp, squoosh — is a dependency running on bytes a stranger uploaded, which
 * is exactly the review CLAUDE.md and D-94 require before a parser ships. None
 * has been reviewed, so none is here.
 *
 * The consequence is stated honestly rather than hidden behind a stub that
 * returns something: for a format this build cannot re-encode, `plan()` returns
 * NO derivatives and the asset becomes READY with none. The screen then shows
 * the asset's own bytes at CSS size for an image, and a typed placeholder for
 * everything else. It does not show a broken thumbnail, and it does not claim a
 * derivative exists.
 *
 * WHY THE PLANNER EXISTS ANYWAY. The decision of WHICH derivatives an asset
 * should have is policy — it depends on the kind, on what an operator enabled
 * and on the ceiling — and it is testable without any encoder at all. Keeping
 * it separate means the day an image processor is approved, the change is one
 * function that produces bytes, and nothing about the bounds, the records, the
 * quota accounting or the deletion path moves.
 */

/** One derivative that SHOULD exist for an asset, per policy. */
export interface PlannedDerivative {
  readonly kind: AssetDerivativeKind;
  /** The longest edge the output may have. */
  readonly maxEdgePx: number;
}

/**
 * Which kinds this build can actually produce bytes for.
 *
 * EMPTY, and that is the current, accurate answer. It is a named constant
 * rather than an inline `false` so that the day an encoder is approved, the
 * single place to change is visible — and so a reader can tell "nothing is
 * supported yet" from "this code path was forgotten".
 */
export const ENCODABLE_KINDS: readonly AssetKind[] = [];

/**
 * The derivatives an asset should have.
 *
 * Bounded THREE times over, and each bound is a different failure it prevents:
 *   - by KIND, because a font has no thumbnail and asking for one is work with
 *     no output;
 *   - by the operator's enable switches, so a pipeline can be turned down
 *     without a release;
 *   - by `maxPerAsset`, which is the ceiling that holds even if the enum grows
 *     and nobody revisits the switches.
 */
export function planDerivatives(
  kind: AssetKind,
  policy: DerivativePolicy,
): readonly PlannedDerivative[] {
  if (!ENCODABLE_KINDS.includes(kind)) return [];

  const planned: PlannedDerivative[] = [];
  if (policy.thumbnailEnabled) {
    planned.push({ kind: 'THUMBNAIL', maxEdgePx: policy.thumbnailMaxEdgePx });
  }
  if (policy.previewEnabled) {
    planned.push({ kind: 'PREVIEW', maxEdgePx: policy.previewMaxEdgePx });
  }
  return planned.slice(0, Math.max(0, policy.maxPerAsset));
}

/**
 * Whether the library can render this asset from its OWN bytes, with no
 * derivative.
 *
 * THE HONEST MIDDLE GROUND between "show a thumbnail" and "show nothing". A
 * browser decodes PNG, JPEG, WebP and GIF natively, so an image with no
 * derivative is still previewable — at the cost of sending the full-size object
 * to a grid, which is precisely what a thumbnail would fix and why the ceiling
 * below exists. Anything larger falls back to the typed placeholder rather than
 * pushing a 20 MB file into a gallery.
 */
const BROWSER_DECODABLE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Above this, an image is NOT sent to a grid without a derivative. */
export const INLINE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

export function canPreviewWithoutDerivative(mimeType: string, sizeBytes: number): boolean {
  return BROWSER_DECODABLE.has(mimeType) && sizeBytes <= INLINE_PREVIEW_MAX_BYTES;
}
