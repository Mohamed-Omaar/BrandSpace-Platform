/**
 * CONNECTORS C — THE TIKTOK POST OPTIONS (D-505 O4), ONE DEFINITION.
 *
 * What the author chooses for a TikTok post, as stored on the variant
 * (`content_variant.platformOptions`), read by the Studio panel, the save
 * action and the adapter alike. PURE: no Node, no database, so the Studio's
 * client code imports the same rules the server enforces
 * (`@brandspace/social-connectors/tiktok-options`).
 *
 * TIKTOK'S CONTENT SHARING GUIDELINES decide the shape
 * (developers.tiktok.com/docs/en/content-sharing-guidelines):
 *
 *   - THE PRIVACY LEVEL HAS NO DEFAULT. The author picks one of the levels the
 *     creator's account offers right now (`privacy_level_options` from
 *     `creator_info`); nothing is preselected and a post without one is not
 *     sent.
 *   - COMMENT, DUET AND STITCH ARE OFF UNTIL THE AUTHOR TURNS THEM ON. Duet and
 *     Stitch do not exist for photo posts. A setting the creator has turned off
 *     in TikTok cannot be turned on here.
 *   - DISCLOSURE ("this post promotes a brand") is off by default; when on, the
 *     author says whether it is their own brand, a third party's (branded
 *     content), or both — at least one. Branded content cannot be "Only me".
 */

/** TikTok's privacy levels (`privacy_level_options`), in the order the panel lists them. */
export const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
] as const;

export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

export interface TikTokPostOptions {
  /** Null until the author chooses: TikTok requires no default. */
  readonly privacyLevel: TikTokPrivacyLevel | null;
  readonly allowComment: boolean;
  readonly allowDuet: boolean;
  readonly allowStitch: boolean;
  readonly disclosure: {
    readonly enabled: boolean;
    /** Promotes the creator's own business (`brand_organic_toggle`). */
    readonly yourBrand: boolean;
    /** A paid partnership with a third party (`brand_content_toggle`). */
    readonly brandedContent: boolean;
  };
}

/** Everything off and nothing chosen: what a new TikTok variant starts as. */
export const EMPTY_TIKTOK_OPTIONS: TikTokPostOptions = {
  privacyLevel: null,
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  disclosure: { enabled: false, yourBrand: false, brandedContent: false },
};

/**
 * WHAT THE CREATOR'S ACCOUNT ALLOWS RIGHT NOW (TikTok's `creator_info`), in
 * the product's words. Provider-neutral in name because the adapter contract
 * carries it (`postingOptions`), but only TikTok answers it today.
 */
