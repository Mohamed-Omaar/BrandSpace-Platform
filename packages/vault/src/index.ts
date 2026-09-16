/**
 * The envelope-encryption vault — the seam every encrypted-at-rest value in this
 * platform passes through.
 *
 * TWO CONSUMERS, TWO KEY DOMAINS, ONE IMPLEMENTATION (D-136):
 *
 *   - `@brandspace/secrets` wraps PLATFORM provider credentials under
 *     `PLATFORM_SECRET_DOMAIN`. Its import restriction (F-07) is unchanged: the
 *     customer dashboard and ordinary workers still may not import it.
 *   - `@brandspace/social-connectors` wraps CUSTOMER OAuth tokens under
 *     `SOCIAL_TOKEN_DOMAIN`, in a tenant-owned table behind RLS, so the publish
 *     worker can decrypt a workspace's own token and nothing else.
 *
 * This package holds no table, no service and no policy — only the cipher and
 * the key seam — which is why it is safe for both to depend on.
 */
export * from './crypto';
export * from './key-provider';
