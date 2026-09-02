import { describe, expect, it } from 'vitest';
import {
  LocalDevelopmentKeyProvider,
  buildEncryptionContext,
  createKeyProvider,
  decryptSecret,
  encryptSecret,
  fingerprintValue,
  maskValue,
} from '@brandspace/secrets';

/**
 * Envelope encryption for secret values.
 *
 * These assert the properties docs/SECURITY.md §5 promises: authenticated
 * encryption, ciphertext bound to its context, masked metadata only, and a
 * hard failure when encryption is not configured.
 */

const KEK = 'a'.repeat(48);
const provider = new LocalDevelopmentKeyProvider(KEK);

function context(version = 1) {
  return buildEncryptionContext({
    ref: 'ai/openai/prod/api-key',
    environment: 'PRODUCTION',
    version,
  });
}

describe('round trip', () => {
  it('decrypts to exactly the original value', async () => {
    const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz-0123';
    const material = await encryptSecret(secret, context(), provider);
    expect(await decryptSecret(material, provider)).toBe(secret);
  });

  it('never stores the plaintext anywhere in the material', async () => {
    const secret = 'sk-test-abcdefghijklmnopqrstuvwxyz-0123';
    const material = await encryptSecret(secret, context(), provider);
    const serialized = JSON.stringify(material);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('sk-test-abcdef');
  });

  it('produces different ciphertext for the same value each time', async () => {
    // A fresh data key and IV per encryption, so identical secrets are not
    // correlatable in a database dump.
    const a = await encryptSecret('same-value-here', context(), provider);
    const b = await encryptSecret('same-value-here', context(), provider);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDataKey).not.toBe(b.wrappedDataKey);
  });

  it('refuses to store an empty value', async () => {
    await expect(encryptSecret('', context(), provider)).rejects.toThrow(/empty secret/i);
  });
});

describe('authenticated encryption', () => {
  it('rejects a tampered ciphertext', async () => {
    const material = await encryptSecret('original-secret-value', context(), provider);
    const tampered = {
      ...material,
      ciphertext: Buffer.from('totally-different-bytes').toString('base64'),
    };
    await expect(decryptSecret(tampered, provider)).rejects.toThrow();
  });

  it('rejects a tampered auth tag', async () => {
    const material = await encryptSecret('original-secret-value', context(), provider);
    const tampered = { ...material, authTag: Buffer.alloc(16).toString('base64') };
    await expect(decryptSecret(tampered, provider)).rejects.toThrow();
  });

  it('refuses a ciphertext replayed into a different context', async () => {
    // The context is authenticated, so a row copied from staging to production —
    // or from version 1 to version 2 — fails rather than silently decrypting.
    const material = await encryptSecret('bound-to-its-context', context(1), provider);
    const moved = { ...material, encryptionContext: context(2) };
    await expect(decryptSecret(moved, provider)).rejects.toThrow();
  });

  it('refuses to decrypt with a different key-encryption key', async () => {
    const material = await encryptSecret('value-under-key-a', context(), provider);
    const other = new LocalDevelopmentKeyProvider('b'.repeat(48));
    await expect(decryptSecret(material, other)).rejects.toThrow();
  });
});

describe('masked metadata', () => {
  it('reveals at most the last four characters', () => {
    expect(maskValue('sk-live-abcdefghijklmnop-a91f')).toBe('…a91f');
  });

  it('reveals nothing for a short value', () => {
    // Four of eight characters would be a meaningful fraction of the secret.
    expect(maskValue('short123')).toBe('••••');
  });

  it('produces a stable, non-reversible fingerprint', () => {
    const ctx = context();
    const one = fingerprintValue('the-same-secret', ctx);
    const two = fingerprintValue('the-same-secret', ctx);
    expect(one).toBe(two);
    expect(one).not.toContain('the-same-secret');
    expect(one).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives different fingerprints in different environments', () => {
    // Otherwise an identical fingerprint would reveal that staging and
    // production share a key.
    const prod = fingerprintValue(
      'shared',
      buildEncryptionContext({ ref: 'r', environment: 'PRODUCTION', version: 1 }),
    );
    const staging = fingerprintValue(
      'shared',
      buildEncryptionContext({ ref: 'r', environment: 'STAGING', version: 1 }),
    );
    expect(prod).not.toBe(staging);
  });
});

describe('key provider selection fails closed', () => {
  it('throws when no encryption is configured at all', () => {
    expect(() => createKeyProvider({} as NodeJS.ProcessEnv)).toThrow(
      /Secret encryption is not configured/,
    );
  });

  it('names the variables without printing any value', () => {
    try {
      createKeyProvider({} as NodeJS.ProcessEnv);
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const message = (e as Error).message;
      expect(message).toContain('SECRET_VAULT_KEK');
      expect(message).toContain('SECRET_VAULT_KMS_KEY_ARN');
      expect(message).toContain('never shown');
    }
  });

  it('refuses the local development provider in production', () => {
    expect(() =>
      createKeyProvider({ NODE_ENV: 'production', SECRET_VAULT_KEK: KEK } as NodeJS.ProcessEnv),
    ).toThrow(/must not be used in production/);
  });

  it('rejects a key-encryption key that is too short', () => {
    expect(() => new LocalDevelopmentKeyProvider('too-short')).toThrow(/at least 32 characters/);
  });

  it('selects the KMS provider when a key ARN is configured', () => {
    const kms = createKeyProvider({
      SECRET_VAULT_KMS_KEY_ARN: 'arn:aws:kms:eu-west-1:000000000000:key/abc',
    } as NodeJS.ProcessEnv);
    expect(kms.name).toBe('kms');
  });

  it('the KMS provider throws honestly rather than pretending to work', async () => {
    const kms = createKeyProvider({
      SECRET_VAULT_KMS_KEY_ARN: 'arn:aws:kms:eu-west-1:000000000000:key/abc',
    } as NodeJS.ProcessEnv);
    await expect(kms.wrapDataKey(Buffer.alloc(32), 'ctx')).rejects.toThrow(/not implemented/);
  });
});
