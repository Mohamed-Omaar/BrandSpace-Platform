/**
 * THE BRAND SELECTION RULES (D-190, D-191, D-192).
 *
 * WHAT THEY REPLACE. Before Phase 8 every brand-scoped screen answered "which
 * brand is this about?" on its own, and they did not agree:
 *
 *   - Brand Brain took the workspace's OLDEST brand, silently. A member with
 *     four brands opened the screen already editing one of them, with nothing
 *     on the page saying which.
 *   - Content, Analytics and Strategy each rendered their own `?brand=` picker
 *     with their own fallback to `brands[0]`.
 *   - Everything else read the whole workspace and filtered afterwards.
 *
 * Four answers to one question, one of them a guess. THE GUESS IS THE DEFECT: a
 * screen that quietly decides which brand you are working on is a screen that
 * can quietly put your work on the wrong one.
 *
 * WHY THIS MODULE IS NOT `server-only`. Everything here is a PURE DECISION —
 * parse a cookie, resolve a precedence, validate a return path — and every one
 * of those rules is about a request THE SCREEN CANNOT PRODUCE: a cookie from
 * another workspace, a `next` that leaves the site, a URL naming a brand the
 * reader may not see. A `server-only` module cannot be imported by a unit test
 * at all, so rules that live in one get assumed rather than asserted (the Phase
 * 7 round-5 lesson). `brand-context.ts` is the server half that does the I/O.
 *
 * THE PRECEDENCE, AND WHY IT IS THIS ONE:
 *
 *   1. AN EXPLICIT `?brand=` IN THE URL WINS, so a deep link means the same
 *      thing for everyone who opens it. A URL naming a brand this member may
 *      not see resolves to NO SELECTION — it does NOT fall through to the
 *      cookie, because a link that quietly showed the reader a different brand
 *      than it names is worse than a link that asks.
 *   2. THE COOKIE, read only when the URL is silent. It is what makes the
 *      selection survive ordinary navigation.
 *   3. NOTHING. A brand-required page with no valid selection ASKS; a workspace
 *      with no brands at all offers to create one. Neither picks.
 *
 * THE COOKIE IS NOT AN AUTHORIZATION CREDENTIAL. It carries
 * `<workspaceId>:<value>`:
 *
 *   - THE WORKSPACE HALF is what makes switching workspace safe. A cookie whose
 *     workspace does not match the live session is ignored OUTRIGHT — nothing
 *     is looked up, so a switch cannot be used to ask whether a brand exists in
 *     the workspace being switched into.
 *   - THE BRAND HALF only ever PROPOSES. It is re-validated against the
 *     member's BrandScope at query time on every request, so a scope narrowed a
 *     minute ago takes effect on the next page load.
 *
 * A DEEP LINK DOES NOT REWRITE THE READER'S STORED SELECTION. Opening a
 * colleague's `?brand=` link shows you that brand for that page and leaves your
 * own selection where it was; only the selector writes the cookie.
 */

/** The cookie that remembers a selection. Never authorization — see above. */
export const BRAND_COOKIE = 'bs_brand';

/**
 * The value that means "every brand I may see".
 *
 * A reserved word rather than an empty string, because empty is what a cleared
 * form field looks like and those are different requests (the Phase 7 round-5
 * lesson, applied here before it can cost anything).
 */
export const ALL_BRANDS = 'all';

/** How a route reads the brand selection. One table, in `route-scope.ts`. */
export type BrandScopeKind = 'workspace' | 'brand' | 'brand-or-all';

/**
 * What resolving a context needs, and nothing more.
 *
 * THE WORKSPACE AND THE MEMBER'S SCOPE — not a whole session. Pages in this app
 * destructure `{ customer, workspace }` from `requireWorkspace` and others keep
 * the session object; asking for the smallest thing that answers the question
 * means both shapes pass `workspace` and no page has to be restructured.
 */
export interface BrandContextSource {
  readonly workspaceId: string;
  readonly brandScope: readonly string[];
}

export interface AccessibleBrand {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
}

/**
 * What the page should actually do, already decided.
 *
 * A page reads this rather than re-deriving "do I have a brand?" from the list
 * and the selection — which is exactly the re-derivation that produced four
 * different answers before.
 */
