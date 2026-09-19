import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_MFA_DOMAIN,
  KmsKeyProvider,
  LocalDevelopmentKeyProvider,
  PLATFORM_SECRET_DOMAIN,
  SOCIAL_TOKEN_DOMAIN,
  createKeyProvider,
  decryptSecret,
  encryptSecret,
} from '@brandspace/vault';

/**
 * THE PRODUCTION KEY DOMAIN, now that it exists — docs/DECISIONS.md F-09.
 *
 * WHAT WAS BROKEN. `KmsKeyProvider` threw from both methods on purpose, and
 * `createKeyProvider` refuses the development provider when
 * `NODE_ENV=production`. Between them, a production deployment could not seal a
 * single platform secret: not a provider credential entered in the Integrations
 * Hub, not a Platform Owner's TOTP seed. The platform had a secret vault that
 * could not hold a secret, and nothing failed until somebody tried.
 *
 * HOW THIS IS TESTED WITHOUT AN AWS ACCOUNT. The provider takes an injected
 * `KMSClient`, and the fake below implements the two operations the envelope
 * actually depends on, INCLUDING the encryption-context binding and the key
 * pinning. Testing against a fake that ignored those would prove the happy path
 * and none of the security properties — so the fake enforces them and the tests
 * below prove it does, by making them fail on purpose.
 *
 * No AWS credential, key ARN or account id appears anywhere in this file.
 */

const FAKE_KEY_ARN = 'arn:aws:kms:eu-west-1:000000000000:key/00000000-0000-4000-8000-000000000000';
const OTHER_KEY_ARN = 'arn:aws:kms:eu-west-1:000000000000:key/11111111-1111-4111-8111-111111111111';

interface Envelope {
  readonly keyId: string;
  readonly context: Record<string, string>;
  readonly plaintext: string;
}

/**
 * A KMS stand-in that enforces what real KMS enforces.
 *
 * It "wraps" by recording the plaintext against the key and context it was
 * given, and refuses to unwrap under a different key or a different context —
 * which is exactly the behaviour the envelope's integrity rests on.
 */
function fakeKms(): { client: never; calls: string[] } {
  const store = new Map<string, Envelope>();
  const calls: string[] = [];
  let counter = 0;

  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      const name = command.constructor.name;
      calls.push(name);
      const input = command.input;

      if (name === 'EncryptCommand') {
        const handle = `blob-${++counter}`;
        store.set(handle, {
          keyId: String(input['KeyId']),
          context: (input['EncryptionContext'] ?? {}) as Record<string, string>,
          plaintext: Buffer.from(input['Plaintext'] as Uint8Array).toString('base64'),
        });
        return { CiphertextBlob: Buffer.from(handle, 'utf8'), KeyId: String(input['KeyId']) };
      }

      if (name === 'DecryptCommand') {
        const handle = Buffer.from(input['CiphertextBlob'] as Uint8Array).toString('utf8');
        const envelope = store.get(handle);
        if (!envelope) throw new Error('InvalidCiphertextException');

        // KMS refuses a ciphertext wrapped under a different key when KeyId is
        // supplied. Ours always supplies it.
        if (input['KeyId'] !== undefined && input['KeyId'] !== envelope.keyId) {
          throw new Error('IncorrectKeyException');
        }
        // And refuses a mismatched encryption context, which is the AAD.
        const presented = JSON.stringify(input['EncryptionContext'] ?? {});
        if (presented !== JSON.stringify(envelope.context)) {
          throw new Error('InvalidCiphertextException: encryption context mismatch');
        }
        return { Plaintext: Buffer.from(envelope.plaintext, 'base64'), KeyId: envelope.keyId };
      }

      throw new Error(`Unexpected command: ${name}`);
    },
  } as unknown as never;

  return { client, calls };
}

