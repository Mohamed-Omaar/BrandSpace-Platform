import { describe, expect, it } from 'vitest';
import {
  EMPTY_TIKTOK_OPTIONS,
  interactionFlags,
  offeredPrivacyLevels,
  readTikTokOptions,
  tiktokOptionsFromForm,
  tiktokOptionsProblems,
} from '@brandspace/social-connectors/tiktok-options';

/**
 * CONNECTORS C — THE TIKTOK POST OPTIONS RULES (D-505 O4), the ones the
 * Studio shows, the save keeps and the adapter enforces: no default audience,
 * interactions off until turned on, disclosure complete, branded content never
 * private, and only what the creator's account offers.
 */

const creator = {
  privacyLevels: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'] as const,
  cannotPostReason: null,
};

describe('stored options', () => {
  it('a new TikTok post starts with nothing chosen and everything off', () => {
    expect(readTikTokOptions(undefined)).toEqual(EMPTY_TIKTOK_OPTIONS);
    expect(EMPTY_TIKTOK_OPTIONS).toEqual({
      privacyLevel: null,
      allowComment: false,
      allowDuet: false,
      allowStitch: false,
      disclosure: { enabled: false, yourBrand: false, brandedContent: false },
    });
  });

  it('anything malformed reads as off or not chosen, never as a guess', () => {
    expect(
      readTikTokOptions({
        privacyLevel: 'EVERYONE',
        allowComment: 'yes',
        allowDuet: 1,
        disclosure: { enabled: 'true' },
      }),
    ).toEqual(EMPTY_TIKTOK_OPTIONS);
  });
});

describe('the rules', () => {
  it('no audience chosen is the first problem', () => {
    expect(tiktokOptionsProblems(EMPTY_TIKTOK_OPTIONS, creator, false)).toEqual([
      'tiktok.privacy_level_missing',
    ]);
  });

  it('an audience the account does not offer is refused', () => {
    expect(
      tiktokOptionsProblems(
        { ...EMPTY_TIKTOK_OPTIONS, privacyLevel: 'FOLLOWER_OF_CREATOR' },
        creator,
        false,
      ),
    ).toEqual(['tiktok.privacy_level_not_offered']);
  });

  it('disclosure on needs at least one of "your brand" and "branded content"', () => {
    const options = {
      ...EMPTY_TIKTOK_OPTIONS,
      privacyLevel: 'PUBLIC_TO_EVERYONE' as const,
      disclosure: { enabled: true, yourBrand: false, brandedContent: false },
    };
    expect(tiktokOptionsProblems(options, creator, false)).toEqual([
      'tiktok.disclosure_incomplete',
    ]);
  });

  it('branded content cannot be "Only me", and cannot go out at all while the app is unaudited', () => {
    const branded = {
      ...EMPTY_TIKTOK_OPTIONS,
      privacyLevel: 'SELF_ONLY' as const,
      disclosure: { enabled: true, yourBrand: false, brandedContent: true },
    };
    expect(tiktokOptionsProblems(branded, creator, false)).toContain(
      'tiktok.branded_content_private',
    );
    expect(tiktokOptionsProblems(branded, creator, true)).toContain(
      'tiktok.branded_content_private',
    );
  });

  it('while unaudited only "Only me" is offered and accepted', () => {
    expect(offeredPrivacyLevels(creator, true)).toEqual(['SELF_ONLY']);
    expect(
      tiktokOptionsProblems(
        { ...EMPTY_TIKTOK_OPTIONS, privacyLevel: 'PUBLIC_TO_EVERYONE' },
        creator,
        true,
      ),
    ).toEqual(['tiktok.privacy_level_not_offered']);
    expect(
      tiktokOptionsProblems({ ...EMPTY_TIKTOK_OPTIONS, privacyLevel: 'SELF_ONLY' }, creator, true),
    ).toEqual([]);
  });

  it('a creator who cannot post now is a problem whatever is chosen', () => {
    expect(
      tiktokOptionsProblems(
        { ...EMPTY_TIKTOK_OPTIONS, privacyLevel: 'SELF_ONLY' },
        { privacyLevels: [], cannotPostReason: 'spam_risk_too_many_posts' },
        false,
      ),
    ).toContain('tiktok.creator_cannot_post');
  });

  it('the audiences are offered in one order, only those the account has', () => {
    expect(
      offeredPrivacyLevels(
        { privacyLevels: ['SELF_ONLY', 'FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS'] },
        false,
      ),
    ).toEqual(['MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
  });
});

describe('interactions sent to TikTok', () => {
  it('disabled unless the author turned it on AND the creator has not turned it off', () => {
    expect(
      interactionFlags(
        { ...EMPTY_TIKTOK_OPTIONS, allowComment: true, allowDuet: true, allowStitch: false },
        { commentDisabled: false, duetDisabled: true, stitchDisabled: false },
      ),
    ).toEqual({ disableComment: false, disableDuet: true, disableStitch: true });
  });
});

describe('the Studio form', () => {
  const form = (fields: Record<string, string>) => ({
    get: (name: string) => fields[name] ?? null,
  });

  it('reads the panel’s fields; disclosure choices only count when disclosure is on', () => {
    expect(
      tiktokOptionsFromForm(
        form({
          tiktokPrivacyLevel: 'MUTUAL_FOLLOW_FRIENDS',
          tiktokAllowComment: 'on',
          tiktokYourBrand: 'on',
        }),
      ),
    ).toEqual({
      privacyLevel: 'MUTUAL_FOLLOW_FRIENDS',
      allowComment: true,
      allowDuet: false,
      allowStitch: false,
      disclosure: { enabled: false, yourBrand: false, brandedContent: false },
    });
  });

  it('an unknown audience is not chosen', () => {
    expect(tiktokOptionsFromForm(form({ tiktokPrivacyLevel: 'EVERYONE' })).privacyLevel).toBeNull();
  });
});