export interface CreatorPostingInfo {
  /** The creator's TikTok nickname: the panel shows it (guidelines). */
  readonly nickname: string;
  readonly username: string | null;
  readonly avatarUrl: string | null;
  /** The privacy levels this account may use now; the panel offers exactly these. */
  readonly privacyLevels: readonly TikTokPrivacyLevel[];
  /** The creator turned these off in TikTok: shown off and locked. */
  readonly commentDisabled: boolean;
  readonly duetDisabled: boolean;
  readonly stitchDisabled: boolean;
  /** The longest video this account may post, in seconds, or null if not said. */
  readonly maxVideoSeconds: number | null;
  /**
   * Null when the creator can post now. Otherwise TikTok's reason (a machine
   * word such as `spam_risk_too_many_posts`): the panel stops and says so.
   */
  readonly cannotPostReason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isTikTokPrivacyLevel(value: unknown): value is TikTokPrivacyLevel {
  return typeof value === 'string' && (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(value);
}

/**
 * Read stored options. Anything missing or malformed reads as its safe value —
 * off, or not chosen — never as a guess: a stored `true` that is not a boolean
 * is not "on".
 */
export function readTikTokOptions(stored: unknown): TikTokPostOptions {
  if (!isRecord(stored)) return EMPTY_TIKTOK_OPTIONS;
  const disclosure = isRecord(stored['disclosure']) ? stored['disclosure'] : {};
  return {
    privacyLevel: isTikTokPrivacyLevel(stored['privacyLevel']) ? stored['privacyLevel'] : null,
    allowComment: stored['allowComment'] === true,
    allowDuet: stored['allowDuet'] === true,
    allowStitch: stored['allowStitch'] === true,
    disclosure: {
      enabled: disclosure['enabled'] === true,
      yourBrand: disclosure['yourBrand'] === true,
      brandedContent: disclosure['brandedContent'] === true,
    },
  };
}

/** Why a set of options cannot be published as it stands. Machine codes. */
export type TikTokOptionsProblem =
  | 'tiktok.privacy_level_missing'
  | 'tiktok.privacy_level_not_offered'
  | 'tiktok.disclosure_incomplete'
  | 'tiktok.branded_content_private'
  | 'tiktok.creator_cannot_post';

/**
 * THE RULES, in one place: the Studio shows the first problem, the save keeps
 * the draft either way (a draft may be unfinished), and the adapter refuses
 * to send a post that has one.
 *
 * `forcedPrivate`: the app is not audited yet (`forcedAudience: 'private'`),
 * so TikTok makes every post "Only me" whatever is chosen; the panel offers
 * only that level and branded content cannot be posted.
 */
export function tiktokOptionsProblems(
  options: TikTokPostOptions,
  creator: Pick<CreatorPostingInfo, 'privacyLevels' | 'cannotPostReason'> | null,
  forcedPrivate: boolean,
): TikTokOptionsProblem[] {
  const problems: TikTokOptionsProblem[] = [];
  if (creator?.cannotPostReason) problems.push('tiktok.creator_cannot_post');
  if (options.privacyLevel === null) {
    problems.push('tiktok.privacy_level_missing');
  } else if (
    (forcedPrivate && options.privacyLevel !== 'SELF_ONLY') ||
    (creator !== null && !creator.privacyLevels.includes(options.privacyLevel))
  ) {
    problems.push('tiktok.privacy_level_not_offered');
  }
  if (
    options.disclosure.enabled &&
    !options.disclosure.yourBrand &&
    !options.disclosure.brandedContent
  ) {
    problems.push('tiktok.disclosure_incomplete');
  }
  if (
    options.disclosure.enabled &&
    options.disclosure.brandedContent &&
    (options.privacyLevel === 'SELF_ONLY' || forcedPrivate)
  ) {
    problems.push('tiktok.branded_content_private');
  }
  return problems;
}

/**
 * The privacy levels the panel offers: the creator's own, in our order, or
 * only "Only me" while the app is unaudited.
 */
export function offeredPrivacyLevels(
  creator: Pick<CreatorPostingInfo, 'privacyLevels'> | null,
  forcedPrivate: boolean,
): TikTokPrivacyLevel[] {
  const available = creator?.privacyLevels ?? [];
  return TIKTOK_PRIVACY_LEVELS.filter(
    (level) => available.includes(level) && (!forcedPrivate || level === 'SELF_ONLY'),
  );
}

/**
 * What TikTok is sent for the interaction settings: a setting is disabled
 * unless the author turned it on AND the creator has not turned it off.
 */
export function interactionFlags(
  options: TikTokPostOptions,
  creator: Pick<CreatorPostingInfo, 'commentDisabled' | 'duetDisabled' | 'stitchDisabled'> | null,
): { disableComment: boolean; disableDuet: boolean; disableStitch: boolean } {
  return {
    disableComment: !options.allowComment || creator?.commentDisabled === true,
    disableDuet: !options.allowDuet || creator?.duetDisabled === true,
    disableStitch: !options.allowStitch || creator?.stitchDisabled === true,
  };
}

/** The form fields the Studio posts, read into stored options (server side). */
export function tiktokOptionsFromForm(form: { get(name: string): unknown }): TikTokPostOptions {
  const on = (name: string) => form.get(name) === 'on' || form.get(name) === 'true';
  const level = form.get('tiktokPrivacyLevel');
  const enabled = on('tiktokDisclose');
  return {
    privacyLevel: isTikTokPrivacyLevel(level) ? level : null,
    allowComment: on('tiktokAllowComment'),
    allowDuet: on('tiktokAllowDuet'),
    allowStitch: on('tiktokAllowStitch'),
    disclosure: {
      enabled,
      yourBrand: enabled && on('tiktokYourBrand'),
      brandedContent: enabled && on('tiktokBrandedContent'),
    },
  };
}
