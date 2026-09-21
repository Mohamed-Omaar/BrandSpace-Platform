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
 *     column that failed to narrow. Refusing is the safe direction, and the
 *     migration backfills existing approvals so this is not a mass refusal.
 *   - the variant is absent from the record — it was created AFTER the
 *     approval, so nobody has reviewed it.
 *   - the hashes differ — the words, the hashtags, the link or the pictures
 *     changed after the verdict.
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
