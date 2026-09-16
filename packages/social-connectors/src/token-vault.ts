import {
  createKeyProvider,
  decryptSecret,
  encryptSecret,
  SOCIAL_TOKEN_DOMAIN,
  type EncryptedMaterial,
  type KeyProvider,
} from '@brandspace/vault';

/**
 * The customer token vault.
 *
 * WHY THIS IS NOT THE PLATFORM SECRET SERVICE. `secret_record` holds BrandSpace's
 * own provider credentials; it is platform-owned, the tenant role is revoked
 * from it entirely, and F-07 forbids the dashboard and ordinary workers from
 * importing the service that reads it. A customer's OAuth token is the opposite
 * kind of thing: it is tenant data, it belongs behind RLS with the rest of that
 * workspace's rows, and the publish worker — a tenant-facing app — has to be
 * able to decrypt it.
 *
 * SO IT IS A SEPARATE KEY DOMAIN (D-136), not a separate cipher. The envelope,
 * the AEAD, the wrapped data key and the authenticated context are all the same
 * primitives `secret_version` uses, out of `@brandspace/vault`; only the KEK
 * differs. That difference is the point: a worker holding `SOCIAL_TOKEN_VAULT_KEK`
 * and a database connection cannot unwrap a single platform provider credential
 * with it.
 *
 * THE ENCRYPTION CONTEXT BINDS CIPHERTEXT TO ONE ROW. It names the workspace,
 * the connection and the version and is authenticated as AAD, so a credential
 * row copied to another connection — or another WORKSPACE — fails to decrypt
 * rather than quietly returning someone else's token.
 */

/** What actually goes into the encrypted blob. Both halves, or one and a null. */
export interface TokenMaterial {
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

export interface SocialTokenVaultOptions {
  readonly keyProvider?: KeyProvider;
  readonly env?: NodeJS.ProcessEnv;
}

export function socialEncryptionContext(input: {
  workspaceId: string;
  socialConnectionId: string;
  version: number;
}): string {
  return `brandspace:social-token:v1:${input.workspaceId}:${input.socialConnectionId}:${input.version}`;
}

export class SocialTokenVault {
  readonly #keyProvider: KeyProvider;

  constructor(options: SocialTokenVaultOptions = {}) {
    this.#keyProvider =
      options.keyProvider ?? createKeyProvider(options.env ?? process.env, SOCIAL_TOKEN_DOMAIN);
  }

  /**
   * Seal a token pair for one connection version.
   *
   * BOTH TOKENS IN ONE ENVELOPE, as JSON. Two envelopes would mean two things
   * that can get out of step — a rotated access token beside a stale refresh
   * token is a connection that works until it suddenly cannot be refreshed.
   */
  async seal(input: {
    workspaceId: string;
    socialConnectionId: string;
    version: number;
    material: TokenMaterial;
  }): Promise<EncryptedMaterial> {
    const context = socialEncryptionContext(input);
    return encryptSecret(
      JSON.stringify({
        accessToken: input.material.accessToken,
        refreshToken: input.material.refreshToken,
      }),
      context,
      this.#keyProvider,
    );
  }

  /**
   * Open a sealed pair.
   *
   * THE CALLER MUST HAVE READ THE ROW UNDER RLS. This function has no database
   * and cannot check tenancy; what it can do is refuse a ciphertext whose
   * authenticated context does not match the row it was read from, which is why
   * the context is rebuilt from the row rather than taken from it.
   */
  async open(material: EncryptedMaterial): Promise<TokenMaterial> {
    const plaintext = await decryptSecret(material, this.#keyProvider);
    const parsed = JSON.parse(plaintext) as { accessToken?: unknown; refreshToken?: unknown };
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken === '') {
      throw new Error('Stored social credential is malformed.');
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null,
    };
  }

  /**
   * Seal the PKCE verifier for one in-flight authorization.
   *
   * IT IS A SECRET FOR THE LIFETIME OF THE FLOW. An attacker holding the
   * authorization code AND the verifier can complete the exchange without us,
   * which is precisely what PKCE exists to prevent — so it is encrypted at rest
   * like the token it will become, under its own context.
   */
  async sealVerifier(input: {
    workspaceId: string;
    stateHash: string;
    verifier: string;
  }): Promise<EncryptedMaterial> {
    return encryptSecret(
      input.verifier,
      `brandspace:social-pkce:v1:${input.workspaceId}:${input.stateHash}`,
      this.#keyProvider,
    );
  }

  async openVerifier(material: EncryptedMaterial): Promise<string> {
    return decryptSecret(material, this.#keyProvider);
  }
}
