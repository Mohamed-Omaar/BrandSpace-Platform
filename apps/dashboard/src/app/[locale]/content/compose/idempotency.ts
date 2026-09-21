/**
 * THE COMPOSER'S TWO IDEMPOTENCY KEYS, AND WHY THERE ARE TWO.
 *
 * ONE KEY PER ASK, NOT PER CLICK. A retried request must return the first
 * result and make no second gateway call (AC-11.2), so the key is derived from
 * WHAT WAS ASKED FOR rather than minted inside a click handler — a key made per
 * click turns every retry into a new request and bills twice for a response the
 * browser merely lost.
 *
 * BUT THE COMPOSER MAKES TWO DIFFERENT ASKS, and for a while they shared one
 * key. Adding the campaign to the material was right for MANUAL creation —
 * "the same post, filed under Campaign B" is a different request from the same
 * post filed under Campaign A, and without it the second submission replayed
 * the first draft and discarded the customer's choice. It was WRONG for AI
 * GENERATION, which neither sends a campaign nor persists one: changing only
 * the campaign selector moved the generation key too, so pressing Generate
 * again became a NEW `ai_request` and a NEW credit charge for an ask that had
 * not changed in any way the generation endpoint can see.
 *
 * So the material is split by what each endpoint actually receives:
 *
 *   - `generationKeyFor` — brand, brief, channels, language, type. Exactly the
 *     fields `/api/content/generate` is sent. NO CAMPAIGN, because generation
 *     does not accept one and does not write one; a key that moved on a field
 *     the request does not carry would be charging for a difference the server
 *     never sees.
 *   - `manualKeyFor` — the same, PLUS the campaign, because
 *     `createManualDraftAction` does take it and does persist it.
 *
 * THE PREFIXES DIFFER so the two namespaces are legible apart in a log and in
 * the two tables that store them (`ai_request.idempotencyKey` and
 * `content_item.idempotencyKey`).
 *
 * A PURE MODULE, deliberately: the guarantee is a property of the DERIVATION,
 * and a property of a derivation is provable without a browser. It lives beside
 * the composer because it is the composer's contract and nothing else's.
 */

/** The answers both asks share. */
export interface ComposerAsk {
  readonly brandId: string;
  readonly brief: string;
  readonly platformKeys: readonly string[];
  readonly contentLocale: string;
  readonly contentType: string;
}

/**
 * A stable, short digest of the material.
 *
 * The channels are SORTED, because picking Instagram then LinkedIn is the same
 * ask as picking LinkedIn then Instagram. The length is appended so two
 * different materials that happen to collide on a 32-bit hash still differ.
 */
function digest(material: readonly unknown[]): string {
  const text = JSON.stringify(material);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(31, hash) + text.charCodeAt(index)) | 0;
  }
  return `${(hash >>> 0).toString(36)}:${text.length}`;
}

function sharedMaterial(ask: ComposerAsk): readonly unknown[] {
  return [ask.brandId, ask.brief, [...ask.platformKeys].sort(), ask.contentLocale, ask.contentType];
}

/**
 * The key for QUOTE, GENERATE and the per-variant tools.
 *
 * `draftId` scopes it to the draft being worked on, so the same brief against
 * two drafts is two asks.
 */
export function generationKeyFor(ask: ComposerAsk, draftId: string | null): string {
  return `ui:${draftId ?? 'new'}:${digest(sharedMaterial(ask))}`;
}

/**
 * The key for MANUAL creation, which carries the campaign.
 *
 * `campaignId` is '' for "no campaign", which is a real answer and must hash
 * differently from any campaign id.
 */
export function manualKeyFor(ask: ComposerAsk, campaignId: string): string {
  return `ui-manual:${digest([...sharedMaterial(ask), campaignId])}`;
}
