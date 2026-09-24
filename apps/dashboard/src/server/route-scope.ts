import type { BrandScopeKind } from './brand-selection';

/**
 * EVERY DASHBOARD ROUTE'S SCOPE, IN ONE TABLE (D-192).
 *
 * WHY A TABLE AND NOT A JUDGEMENT PER PAGE. "Is this screen about one brand?"
 * was answered independently eighteen times before Phase 8, and the answers did
 * not agree — one screen chose a brand silently, three rendered their own
 * picker, and the rest read the whole workspace. A question answered in
 * eighteen places has eighteen chances to be answered differently.
 *
 * THE THREE ANSWERS:
 *
 *   `workspace`    The brand selection is IRRELEVANT here. Members, plan,
 *                  settings, activity: these belong to the tenant, not to a
 *                  marketing identity inside it. The selector still renders —
 *                  it is global — and the page simply does not read it.
 *
 *   `brand`        The page needs EXACTLY ONE brand and cannot be honest
 *                  without it. With nothing selected it asks; it never picks.
 *
 *   `brand-or-all` An aggregate is meaningful. "All Brands" means the brands
 *                  THIS MEMBER may access — never every brand in the workspace.
 *
 * ADDING A ROUTE WITHOUT ADDING IT HERE IS THE MISTAKE THIS FILE EXISTS TO
 * MAKE VISIBLE: `scopeForPath` falls back to `workspace`, which is the answer
 * that reads no brand at all, so a forgotten route is inert rather than wrong.
 */
export const ROUTE_SCOPES: Readonly<Record<string, BrandScopeKind>> = {
  // --- Workspace-scoped: about the tenant, not about a brand ----------------
  '/activity': 'workspace',
  '/notifications': 'workspace',
  '/members': 'workspace',
  '/permissions': 'workspace',
  '/plan': 'workspace',
  /*
   * Phase 9. Billing is a WORKSPACE fact, not a brand one. A workspace has one
   * subscription, one currency and one set of invoices however many brands it
   * holds, so scoping this to a brand would be inventing a distinction the
   * commercial model does not have.
   */
  '/billing': 'workspace',
  // Phase 9. The first-run checklist is a workspace-wide view of what has been
  // set up; it points at brand screens rather than being one.
  '/onboarding': 'workspace',
  '/settings': 'workspace',
  '/workspaces': 'workspace',
  '/no-workspace': 'workspace',

  // --- Brand-scoped: exactly one brand, declared rather than guessed --------
  /*
   * BRAND BRAIN is the screen the silent first-brand guess lived on. Knowledge
   * belongs to one brand's identity and nothing about it aggregates: two
   * brands' tones of voice averaged together is not a tone of voice.
   */
  '/brand-brain': 'brand',
  /*
   * BRAND PROFILE is the canonical identity of one brand by definition (D-189).
   */
  '/settings/brand': 'brand',
  /*
   * AI STRATEGY is generated FROM one brand's memories and accepted AGAINST
   * that brand. A strategy for "all brands" is not a strategy.
   */
  '/strategy': 'brand',
  /*
   * ANALYTICS stays brand-required in Phase 8, and this is a deliberate
   * narrowing rather than an oversight. The analytics query layer takes a
   * single `scope.brandId` throughout — totals, comparisons, trends, top posts
   * and the evidence table all resolve against one brand — so an aggregate mode
   * is a change to what the numbers MEAN, not a change to how a brand is
   * chosen. Phase 8 is a context pass; inventing cross-brand aggregation inside
   * it would be exactly the "change business semantics blindly to make every
   * screen filter by brand" the phase brief rules out.
   */
  '/analytics': 'brand',
  /*
   * THE COPILOT is bound to its session's brand for the whole conversation
   * (P7-A2): every tool call it makes is checked against that brand, so the
   * brand is part of the session's identity rather than a filter over it.
   */
  '/copilot': 'brand',
  /*
   * CREATING A CAMPAIGN is a creation surface about exactly one brand, so it
   * asks rather than filing the campaign under whichever brand sorted first.
   * The LIST below is brand-or-all, and a campaign's own detail page reads the
   * brand stored on the campaign — global context never reinterprets which
   * brand an existing object belongs to (D-190).
   */
  '/campaigns/new': 'brand',
  /*
   * THE AI CREATIVE STUDIO generates on ONE brand's identity — its palette, its
   * description, its approved knowledge — so a studio that picked a brand for
   * the author would produce something that looks like a brand they did not
   * choose.
   */
  '/creative': 'brand',
  /*
   * MARKETING INTELLIGENCE asks what ONE brand said it would do and has not.
   * The question only has an answer for a brand that declared pillars, connected
   * accounts and set a cadence — averaged across brands it is not a question.
   */
  '/intelligence': 'brand',

  // --- Brand or All Brands: aggregation is meaningful -----------------------
  /*
   * THE COMMAND CENTER is a daily digest. Narrowing it to one brand is useful;
   * so is seeing everything at once, which is what a multi-brand owner opens it
   * for.
   */
  '/overview': 'brand-or-all',
  '/content': 'brand-or-all',
  '/calendar': 'brand-or-all',
  '/assets': 'brand-or-all',
  '/approvals': 'brand-or-all',
  '/integrations': 'brand-or-all',
  /*
   * PUBLISHING (Phase 6 final, D-277): the queue, history and account health
   * across the brands a member can see, narrowed by the rail's brand.
   */
  '/publishing': 'brand-or-all',
  '/automations': 'brand-or-all',
  /*
   * THE CAMPAIGN LIST aggregates honestly: a multi-brand owner planning a
   * quarter wants every campaign in front of them, and a brand on the rail
   * narrows it.
   */
  '/campaigns': 'brand-or-all',
  /*
   * P6-16. NOTES reads conversations across subjects. Every brand the member
   * can see is a meaningful answer, and a brand on the rail narrows it — the
   * same shape as the Command Center it feeds.
   */
  '/notes': 'brand-or-all',
};

/**
 * The scope for a path.
 *
 * Matches the LONGEST declared prefix, so `/settings/brand` is brand-scoped
 * while `/settings` stays workspace-scoped, and `/content/compose` inherits
 * `/content` without a second entry.
 */
export function scopeForPath(path: string): BrandScopeKind {
  const direct = ROUTE_SCOPES[path];
  if (direct) return direct;

  let best: { length: number; scope: BrandScopeKind } | null = null;
  for (const [prefix, scope] of Object.entries(ROUTE_SCOPES)) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best.length) best = { length: prefix.length, scope };
    }
  }
  // An undeclared route reads no brand at all — inert, never wrong.
  return best?.scope ?? 'workspace';
}
