/**
 * ROUND 6 (owner decision D-481, item d) — A NEW ENVIRONMENT CANNOT SHIP WITH
 * PUBLISHING UNCONFIGURED UNNOTICED.
 *
 * The `publishing` configuration's defaults declare every channel disabled and
 * text-only. Customers then cannot connect an account, and every post is a
 * plain Post: no Carousel, Reel or Story. Nothing failed, so nothing said so.
 * The Control Center now says it on every page until the operator fixes it.
 *
 * Pure: the console layout reads the active payload and asks this.
 */
export interface PublishingProviderShape {
  readonly enabled: boolean;
  readonly postKinds: readonly string[];
}

export interface PublishingGaps {
  /** No channel may be connected, so nobody can connect an account or publish. */
  readonly noneEnabled: boolean;
  /** No channel declares any kind beyond text and image: every post is a plain Post. */
  readonly textOnly: boolean;
}

const POST_ONLY_KINDS = new Set(['text', 'image']);

export function publishingGaps(
  providers: Readonly<Record<string, PublishingProviderShape | undefined>>,
): PublishingGaps {
  const all = Object.values(providers).filter(
    (provider): provider is PublishingProviderShape => provider !== undefined,
  );
  return {
    noneEnabled: !all.some((provider) => provider.enabled),
    textOnly: !all.some((provider) =>
      provider.postKinds.some((kind) => !POST_ONLY_KINDS.has(kind)),
    ),
  };
}