export type BrandResolution =
  /** Exactly one brand. The only shape a brand-required page may proceed on. */
  | { readonly kind: 'brand'; readonly brand: AccessibleBrand }
  /** Every brand this member may see. `brandIds` is already the scoped set. */
  | { readonly kind: 'all'; readonly brandIds: readonly string[] }
  /** Brands exist and none is selected. The page asks; it does not choose. */
  | { readonly kind: 'unselected' }
  /** This member can act on no brand at all. The page offers to create one. */
  | { readonly kind: 'empty' };

export interface BrandContext {
  /** The brands the MEMBER may act on, filtered in the query by BrandScope. */
  readonly brands: readonly AccessibleBrand[];
  /** The resolved answer for the route's declared scope. */
  readonly resolution: BrandResolution;
  /** The selector's current value: a brand id, `all`, or null for unselected. */
  readonly selectedValue: string | null;
  /** Whether this route offers the aggregate at all. */
  readonly aggregateAllowed: boolean;
}

/**
 * The stored selection, or null.
 *
 * NULL FOR EVERY UNUSABLE SHAPE, and deliberately without distinguishing them:
 * a missing cookie, a malformed one and one belonging to another workspace all
 * mean the same thing to the caller, which is "you have not chosen".
 */
export function parseBrandCookie(
  raw: string | null | undefined,
  workspaceId: string,
): string | null {
  if (!raw) return null;
  const separator = raw.indexOf(':');
  if (separator <= 0) return null;
  const owner = raw.slice(0, separator);
  // The FIRST colon only, so a value containing one is not truncated into a
  // different id.
  const value = raw.slice(separator + 1);
  // THE WORKSPACE HALF DECIDES, before anything is looked up anywhere.
  if (owner !== workspaceId) return null;
  if (value === '') return null;
  return value;
}

/** The cookie value for a selection. The workspace is part of the identity. */
export function brandCookieValue(workspaceId: string, selection: string): string {
  return `${workspaceId}:${selection}`;
}

/**
 * Resolve a selection against the brands a member may act on.
 *
 * PURE. The caller supplies the list (read under BrandScope) and the cookie's
 * already-parsed value; this decides what the page should do with them.
 */
export function resolveSelection(
  brands: readonly AccessibleBrand[],
  options: {
    readonly scope: BrandScopeKind;
    readonly requested?: string | null | undefined;
    readonly stored?: string | null | undefined;
  },
): BrandContext {
  const requested =
    typeof options.requested === 'string' && options.requested.trim() !== ''
      ? options.requested.trim()
      : null;
  const stored = options.stored ?? null;

  // 1. THE URL, if it said anything. Its answer is final for this request.
  // 2. Otherwise the cookie. Consulted only because the URL was silent.
  const proposal = requested ?? stored;

  const selected =
    proposal === null
      ? null
      : proposal === ALL_BRANDS
        ? ALL_BRANDS
        : (brands.find((brand) => brand.id === proposal)?.id ?? null);

  return {
    brands,
    selectedValue: selected,
    aggregateAllowed: options.scope === 'brand-or-all',
    resolution: resolve(brands, selected, options.scope),
  };
}

function resolve(
  brands: readonly AccessibleBrand[],
  selected: string | null,
  scope: BrandScopeKind,
): BrandResolution {
  if (brands.length === 0) return { kind: 'empty' };

  const brandIds = brands.map((brand) => brand.id);

  if (selected !== null && selected !== ALL_BRANDS) {
    const brand = brands.find((candidate) => candidate.id === selected);
    if (brand) return { kind: 'brand', brand };
  }

  /*
   * NO SELECTION IS NOT A MISSING BRAND, IT IS A MISSING CHOICE — and what to
   * do about it depends entirely on what the page is.
   *
   * On an AGGREGATE-CAPABLE page, showing everything the member may see is an
   * honest answer to "no filter": it is not choosing a brand, it is declining
   * to narrow. On a BRAND-REQUIRED page there is no such answer, so the page
   * asks. The one thing neither does is pick one of several.
   */
  if (scope === 'brand-or-all' || scope === 'workspace') return { kind: 'all', brandIds };

  /*
   * ONE ACCESSIBLE BRAND RESOLVES TO ITSELF, AND THAT IS NOT THE DEFECT.
   *
   * The defect was preferring the OLDEST OF SEVERAL — a choice made on the
   * reader's behalf, between real alternatives, invisibly. Where the member can
   * act on exactly one brand there is no choice to make and nothing is being
   * preferred: demanding a click to confirm the only option teaches nobody
   * anything and makes a single-brand workspace — which is most of them — worse
   * for no gain. The rail still names the brand, so the screen is never silent
   * about what it is about.
   *
   * TWO OR MORE AND IT ASKS. The moment there is an alternative, the product
   * stops deciding.
   */
  const only = brands[0];
  if (brands.length === 1 && only) return { kind: 'brand', brand: only };

  return { kind: 'unselected' };
}

