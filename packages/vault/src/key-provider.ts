import { createDecipheriv, createCipheriv, randomBytes, hkdfSync } from 'node:crypto';

/**
 * Key-encryption-key (KEK) provider — the envelope-encryption seam.
 *
 * A caller never touches a KEK directly. It asks a provider to WRAP a freshly
 * generated data key and to UNWRAP it again later. That is the whole interface a
 * cloud KMS needs, so moving to AWS KMS / GCP KMS / Vault is a new
 * implementation of this file and nothing else.
 *
 * docs/SECURITY.md §5: "encrypted at rest with authenticated encryption through
 * a vault abstraction that can later be backed by a cloud KMS."
 *
 * WHY THIS LIVES IN ITS OWN PACKAGE (Phase 6, D-136). It used to sit inside
 * `@brandspace/secrets`, which is correct for the PLATFORM Secret Service and
 * wrong for everything else: F-07 forbids the customer dashboard and ordinary
 * workers from importing that package at all, because it can decrypt platform
 * provider credentials. The publish worker must decrypt a CUSTOMER's OAuth
 * token, which is a different key domain with a different blast radius.
 *
 * So the PRIMITIVES moved here and the platform SERVICE stayed where it was.
 * `@brandspace/secrets` re-exports these unchanged and its import restriction is
 * untouched. Two implementations of envelope encryption would have been the
 * alternative, and a second implementation of a cipher is a second place for it
 * to be wrong.
 */

export interface WrappedKey {
  /** Base64 ciphertext of the data key. */
  readonly wrapped: string;
  /** Which provider wrapped it, so a provider migration is traceable. */
  readonly keyProvider: string;
  /** Which key version wrapped it, so KEK rotation is traceable. */
  readonly keyId: string;
}

export interface KeyProvider {
  readonly name: string;
  /** Identifier of the key currently used for new wraps. */
  currentKeyId(): string;
  wrapDataKey(dataKey: Buffer, context: string): Promise<WrappedKey>;
  unwrapDataKey(wrapped: WrappedKey, context: string): Promise<Buffer>;
}

/** AEAD parameters. AES-256-GCM gives confidentiality AND integrity. */
export const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * Local development key provider.
 *
 * FOR DEVELOPMENT AND TESTING ONLY. It derives the KEK from SECRET_VAULT_KEK via
 * HKDF, which protects secrets at rest in a local database but offers none of
 * the operational guarantees of a real KMS: no hardware protection, no access
 * policy, no independent audit trail, and the key sits in the same environment
 * as the data it protects.
 *
 * `assertNotProduction()` refuses to let it run in production, so shipping
 * without a KMS is a startup failure rather than a silent downgrade.
 */
export class LocalDevelopmentKeyProvider implements KeyProvider {
  readonly name = 'local-development';
  readonly #kek: Buffer;
  readonly #keyId: string;

