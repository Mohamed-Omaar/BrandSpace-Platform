import { createHash } from 'node:crypto';

/**
 * WHAT A REVIEWER ACTUALLY APPROVED, reduced to a value that can be compared
 * later.
 *
 * THE DEFECT THIS EXISTS FOR. An approval recorded a verdict on a content item
 * and nothing about the words. `editVariant` returned an APPROVED item to DRAFT
 * — good — but a SCHEDULED item was deliberately left alone, because the
 * calendar owns that edge and unscheduling somebody's post from an edit handler
 * would be worse. The publish pipeline then read `variant.body` LIVE at send
 * time and checked only that an approval existed and said APPROVED. So the
 * sequence
 *
 *     submit → approve → schedule → edit the caption → publish
 *
 * sent text nobody had reviewed, under a verdict granted to different text, and
 * every row in the audit trail was individually true.
 *
 * A FINGERPRINT CLOSES IT WITHOUT ANYONE HAVING TO GUESS WHOSE JOB IT WAS.
 * The approval records what it was granted over; the publisher recomputes the
 * same value from what it is about to send and refuses if they differ. Neither
 * side has to know about the other's edge cases, and an edit path nobody has
 * written yet is covered by construction.
 *
 * WHY IT LIVES IN `shared`. `@brandspace/social-connectors` deliberately does
 * not depend on `@brandspace/content` — the publish pipeline takes an injected
 * `PublishApprovalGate` rather than buying a package cycle. Both packages do
 * depend on this one, so this is the only place the two sides can share ONE
 * definition. Two copies of a hashing rule is two copies that drift, and the
 * failure mode of drift here is "everything is refused" or, far worse, "nothing
 * is".
 */

/**
 * The fields that change WHAT GETS PUBLISHED.
 *
 * DELIBERATELY NOT the whole row. `title`, `tags`, `pillar` and `campaignId`
 * are properties of the work, not of the post: retitling something a reviewer
 * approved does not change what they approved, and invalidating an approval
 * over it would train people to re-approve reflexively, which is how a control
 * becomes a formality. `validationState` and `characterCount` are derived from
 * `body`, so including them would add nothing but a second way to disagree.
 */
export interface FingerprintedVariant {
  readonly id: string;
  readonly platformKey: string;
  readonly locale: string;
  readonly body: string | null;
  readonly hashtags: readonly string[];
  readonly firstComment: string | null;
  readonly linkUrl: string | null;
  readonly assetIds: readonly string[];
}

/** `{ item, variants: { [variantId]: hash } }`, as stored on the approval. */
export interface ApprovedFingerprint {
  readonly item: string;
  readonly variants: Readonly<Record<string, string>>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * One variant's fingerprint.
 *
 * `JSON.stringify` over an EXPLICIT array rather than the object, because
 * object key order is an implementation detail of whoever built the row and a
 * fingerprint that depends on it would invalidate approvals at random. Arrays
 * that carry meaning as sets — hashtags, asset ids — are NOT sorted: reordering
 * the pictures in a carousel changes the post, so it should change the hash.
 */
export function variantFingerprint(variant: FingerprintedVariant): string {
  return sha256(
    JSON.stringify([
      variant.platformKey,
      variant.locale,
      variant.body ?? '',
      [...variant.hashtags],
      variant.firstComment ?? '',
      variant.linkUrl ?? '',
      [...variant.assetIds],
    ]),
  );
}

/**
 * The whole item's fingerprint, over every variant it had at the time.
 *
 * SORTED BY VARIANT ID so the value does not depend on the order rows came back
 * in. This one DOES change when a variant is added or removed, which is the
 * point: approving a two-channel post and then adding a third channel means the
 * reviewer never saw the third.
 */
export function contentFingerprint(variants: readonly FingerprintedVariant[]): ApprovedFingerprint {
  const byId: Record<string, string> = {};
  for (const variant of variants) byId[variant.id] = variantFingerprint(variant);
  const ordered = Object.keys(byId).sort();
  return {
    item: sha256(JSON.stringify(ordered.map((id) => [id, byId[id]]))),
    variants: byId,
  };
}

/** Narrow a stored `Json` column back to a fingerprint, or `null`. */
export function readApprovedFingerprint(value: unknown): ApprovedFingerprint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw['item'] !== 'string') return null;
  const variants = raw['variants'];
  if (typeof variants !== 'object' || variants === null || Array.isArray(variants)) return null;
  const narrowed: Record<string, string> = {};
  for (const [id, hash] of Object.entries(variants as Record<string, unknown>)) {
    if (typeof hash !== 'string') return null;
    narrowed[id] = hash;
  }
  return { item: raw['item'], variants: narrowed };
}