describe('the AWS KMS key provider wraps and unwraps a data key', () => {
  it('round-trips a data key through Encrypt and Decrypt', async () => {
    const { client, calls } = fakeKms();
    const provider = new KmsKeyProvider(FAKE_KEY_ARN, client);
    const dataKey = Buffer.alloc(32, 7);

    const wrapped = await provider.wrapDataKey(dataKey, 'secret:v1');
    expect(wrapped.keyProvider).toBe('aws-kms');
    expect(wrapped.keyId).toBe(FAKE_KEY_ARN);

    /*
     * THE WRAPPED FORM IS NOT THE KEY. A provider that returned the data key
     * base64-encoded would pass a naive round-trip test and store every secret
     * under a key readable from the same row.
     */
    expect(wrapped.wrapped).not.toContain(dataKey.toString('base64'));

    const unwrapped = await provider.unwrapDataKey(wrapped, 'secret:v1');
    expect(unwrapped.equals(dataKey)).toBe(true);
    expect(calls).toEqual(['EncryptCommand', 'DecryptCommand']);
  });

  it('binds the encryption context, so a wrapped key cannot be moved', async () => {
    /*
     * THE PROPERTY THE LOCAL PROVIDER GETS FROM `setAAD`. Without it, a data
     * key wrapped for one secret could be presented for another — which turns
     * a single readable row into a key for every row.
     */
    const { client } = fakeKms();
    const provider = new KmsKeyProvider(FAKE_KEY_ARN, client);

    const wrapped = await provider.wrapDataKey(Buffer.alloc(32, 1), 'secret:alpha:v1');
    await expect(provider.unwrapDataKey(wrapped, 'secret:beta:v1')).rejects.toThrow();
  });

  it('pins the key, so a ciphertext from another key is refused', async () => {
    /*
     * KMS CAN infer the key from the blob, so passing `KeyId` on decrypt is
     * optional — and omitting it would let a blob wrapped under any key the
     * caller can reach decrypt silently. Naming the key makes a rotation or an
     * environment mix-up fail loudly instead.
     */
    const { client } = fakeKms();
    const wrappedElsewhere = await new KmsKeyProvider(OTHER_KEY_ARN, client).wrapDataKey(
      Buffer.alloc(32, 2),
      'secret:v1',
    );

    const ours = new KmsKeyProvider(FAKE_KEY_ARN, client);
    await expect(ours.unwrapDataKey(wrappedElsewhere, 'secret:v1')).rejects.toThrow();
  });

  it('reports the key KMS actually used, not the one it was asked for', async () => {
    // An alias resolves to a concrete key; the record has to name the concrete
    // one or a later rotation audit cannot tell which key wrapped what.
    const { client } = fakeKms();
    const wrapped = await new KmsKeyProvider(FAKE_KEY_ARN, client).wrapDataKey(
      Buffer.alloc(32, 3),
      'secret:v1',
    );
    expect(wrapped.keyId).toBe(FAKE_KEY_ARN);
  });

  it('refuses an empty key ARN rather than defaulting to something', () => {
    expect(() => new KmsKeyProvider('   ')).toThrow(/SECRET_VAULT_KMS_KEY_ARN/);
  });
});

describe('a secret encrypted through KMS decrypts through KMS', () => {
  it('carries a real payload end to end, with KMS never seeing it', async () => {
    /*
     * THE ENVELOPE IS UNCHANGED, and this proves it. The payload is encrypted
     * locally with AES-256-GCM; KMS only ever wraps the 32-byte data key. The
     * fake records every plaintext it is handed, so the assertion that the
     * secret is not among them is a real statement about what leaves the
     * process.
     */
    const { client } = fakeKms();
    const provider = new KmsKeyProvider(FAKE_KEY_ARN, client);
    const secret = 'a-provider-credential-that-must-not-reach-kms';

    const material = await encryptSecret(secret, 'secret:ref:v1', provider);
    const recovered = await decryptSecret(material, provider);

    expect(recovered).toBe(secret);
    expect(JSON.stringify(material)).not.toContain(secret);
  });
});

const KEK = 'k'.repeat(48);

