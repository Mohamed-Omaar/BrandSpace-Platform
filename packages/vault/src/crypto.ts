import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { DATA_KEY_BYTES, type KeyProvider, type WrappedKey } from './key-provider';

/**
 * Envelope encryption for secret values.
 *
 *   plaintext --AES-256-GCM(dataKey)--> ciphertext
 *   dataKey   --KEK (KMS or local)-->   wrappedDataKey
 *
 * A fresh data key per secret version means compromising one version's key
 * yields exactly one secret, and rotating the KEK never requires re-encrypting
 * every secret value — only re-wrapping the data keys.
 */

const IV_BYTES = 12;

export interface EncryptedMaterial {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly wrappedDataKey: string;
  readonly keyProvider: string;
  readonly keyId: string;
  readonly algorithm: 'AES-256-GCM';
  readonly encryptionContext: string;
  readonly maskedHint: string;
  readonly fingerprint: string;
}

/**
 * Bind ciphertext to exactly one secret, environment and version.
 *
 * Authenticated as AAD, so a ciphertext copied to another row fails to decrypt
 * rather than silently returning the wrong provider's key.
 */
export function buildEncryptionContext(input: {
  ref: string;
  environment: string;
  version: number;
}): string {
  return `brandspace:secret:v1:${input.ref}:${input.environment}:${input.version}`;
}

/**
 * Audit-safe hint. Shows at most the last four characters, and nothing at all
 * for a value short enough that four characters would be a meaningful fraction
 * of it (docs/SECURITY.md §5.1 rule 5).
 */
export function maskValue(value: string): string {
  if (value.length < 12) return '••••';
  return `…${value.slice(-4)}`;
}

/**
 * Non-reversible fingerprint, so two secrets can be compared for equality —
 * "is this the same key I already stored?" — without ever decrypting either.
 * Keyed with the encryption context so fingerprints are not comparable across
 * environments, which would leak that staging and production share a key.
 */
export function fingerprintValue(value: string, context: string): string {
  return createHmac('sha256', context).update(value, 'utf8').digest('hex').slice(0, 32);
}

export async function encryptSecret(
  plaintext: string,
  context: string,
  keyProvider: KeyProvider,
): Promise<EncryptedMaterial> {
  if (plaintext === '') {
    throw new Error('Refusing to store an empty secret value.');
  }

  const dataKey = randomBytes(DATA_KEY_BYTES);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const wrapped = await keyProvider.wrapDataKey(dataKey, context);
  // Best-effort scrub. Node cannot guarantee the value never lingered in a
  // buffer, but leaving a key sitting in memory for the process lifetime is
  // strictly worse than clearing it.
  dataKey.fill(0);

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    wrappedDataKey: wrapped.wrapped,
    keyProvider: wrapped.keyProvider,
    keyId: wrapped.keyId,
    algorithm: 'AES-256-GCM',
    encryptionContext: context,
    maskedHint: maskValue(plaintext),
    fingerprint: fingerprintValue(plaintext, context),
  };
}

/**
 * Decrypt a secret value.
 *
 * ONLY called inside the server-side integration boundary, immediately before
 * the value is handed to a provider SDK. The result must never be logged,
 * returned by an API, or written anywhere.
 */
export async function decryptSecret(
  material: {
    ciphertext: string;
    iv: string;
    authTag: string;
    wrappedDataKey: string;
    keyProvider: string;
    keyId: string;
    encryptionContext: string;
  },
  keyProvider: KeyProvider,
): Promise<string> {
  const wrapped: WrappedKey = {
    wrapped: material.wrappedDataKey,
    keyProvider: material.keyProvider,
    keyId: material.keyId,
  };

  const dataKey = await keyProvider.unwrapDataKey(wrapped, material.encryptionContext);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, Buffer.from(material.iv, 'base64'));
    decipher.setAAD(Buffer.from(material.encryptionContext, 'utf8'));
    decipher.setAuthTag(Buffer.from(material.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(material.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } finally {
    dataKey.fill(0);
  }
}
