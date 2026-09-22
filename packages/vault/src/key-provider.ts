import { createDecipheriv, createCipheriv, randomBytes, hkdfSync } from 'node:crypto';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { assertNotProduction, currentEnvironment } from '@brandspace/shared';

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
 * `assertNotProduction()` in this constructor, AND the refusal in
 * `createKeyProvider`, both stop it in production — so shipping without a KMS is
 * a startup failure rather than a silent downgrade, whichever way it is reached.
 */
export class LocalDevelopmentKeyProvider implements KeyProvider {
  readonly name = 'local-development';
  readonly #kek: Buffer;
  readonly #keyId: string;

  constructor(masterKey: string, keyId = 'local-v1') {
    /*
     * THE GUARD THIS CLASS ALREADY CLAIMED TO HAVE — Phase 4.
     *
     * The comment above has said since Phase 1 that `assertNotProduction()`
     * refuses to let this run in production, and the call was never here: the
     * refusal lived in `createKeyProvider` alone. That factory is still the
     * first lock and still the better error, because it can name the KMS
     * variable to set. This is the second, for the same reason the doubles got
     * theirs: a `new LocalDevelopmentKeyProvider(...)` anywhere else — a script,
     * a helper, a future caller — met no refusal at all, and the file said it
     * would.
     */
    assertNotProduction(
      'The local development key provider',
      'Set the KMS key ARN for this key domain instead (docs/RAILWAY-DEPLOYMENT.md §25): a key kept beside the data it protects has no hardware protection, no access policy and no independent audit trail.',
    );
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
 * KMS-backed provider — the production key domain, backed by AWS KMS.
 *
 * WHAT CHANGED AND WHY (resolves docs/DECISIONS.md F-09). This class used to
 * throw from both methods on purpose: claiming KMS support that had never
 * called a KMS would have been worse than admitting it was not wired. The
 * consequence was that `NODE_ENV=production` could not seal ANY platform
 * secret — not a provider credential in the Integrations Hub, not a Platform
 * Owner's TOTP seed — because `createKeyProvider` refuses the development
 * provider there and this was the only alternative. A live deployment could
 * therefore run without a usable secret vault at all.
 *
 * THE ENVELOPE STAYS EXACTLY WHERE IT WAS. `encryptSecret`/`decryptSecret` in
 * `crypto.ts` still generate a random 32-byte data key, still encrypt the
 * payload with AES-256-GCM locally, and still ask a provider only to wrap and
 * unwrap that data key. KMS never sees a secret value — only the 32-byte key
 * that protects one. That keeps the request small, the latency bounded and the
 * blast radius of a KMS outage limited to new writes and fresh reads.
 *
 * THE ENCRYPTION CONTEXT IS THE SAME AAD THE LOCAL PROVIDER AUTHENTICATES.
 * AWS KMS binds an `EncryptionContext` into the ciphertext and requires the
 * identical map at decrypt. That is precisely the property the local provider
 * gets from `setAAD`: a wrapped key cannot be moved to another secret, another
 * environment or another version. Using the native mechanism rather than
 * re-implementing it means the guarantee is enforced by KMS itself.
 *
 * `KeyId` IS SENT ON DECRYPT TOO, and that is deliberate. KMS can infer the key
 * from the ciphertext blob, so passing it is optional — but then a blob wrapped
 * under a DIFFERENT key the caller still has access to would decrypt happily.
 * Naming the key forces a mismatch to fail, which is what makes key rotation
 * and environment separation observable rather than silent.
 */
export class KmsKeyProvider implements KeyProvider {
  readonly name = 'aws-kms';
  readonly #keyArn: string;
  readonly #client: KMSClient;

  /**
   * @param keyArn  The CMK to wrap under. An ARN rather than an alias, so the
   *                key a ciphertext was wrapped under is unambiguous even after
   *                an alias is repointed.
   * @param client  Injected in tests. Production passes nothing and gets a
   *                client configured from the standard AWS environment.
   */
  constructor(keyArn: string, client?: KMSClient) {
    if (!keyArn.trim()) {
      throw new Error('SECRET_VAULT_KMS_KEY_ARN is empty. Refusing to start without a key.');
    }
    this.#keyArn = keyArn.trim();
    /*
     * REGION COMES FROM THE ARN WHEN THE ENVIRONMENT DOES NOT SAY. An ARN is
     * `arn:aws:kms:<region>:<account>:key/<id>`, so the region is already
     * present in the one value an operator cannot get wrong without the key
     * being wrong too. `AWS_REGION` still wins when set.
     */
    const region = regionFromArn(this.#keyArn);
    // The key is OMITTED rather than set to undefined when the ARN carries no
    // region, so the SDK falls through to its own resolution chain. Under
    // `exactOptionalPropertyTypes` an explicit undefined is not the same thing.
    this.#client = client ?? new KMSClient(region ? { region } : {});
  }

  currentKeyId(): string {
    return this.#keyArn;
  }

  async wrapDataKey(dataKey: Buffer, context: string): Promise<WrappedKey> {
    const result = await this.#client.send(
      new EncryptCommand({
        KeyId: this.#keyArn,
        Plaintext: dataKey,
        EncryptionContext: { [KMS_CONTEXT_KEY]: context },
      }),
    );
    /* c8 ignore next 3 -- KMS answers with a blob or raises; this is belt and braces. */
    if (!result.CiphertextBlob) {
      throw new Error('AWS KMS returned no ciphertext for the data key.');
    }
    return {
      wrapped: Buffer.from(result.CiphertextBlob).toString('base64'),
      keyProvider: this.name,
      /*
       * THE KEY THAT ACTUALLY WRAPPED IT, as KMS reports it — not the value
       * that was asked for. If an alias was resolved, the record names the
       * concrete key, which is what a later rotation audit needs.
       */
      keyId: result.KeyId ?? this.#keyArn,
    };
  }

  async unwrapDataKey(wrapped: WrappedKey, context: string): Promise<Buffer> {
    const result = await this.#client.send(
      new DecryptCommand({
        KeyId: this.#keyArn,
        CiphertextBlob: Buffer.from(wrapped.wrapped, 'base64'),
        EncryptionContext: { [KMS_CONTEXT_KEY]: context },
      }),
    );
    /* c8 ignore next 3 -- as above. */
    if (!result.Plaintext) {
      throw new Error('AWS KMS returned no plaintext for the wrapped data key.');
    }
    return Buffer.from(result.Plaintext);
  }
}

/**
 * The single encryption-context entry.
 *
 * One well-known key rather than parsing the caller's context string into
 * several: the string is opaque to this layer, and splitting it here would make
 * the AAD's meaning depend on a format that belongs to `crypto.ts`.
 */
const KMS_CONTEXT_KEY = 'brandspace-context';

/**
 * Pull the region out of a KMS key ARN.
 *
 * Returns undefined for anything that is not shaped like one, which lets the
 * SDK fall back to its usual resolution chain (`AWS_REGION`, config file,
 * instance metadata) and produce its own diagnostic rather than this file
 * inventing one.
 */
function regionFromArn(keyArn: string): string | undefined {
  const parts = keyArn.split(':');
  return parts.length >= 4 && parts[0] === 'arn' && parts[3] ? parts[3] : undefined;
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

  /*
   * THE DEPLOYMENT ENVIRONMENT IS `APP_ENV`, NEVER `NODE_ENV` — D-97, and
   * CLAUDE.md §2.2 states it as a rule this file was breaking.
   *
   * This guard used to read `env['NODE_ENV'] === 'production'`. Every built
   * Next.js app sets `NODE_ENV=production`, and so does every Railway service
   * in BOTH environments, because the blueprint's `commonEnv` sets it — a
   * staging deployment is still a production BUILD. The guard therefore fired
   * in staging, where the KEK is exactly the intended key material, and
   * `SecretService` calls `createKeyProvider` eagerly in its constructor. The
   * result: a staging environment built as docs/RAILWAY-DEPLOYMENT.md §22 item 4
   * prescribes could not construct a key provider for any of the three domains,
   * so it could not save an Integrations Hub credential, connect a social
   * account, enrol customer MFA or bootstrap a platform owner.
   *
   * It also over-fired for a developer running `next build && next start`
   * locally, which is the direction D-97 was written about.
   *
   * PRODUCTION IS NOT WEAKENED BY ONE BIT. `currentEnvironment()` returns
   * PRODUCTION exactly when `APP_ENV=production`, and the environment contract
   * independently REQUIRES each permitted domain's KMS ARN in production
   * (`assertKeyDomainBoundaries` in @brandspace/shared), so a production
   * service that reached this line without an ARN would already have been
   * refused at boot. This is the second of two locks, and it still closes.
   */
  if (currentEnvironment(env as Record<string, string | undefined>) === 'PRODUCTION') {
    /*
     * STILL A REFUSAL, AND AN ACTIONABLE ONE. Until F-09 was resolved this was
     * a dead end: the only alternative provider threw from both methods, so a
     * production deployment simply could not seal a secret. The KMS provider is
     * real now, so this says what to configure rather than naming a decision
     * that had not been taken.
     */
    throw new Error(
      'The local development key provider must not be used in production: it keeps the ' +
        'key in the same environment as the data it protects, with no hardware protection, ' +
        `no access policy and no independent audit trail. Set ${domain.kmsVar} to an AWS KMS ` +
        'key ARN instead (docs/RAILWAY-DEPLOYMENT.md §25). (No value is ever shown.)',
    );
  }

  return new LocalDevelopmentKeyProvider(masterKey);
}