/**
 * May this approval authorize publishing THIS variant, as it stands right now?
 *
 * FAILS CLOSED IN EVERY UNKNOWN CASE, and each of them is a real one:
 *
 *   - no fingerprint at all — an approval granted before this existed, or a
 *     column that failed to narrow. THERE IS NO BACKFILL: the migration adds a
 *     nullable column and writes nothing into it, because a fingerprint derived
 *     from today's rows would certify exactly the edit this exists to catch. An
 *     approval predating the column cannot prove what it covered, so it does not
 *     authorize a publish and the item has to be approved again.
 *   - the variant is absent from the record — it was created AFTER the
 *     approval, so nobody has reviewed it.
 *   - the hashes differ — the words, the hashtags, the link or the pictures
 *     changed after the verdict.
 *
 * THIS IS THE PER-VARIANT HALF ONLY. The publish gate calls
 * `approvalCoversItem`, which asks this question AND the whole-item one; see
 * that function for why one variant's hash matching is not sufficient.
 */
export function approvalCoversVariant(
  approved: ApprovedFingerprint | null,
  variant: FingerprintedVariant,
): boolean {
  if (!approved) return false;
  const recorded = approved.variants[variant.id];
  if (recorded === undefined) return false;
  return recorded === variantFingerprint(variant);
}

/**
 * May this approval authorize publishing `variantId`, given the item's COMPLETE
 * current variant set?
 *
 * THE VERDICT IS GRANTED OVER THE ITEM, NOT OVER ONE ROW OF IT (D-230). A
 * reviewer opens a post and approves the post: the two channels it goes out on,
 * the captions on each, and the fact that there are two of them. So the check
 * has to be the same shape as the thing that was approved.
 *
 * THE DEFECT THIS CLOSES. `contentFingerprint` always stored an `item` hash
 * that changes when a variant is ADDED or REMOVED — that is what it is for —
 * and the publish gate compared only `variants[id]`. So the whole-item half was
 * recorded and never enforced, and this sequence published under a verdict
 * nobody gave:
 *
 *   submit -> approve two channels -> add a third -> publish the first two
 *
 * The two original variants are untouched, so their hashes still match; the
 * reviewer has never seen the third channel, and nothing refuses. Removing a
 * variant was the mirror image: a post approved as a three-channel campaign
 * went out as a two-channel one, unchallenged.
 *
 * SO BOTH HALVES ARE ASKED, and either one failing is the same answer:
 *
 *   1. the item's fingerprint, recomputed over every variant that exists NOW,
 *      must equal the one recorded at approval — which catches an addition, a
 *      removal, and any edit to any sibling;
 *   2. the variant being published must itself be covered — which is implied by
 *      (1) today and is asked anyway, because it is the narrower statement and
 *      a future `item` hash that stopped depending on a sibling's contents must
 *      not silently widen what a verdict authorizes.
 *
 * `currentVariants` MUST be every variant of the content item, not a filtered
 * view: passing only the one being sent would make (1) compare a one-variant
 * hash against a two-variant one and refuse every legitimate publish.
 */
export function approvalCoversItem(
  approved: ApprovedFingerprint | null,
  currentVariants: readonly FingerprintedVariant[],
  variantId: string,
): boolean {
  if (!approved) return false;
  const now = contentFingerprint(currentVariants);
  if (now.item !== approved.item) return false;
  const variant = currentVariants.find((candidate) => candidate.id === variantId);
  if (!variant) return false;
  return approvalCoversVariant(approved, variant);
}