/**
 * The brand a brand-required page must proceed on, or null.
 *
 * A convenience with one job: making the "there is no brand, do not invent one"
 * branch impossible to forget, because the only way to get a brand out of a
 * context is to handle the other three shapes.
 */
export function requiredBrand(context: BrandContext): AccessibleBrand | null {
  return context.resolution.kind === 'brand' ? context.resolution.brand : null;
}

/**
 * The brand id a query should be narrowed to, or `undefined` for "no narrowing
 * beyond the member's own scope".
 *
 * `undefined` rather than the full list on an aggregate, so a caller can pass it
 * straight to a service that already intersects with BrandScope and not turn an
 * unrestricted read into an enumeration of ids.
 */
export function brandFilterFor(context: BrandContext): string | undefined {
  return context.resolution.kind === 'brand' ? context.resolution.brand.id : undefined;
}

/**
 * The brand a CREATION surface should start on, or `null` for "ask".
 *
 * NOT THE SAME QUESTION AS `brandFilterFor`, which is about READING. A filter
 * may honestly answer "everything"; a new piece of content cannot be filed
 * under "everything" — it belongs to exactly one brand. So a creation form asks
 * this instead, and the answers differ in one case: the aggregate.
 *
 * ON THE AGGREGATE WITH ONE ACCESSIBLE BRAND THE ANSWER IS THAT BRAND, for the
 * same reason a brand-required page resolves a sole brand to itself (D-191).
 * "All brands" over one brand names that brand; there is no alternative to
 * choose between and therefore no choice being made on the reader's behalf.
 * With two or more, this returns `null` and the form asks — which is the whole
 * point.
 */
export function defaultBrandFor(context: BrandContext): string | null {
  const { resolution } = context;
  if (resolution.kind === 'brand') return resolution.brand.id;
  if (resolution.kind === 'all' && resolution.brandIds.length === 1) {
    return resolution.brandIds[0] ?? null;
  }
  return null;
}

/**
 * The path the selector returns to, or the locale's overview.
 *
 * A SELECTOR THAT TAKES A DESTINATION IS A REDIRECT, and an unvalidated one is
 * an open redirect. The rules are deliberately narrower than "is it relative?",
 * because a doubled slash and a slash-backslash are both relative by that test
 * and both leave the site:
 *
 *   - it must begin with `/<locale>/`, so it is a page of THIS application in
 *     the language the reader is already in;
 *   - it must not begin with a doubled slash or a slash-backslash, which
 *     browsers read as a host;
 *   - a control character anywhere is refused, because one in a `Location`
 *     header is a response-splitting attempt whatever it points at;
 *   - anything else falls back to the overview rather than being refused,
 *     because a stale or truncated return path is a broken link, not an attack,
 *     and failing the whole selection over one would be its own defect.
 *
 * The query string is preserved, so returning to `/en/content?status=DRAFT`
 * keeps the filter the reader had. The `brand` parameter is STRIPPED: the
 * selector writes the stored selection, and leaving an old explicit `?brand=`
 * in the URL would out-rank the thing the reader just chose (D-191).
 */
export function safeReturnPath(raw: string | null | undefined, locale: string): string {
  const fallback = `/${locale}/overview`;
  if (typeof raw !== 'string' || raw === '') return fallback;
  if (!raw.startsWith(`/${locale}/`)) return fallback;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback;
  if (hasControlCharacter(raw)) return fallback;

  const mark = raw.indexOf('?');
  if (mark < 0) return raw;
  const params = new URLSearchParams(raw.slice(mark + 1));
  params.delete('brand');
  const rest = params.toString();
  return rest === '' ? raw.slice(0, mark) : `${raw.slice(0, mark)}?${rest}`;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