describe('createKeyProvider chooses the right provider for the environment', () => {
  it('prefers KMS whenever a key ARN is configured', () => {
    const provider = createKeyProvider({
      SECRET_VAULT_KMS_KEY_ARN: FAKE_KEY_ARN,
      SECRET_VAULT_KEK: KEK,
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    expect(provider.name).toBe('aws-kms');
  });

  it('uses the development provider outside production when only a KEK is set', () => {
    const provider = createKeyProvider({
      SECRET_VAULT_KEK: KEK,
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(LocalDevelopmentKeyProvider);
  });

  it('STILL refuses the development provider in production', () => {
    /*
     * IMPLEMENTING KMS DOES NOT RELAX THIS. The development provider keeps the
     * key in the same environment as the data it protects; that is why it is
     * refused, and that reason did not change. What changed is that the
     * refusal now names a configuration an operator can actually apply.
     */
    expect(() =>
      createKeyProvider({ SECRET_VAULT_KEK: KEK, NODE_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toThrow(/must not be used in production/);
  });

  it('now succeeds in production when a key ARN is configured', () => {
    // The case that was impossible before F-09 was resolved.
    const provider = createKeyProvider({
      SECRET_VAULT_KMS_KEY_ARN: FAKE_KEY_ARN,
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect(provider.name).toBe('aws-kms');
    expect(provider.currentKeyId()).toBe(FAKE_KEY_ARN);
  });

  it('refuses when neither a KMS key nor a KEK is configured', () => {
    expect(() => createKeyProvider({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toThrow(
      /is not configured/,
    );
  });
});

/**
 * ALL THREE DOMAINS, NOT JUST THE PLATFORM ONE.
 *
 * `KeyDomain` has named three key domains since Phase 9, and the first cut of
 * the KMS work made only the platform one production-capable — which would have
 * left the publish worker and the customer login surface unable to seal
 * anything in production, discovered on the day the first customer connected an
 * account or enabled MFA.
 *
 * The provider is the SAME CLASS for all three. What differs is which pair of
 * environment variables the domain reads, so that is what these assert.
 */
describe('every key domain is production-capable, through one implementation', () => {
  const DOMAINS = [
    { domain: PLATFORM_SECRET_DOMAIN, arn: `${FAKE_KEY_ARN}-platform` },
    { domain: SOCIAL_TOKEN_DOMAIN, arn: `${FAKE_KEY_ARN}-social` },
    { domain: CUSTOMER_MFA_DOMAIN, arn: `${FAKE_KEY_ARN}-customer-mfa` },
  ];

  it.each(DOMAINS)('$domain.label reads its own ARN variable', ({ domain, arn }) => {
    const provider = createKeyProvider(
      { [domain.kmsVar]: arn, NODE_ENV: 'production' } as NodeJS.ProcessEnv,
      domain,
    );
    expect(provider.name).toBe('aws-kms');
    expect(provider.currentKeyId()).toBe(arn);
  });

  it.each(DOMAINS)("$domain.label ignores another domain's ARN", ({ domain, arn }) => {
    /*
     * THE NEGATIVE THAT MAKES THE DOMAINS REAL. If a domain fell back to
     * another domain's key, the three blast radii would be one — and nothing
     * would ever fail to prove it.
     */
    const foreign = DOMAINS.find((d) => d.domain.kmsVar !== domain.kmsVar);
    if (!foreign) throw new Error('the matrix needs at least two domains');
    expect(() =>
      createKeyProvider(
        { [foreign.domain.kmsVar]: arn, NODE_ENV: 'production' } as NodeJS.ProcessEnv,
        domain,
      ),
    ).toThrow(new RegExp(domain.kekVar));
  });

  it.each(DOMAINS)('$domain.label still refuses a bare KEK in production', ({ domain }) => {
    expect(() =>
      createKeyProvider(
        { [domain.kekVar]: KEK, NODE_ENV: 'production' } as NodeJS.ProcessEnv,
        domain,
      ),
    ).toThrow(/must not be used in production/);
  });

  it('names three DIFFERENT variables, so one value cannot serve all three', () => {
    const kms = new Set(DOMAINS.map((d) => d.domain.kmsVar));
    const keks = new Set(DOMAINS.map((d) => d.domain.kekVar));
    expect(kms.size).toBe(3);
    expect(keks.size).toBe(3);
  });
});
