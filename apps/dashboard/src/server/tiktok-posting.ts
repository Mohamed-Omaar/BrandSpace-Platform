import 'server-only';
import {
  isTikTokPrivacyLevel,
  type CreatorPostingInfo,
  type TikTokPrivacyLevel,
} from '@brandspace/social-connectors/tiktok-options';
import { callSocialApi, inSocial } from './social-context';
import type { TikTokPostingView } from '../app/[locale]/content/compose/tiktok-options-panel';

/**
 * CONNECTORS C — WHAT THE STUDIO'S TIKTOK OPTIONS ARE BUILT FROM (D-505 O4).
 *
 * A TikTok post goes to EVERY TikTok account connected to its brand (the
 * pipeline makes one job per account), so the panel is built from all of
 * them: each account's nickname is shown, the audiences offered are the ones
 * every account allows, and an interaction any account has turned off stays
 * off. Asked fresh each time the Studio renders, as TikTok's guidelines
 * require — through the API, which alone may open a token.
 *
 * Nothing here is a guess: an account TikTok could not be asked about is
 * listed as such, and offers nothing.
 */
export async function tiktokPostingFor(input: {
  readonly workspaceId: string;
  readonly brandId: string;
  readonly brandScope: readonly string[];
}): Promise<TikTokPostingView> {
  const { connections, forcedPrivate } = await inSocial(input.workspaceId, async (services) => {
    const policy = await services.policy();
    const rows = await (await services.connections()).list({ brandScope: input.brandScope });
    return {
      forcedPrivate: policy.providers.tiktok.forcedAudience === 'private',
      connections: rows.filter(
        (row) =>
          row.provider === 'TIKTOK' && row.brandId === input.brandId && row.status === 'ACTIVE',
      ),
    };
  });

  const accounts = await Promise.all(
    connections.map(async (connection) => {
      const answer = await callSocialApi(
        `/v1/social/connections/${encodeURIComponent(connection.id)}/posting-options`,
      );
      const info = answer.ok ? postingInfoFrom(answer.payload) : null;
      return { id: connection.id, name: connection.displayName, info };
    }),
  );

  const known = accounts.flatMap((account) => (account.info ? [account.info] : []));
  const usable = known.filter((info) => info.cannotPostReason === null);
  const privacyLevels: TikTokPrivacyLevel[] =
    usable.length === 0
      ? []
      : usable.reduce<TikTokPrivacyLevel[]>(
          (common, info) => common.filter((level) => info.privacyLevels.includes(level)),
          [...(usable[0]?.privacyLevels ?? [])],
        );
  const durations = usable.flatMap((info) =>
    info.maxVideoSeconds === null ? [] : [info.maxVideoSeconds],
  );

  return {
    forcedPrivate,
    accounts: accounts.map((account) => ({
      id: account.id,
      // The creator's TikTok nickname, as the guidelines ask; the account's
      // stored name only when TikTok gave none.
      name: account.info?.nickname || account.name,
      state:
        account.info === null
          ? 'unavailable'
          : account.info.cannotPostReason !== null
            ? 'cannot_post'
            : 'ready',
    })),
    privacyLevels,
    commentLocked: usable.some((info) => info.commentDisabled),
    duetLocked: usable.some((info) => info.duetDisabled),
    stitchLocked: usable.some((info) => info.stitchDisabled),
    maxVideoSeconds: durations.length === 0 ? null : Math.min(...durations),
  };
}

/** The API's answer, read field by field; anything unexpected is no answer. */
function postingInfoFrom(payload: unknown): CreatorPostingInfo | null {
  if (payload === null || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)['postingOptions'];
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const levels = Array.isArray(record['privacyLevels'])
    ? record['privacyLevels'].filter(isTikTokPrivacyLevel)
    : [];
  const max = record['maxVideoSeconds'];
  const reason = record['cannotPostReason'];
  return {
    nickname: typeof record['nickname'] === 'string' ? record['nickname'] : '',
    username: typeof record['username'] === 'string' ? record['username'] : null,
    avatarUrl: null,
    privacyLevels: levels,
    commentDisabled: record['commentDisabled'] === true,
    duetDisabled: record['duetDisabled'] === true,
    stitchDisabled: record['stitchDisabled'] === true,
    maxVideoSeconds: typeof max === 'number' && max > 0 ? max : null,
    cannotPostReason: typeof reason === 'string' && reason.length > 0 ? reason : null,
  };
}