  constructor(masterKey: string, keyId = 'local-v1') {
    if (masterKey.length < 32) {
      throw new Error(
        'SECRET_VAULT_KEK must be at least 32 characters. ' +
          'Generate one with: openssl rand -base64 48',
      );
    }
    // HKDF separates the storage key from the raw environment value, so the
    // env var is never used directly as a cipher key.
    this.#kek = Buffer.from(
      hkdfSync('sha256', Buffer.from(masterKey, 'utf8'), Buffer.alloc(0), 'brandspace:kek:v1', 32),
    );
    this.#keyId = keyId;
  }

  currentKeyId(): string {
    return this.#keyId;
  }

  async wrapDataKey(dataKey: Buffer, context: string): Promise<WrappedKey> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#kek, iv);
    // The context is authenticated, so a wrapped key cannot be moved to another
    // secret, environment or version.
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      wrapped: Buffer.concat([iv, tag, wrapped]).toString('base64'),
      keyProvider: this.name,
      keyId: this.#keyId,
    };
  }

  async unwrapDataKey(wrapped: WrappedKey, context: string): Promise<Buffer> {
    const raw = Buffer.from(wrapped.wrapped, 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + 16);
    const payload = raw.subarray(IV_BYTES + 16);
    const decipher = createDecipheriv('aes-256-gcm', this.#kek, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  }
}

/**
 * KMS-backed provider — the production shape, deliberately NOT implemented.
 *
 * It exists so the interface is exercised and the integration point is explicit.
 * Throwing here is honest: claiming KMS support that has never called a KMS
 * would be worse than saying it is not wired yet. See docs/DECISIONS.md F-09.
 */
export class KmsKeyProvider implements KeyProvider {
  readonly name = 'kms';
  constructor(private readonly keyArn: string) {}

  currentKeyId(): string {
    return this.keyArn;
  }

  async wrapDataKey(): Promise<WrappedKey> {
    throw new Error(
      'The KMS key provider is not implemented. A cloud KMS has not been selected ' +
        '(docs/DECISIONS.md F-09). Use the local development provider outside production.',
    );
  }

  async unwrapDataKey(): Promise<Buffer> {
    throw new Error('The KMS key provider is not implemented.');
  }
}

/**
 * Which environment variables a key domain reads.
 *
 * A DOMAIN IS A BLAST RADIUS, NOT A NAMESPACE. The platform Secret Service and
 * the customer social-token vault deliberately read DIFFERENT keys, so holding
 * one does not imply the ability to unwrap the other. The publish worker holds
 * the social KEK and has database access; if both domains shared a KEK, that
 * worker could unwrap every platform provider credential in the database — the
 * exact reach F-07 exists to deny it.
 */
export interface KeyDomain {
  /** Environment variable naming a managed KMS key. Preferred in production. */
  readonly kmsVar: string;
  /** Environment variable holding the development KEK. */
  readonly kekVar: string;
  /** Human-readable domain name, used only in error messages. */
  readonly label: string;
}

/** The platform Secret Service: provider credentials, never customer data. */
export const PLATFORM_SECRET_DOMAIN: KeyDomain = {
  kmsVar: 'SECRET_VAULT_KMS_KEY_ARN',
  kekVar: 'SECRET_VAULT_KEK',
  label: 'Secret encryption',
};

/** Phase 6: customer social OAuth tokens, held per workspace under RLS. */
export const SOCIAL_TOKEN_DOMAIN: KeyDomain = {
  kmsVar: 'SOCIAL_TOKEN_VAULT_KMS_KEY_ARN',
  kekVar: 'SOCIAL_TOKEN_VAULT_KEK',
  label: 'Social token encryption',
};

/**
 * Phase 9: a customer's own MFA seed, held on their identity row.
 *
 * A THIRD DOMAIN RATHER THAN A REUSED ONE. The customer application must be able
 * to verify a TOTP code at sign-in, so whatever key seals that seed is reachable
 * from the customer surface. Sealing it with the platform KEK would put every
 * platform provider credential within reach of the login path, and sealing it
 * with the social KEK would do the same for every customer's OAuth token. The
 * blast radius of this key is one thing: authenticator seeds.
 */
export const CUSTOMER_MFA_DOMAIN: KeyDomain = {
  kmsVar: 'CUSTOMER_MFA_VAULT_KMS_KEY_ARN',
  kekVar: 'CUSTOMER_MFA_VAULT_KEK',
  label: 'Customer MFA encryption',
};

/**
 * Build the provider for the current environment and key domain.
 *
 * FAILS CLOSED: with no KEK there is no provider, so the caller refuses to start
 * rather than storing anything unprotected.
 */
export function createKeyProvider(
  env: NodeJS.ProcessEnv = process.env,
  domain: KeyDomain = PLATFORM_SECRET_DOMAIN,
): KeyProvider {
  const kmsKeyArn = env[domain.kmsVar];
  if (kmsKeyArn) return new KmsKeyProvider(kmsKeyArn);

  const masterKey = env[domain.kekVar];
  if (!masterKey || masterKey.trim() === '') {
    throw new Error(
      `${domain.label} is not configured: set ${domain.kekVar} (development) or ` +
        `${domain.kmsVar} (production). Refusing to start rather than ` +
        'handling secrets without encryption. (The value is never shown.)',
    );
  }

  if (env['NODE_ENV'] === 'production') {
    throw new Error(
      'The local development key provider must not be used in production. ' +
        `Configure ${domain.kmsVar} with a managed KMS key (docs/DECISIONS.md F-09).`,
    );
  }

  return new LocalDevelopmentKeyProvider(masterKey);
}
